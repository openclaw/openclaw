import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { hasErrnoCode } from "./errno.js";

const count = z.number().int().nonnegative();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const absolutePath = z.string().refine((value) => path.isAbsolute(value) && !value.includes("://"));
export const databasePortArtifactSchema = z.strictObject({
  path: absolutePath,
  sha256: hash,
  size: count,
});
const location = z.discriminatedUnion("engine", [
  z.strictObject({ engine: z.literal("sqlite"), path: absolutePath }),
  z.strictObject({
    engine: z.literal("postgres"),
    anchorPath: absolutePath,
    namespace: z.string().regex(/^[a-z_][a-z0-9_]*$/),
  }),
]);
const target = z.strictObject({
  storeId: z.uuid(),
  sourceSchemaVersion: count,
  targetSchemaVersion: count,
  descriptorHash: hash,
  original: location,
  intended: location,
  originalCapture: databasePortArtifactSchema,
  verification: z
    .strictObject({
      contentHash: hash,
      catalogHash: hash,
      allocationHash: hash,
      rowCount: count,
      ownerAdmitted: z.literal(true),
    })
    .nullable(),
});
const manifestSchema = z
  .strictObject({
    version: z.literal(1),
    operationId: z.uuid(),
    revision: z.number().int().positive(),
    state: z.enum(["preparing", "publishing", "complete"]),
    outcome: z.enum(["ported", "rolled-back"]).optional(),
    root: z.strictObject({
      stateDir: absolutePath,
      dev: z.string().regex(/^\d+$/),
      ino: z.string().regex(/^\d+$/),
    }),
    direction: z.strictObject({
      from: z.enum(["sqlite", "postgres"]),
      to: z.enum(["sqlite", "postgres"]),
    }),
    originalConfig: z.array(databasePortArtifactSchema).min(1),
    artifacts: z.array(databasePortArtifactSchema),
    targets: z.array(target).min(1),
  })
  .superRefine((value, ctx) => {
    const invalid =
      value.direction.from === value.direction.to ||
      new Set(value.targets.map((entry) => entry.storeId)).size !== value.targets.length ||
      value.targets.some(
        (entry) =>
          entry.original.engine !== value.direction.from ||
          entry.intended.engine !== value.direction.to ||
          (value.state !== "preparing" && value.outcome !== "rolled-back" && !entry.verification),
      ) ||
      (value.state === "complete") !== Boolean(value.outcome);
    if (invalid) {
      ctx.addIssue({ code: "custom", message: "Invalid database port manifest state" });
    }
  });

export type DatabasePortManifest = z.infer<typeof manifestSchema>;
export type DatabasePortRecoveryIntent = {
  manifestPath: string;
  operationId: string;
  action: "resume" | "rollback";
};

/** Port recovery requires durable directories and atomic replacement of existing SQLite files. */
export function assertDatabasePortPlatformSupported(): void {
  if (process.platform === "win32") {
    throw new Error(
      "Native Windows does not support SQLite ↔ PostgreSQL database port yet. Existing data and engine selection stay unchanged. Start with a fresh PostgreSQL setup on Windows, or run the port on Linux or macOS.",
    );
  }
}

export function databasePortManifestPath(stateDir: string): string {
  return path.join(stateDir, "recovery", "database-port", "manifest.json");
}

export class DatabasePortRecoveryError extends Error {}

function refusal(stateDir: string): DatabasePortRecoveryError {
  const manifestPath = databasePortManifestPath(stateDir);
  const quoted = `'${manifestPath.replaceAll("'", "'\\''")}'`;
  return new DatabasePortRecoveryError(
    `Database port recovery required at ${manifestPath}. Run openclaw database port --resume ${quoted} or openclaw database port --rollback ${quoted}.`,
  );
}

function readManifest(stateDir: string): DatabasePortManifest | undefined {
  let raw: string;
  try {
    // One syscall when absent; O_NOFOLLOW also refuses a dangling manifest symlink.
    raw = fs.readFileSync(databasePortManifestPath(stateDir), {
      encoding: "utf8",
      flag: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    });
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return undefined;
    }
    throw refusal(stateDir);
  }
  try {
    return manifestSchema.parse(JSON.parse(raw));
  } catch {
    throw refusal(stateDir);
  }
}

export function assertDatabasePortStartupAllowed(stateDir: string): void {
  const manifest = readManifest(stateDir);
  if (manifest && (manifest.state !== "complete" || manifest.root.stateDir !== stateDir)) {
    throw refusal(stateDir);
  }
}

function assertPrivate(filePath: string, directory: boolean): void {
  const stat = fs.lstatSync(filePath);
  if (
    (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) ||
    (stat.mode & 0o777) !== (directory ? 0o700 : 0o600) ||
    (process.getuid && stat.uid !== process.getuid())
  ) {
    throw new Error(`Database port recovery path must be privately owned: ${filePath}`);
  }
}

function assertRoot(stateDir: string, manifest: DatabasePortManifest): void {
  const stat = fs.lstatSync(stateDir, { bigint: true });
  const identity = { stateDir, dev: String(stat.dev), ino: String(stat.ino) };
  if (!stat.isDirectory() || JSON.stringify(manifest.root) !== JSON.stringify(identity)) {
    throw refusal(stateDir);
  }
}

/** Called only after physical custody has been acquired. */
export function assertDatabasePortRecoveryAllowed(
  stateDir: string,
  intent: DatabasePortRecoveryIntent,
): DatabasePortManifest {
  const fixedPath = databasePortManifestPath(stateDir);
  const manifest = readManifest(stateDir);
  if (
    intent.manifestPath !== fixedPath ||
    !manifest ||
    manifest.operationId !== intent.operationId ||
    (manifest.state === "complete" && intent.action !== "resume") ||
    (intent.action !== "resume" && intent.action !== "rollback")
  ) {
    throw refusal(stateDir);
  }
  assertRoot(stateDir, manifest);
  assertPrivate(path.dirname(path.dirname(fixedPath)), true);
  assertPrivate(path.dirname(fixedPath), true);
  assertPrivate(fixedPath, false);
  return manifest;
}

export function syncDatabasePortPath(pathname: string): void {
  const fd = fs.openSync(pathname, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function ensurePrivateDirectory(directory: string): void {
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
    syncDatabasePortPath(path.dirname(directory));
  } catch (error) {
    if (!hasErrnoCode(error, "EEXIST")) {
      throw error;
    }
  }
  assertPrivate(directory, true);
}

/** Private recovery artifacts and manifest revisions share one durable publication primitive. */
export function writeDatabasePortArtifact(
  filePath: string,
  contents: string | Buffer,
  assertCustody: () => void,
  replace = false,
): void {
  const temporary = path.join(path.dirname(filePath), `.manifest-${randomUUID()}.tmp`);
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    try {
      fs.writeFileSync(fd, contents);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    assertCustody();
    if (replace) {
      fs.renameSync(temporary, filePath);
    } else {
      fs.linkSync(temporary, filePath);
      fs.unlinkSync(temporary);
    }
    syncDatabasePortPath(path.dirname(filePath));
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function prepareDatabasePortDirectory(stateDir: string, operationId: string): string {
  const parent = path.dirname(databasePortManifestPath(stateDir));
  const directory = path.join(parent, z.uuid().parse(operationId));
  for (const entry of [path.dirname(parent), parent, directory]) {
    ensurePrivateDirectory(entry);
  }
  return directory;
}

function writeAtomic(filePath: string, manifest: DatabasePortManifest, assertCustody: () => void) {
  writeDatabasePortArtifact(filePath, `${JSON.stringify(manifest)}\n`, assertCustody, true);
}

/** The caller holds offline custody; every revision is durable before returning. */
export function writeDatabasePortManifest(
  stateDir: string,
  input: DatabasePortManifest,
  assertCustody: () => void,
): void {
  const manifest = manifestSchema.parse(input);
  assertCustody();
  assertRoot(stateDir, manifest);
  const fixedPath = databasePortManifestPath(stateDir);
  ensurePrivateDirectory(path.dirname(path.dirname(fixedPath)));
  ensurePrivateDirectory(path.dirname(fixedPath));
  const previous = readManifest(stateDir);
  if (previous) {
    assertPrivate(fixedPath, false);
    const immutable = (value: DatabasePortManifest) =>
      JSON.stringify({
        operationId: value.operationId,
        root: value.root,
        direction: value.direction,
        originalConfig: value.originalConfig,
        targets: value.targets.map(({ verification: _verification, ...entry }) => entry),
      });
    const states = ["preparing", "publishing", "complete"];
    if (
      immutable(previous) !== immutable(manifest) ||
      manifest.revision !== previous.revision + 1 ||
      previous.state === "complete" ||
      states.indexOf(manifest.state) < states.indexOf(previous.state) ||
      (states.indexOf(manifest.state) > states.indexOf(previous.state) + 1 &&
        !(previous.state === "preparing" && manifest.outcome === "rolled-back")) ||
      previous.artifacts.some(
        (artifact) =>
          !manifest.artifacts.some((next) => JSON.stringify(next) === JSON.stringify(artifact)),
      )
    ) {
      throw refusal(stateDir);
    }
  } else if (manifest.state !== "preparing" || manifest.revision !== 1) {
    throw refusal(stateDir);
  }
  writeAtomic(fixedPath, manifest, assertCustody);
}

export function archiveDatabasePortManifest(
  stateDir: string,
  operationId: string,
  assertCustody: () => void,
): string {
  assertCustody();
  const manifest = readManifest(stateDir);
  if (!manifest || manifest.state !== "complete" || manifest.operationId !== operationId) {
    throw refusal(stateDir);
  }
  assertRoot(stateDir, manifest);
  const fixedPath = databasePortManifestPath(stateDir);
  assertPrivate(path.dirname(path.dirname(fixedPath)), true);
  assertPrivate(path.dirname(fixedPath), true);
  assertPrivate(fixedPath, false);
  const directory = path.join(path.dirname(fixedPath), operationId);
  ensurePrivateDirectory(directory);
  const archived = path.join(directory, "manifest.json");
  writeAtomic(archived, manifest, assertCustody);
  assertCustody();
  fs.unlinkSync(fixedPath);
  syncDatabasePortPath(path.dirname(fixedPath));
  return archived;
}
