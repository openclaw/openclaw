import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Updater, type Fetcher } from "tuf-js";
import { z } from "zod";
import { resolvePathViaExistingAncestorSync } from "../boundary-path.js";
import { acquireFileLock, type FileLockHandle } from "../file-lock.js";
import type { UpdateRunWriteOptions } from "../update-run-write.async.js";
import {
  retainedUpgradeRecipeRunSchema,
  type RetainedUpgradeRecipeRun,
} from "./recovery-contract.js";
import { createRetainedUpgradeRecipeRunStore } from "./retained-run.js";
import { upgradeRecipeCatalogSchema, type UpgradeRecipeCatalog } from "./schema.js";

const MAX_CATALOG_BYTES = 8 * 1024 * 1024;
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const recipeRef = z.strictObject({ id: z.string().min(1), revision: z.number().int().positive() });
const envelopeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  catalog: upgradeRecipeCatalogSchema,
  revokedRecipes: z.array(recipeRef).max(10000),
  revokedArtifactIds: z.array(z.string().min(1)).max(10000),
});
const metadataSchema = z.object({
  signed: z.object({ version: z.number().int().positive(), expires: z.iso.datetime() }),
});
const admitted = new WeakSet<object>();
const recoveredAdmissions = new WeakMap<
  object,
  {
    binding: RetainedUpgradeRecipeRun["binding"];
    assertCurrent: () => void;
    assertKnownCurrent: () => void;
  }
>();
const admissionContexts = new WeakMap<object, string>();
const admissionDirectories = new WeakMap<object, string>();
const latestAdmissions = new Map<string, AuthenticatedUpgradeRecipeCatalog>();

class UpgradeRecipeTrustError extends Error {
  constructor(
    readonly code: "metadata-untrusted" | "metadata-expired" | "recipe-revoked",
    message: string,
  ) {
    super(message);
    this.name = "UpgradeRecipeTrustError";
  }
}

/** Serializable evidence, not transferable execution authority or a substitute for reauthentication. */
type UpgradeRecipeCatalogAdmission = {
  readonly [K in keyof z.infer<typeof retainedAdmissionSchema>]: Readonly<
    z.infer<typeof retainedAdmissionSchema>[K]
  >;
};
export type AuthenticatedUpgradeRecipeCatalog = {
  readonly catalog: UpgradeRecipeCatalog;
  readonly digest: string;
  readonly admission: UpgradeRecipeCatalogAdmission;
  readonly revokedRecipes: readonly { readonly id: string; readonly revision: number }[];
  readonly revokedArtifactIds: readonly string[];
};
export type AuthenticateUpgradeRecipeCatalogOptions = {
  /** Provisioned by the installation/release owner, never fetched on first use. */
  controlRoot: string;
  metadataDir: string;
  metadataBaseUrl: string;
  targetBaseUrl: string;
  targetPath: string;
  /** Include every agent workspace and installation being replaced. */
  forbiddenRoots: readonly string[];
  /** A transport only: TUF still validates signatures, versions, expiry and target bytes. */
  fetcher?: Fetcher;
};

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}
async function privatePath(file: string, directory: boolean): Promise<void> {
  const stat = await fs.lstat(file);
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  ) {
    throw new UpgradeRecipeTrustError(
      "metadata-untrusted",
      "Update trust material must be private and owned by the invoking installation owner.",
    );
  }
  if ((await fs.realpath(file)) !== file) {
    throw new UpgradeRecipeTrustError(
      "metadata-untrusted",
      "Update trust material must use canonical paths without symlinks.",
    );
  }
}
async function readBounded(file: string, limit: number): Promise<Buffer> {
  await privatePath(file, false);
  const stat = await fs.stat(file);
  if (stat.size > limit) {
    throw new UpgradeRecipeTrustError(
      "metadata-untrusted",
      "Update metadata exceeds its byte limit.",
    );
  }
  const bytes = await fs.readFile(file);
  if (bytes.length > limit) {
    throw new UpgradeRecipeTrustError(
      "metadata-untrusted",
      "Update metadata exceeds its byte limit.",
    );
  }
  return bytes;
}
function deepFreeze(value: unknown): void {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
}

/** New admissions always refresh authenticated metadata; expired cached data cannot start a new run. */
export async function authenticateUpgradeRecipeCatalog(
  options: AuthenticateUpgradeRecipeCatalogOptions,
): Promise<AuthenticatedUpgradeRecipeCatalog> {
  let refreshLock: FileLockHandle | undefined;
  try {
    const controlRoot = path.resolve(options.controlRoot);
    const metadataDir = path.resolve(options.metadataDir);
    if (
      options.forbiddenRoots.length === 0 ||
      !inside(controlRoot, metadataDir) ||
      options.forbiddenRoots.some((root) =>
        inside(resolvePathViaExistingAncestorSync(path.resolve(root)), controlRoot),
      )
    ) {
      throw new UpgradeRecipeTrustError(
        "metadata-untrusted",
        "Update trust storage must be outside workspaces and replaced installations.",
      );
    }
    await privatePath(controlRoot, true);
    await privatePath(metadataDir, true);
    // The cache, not an ancestor selected by a caller, identifies the conflict set.
    refreshLock = await acquireFileLock(`${metadataDir}.refresh`, {
      retries: { retries: 0, factor: 1, minTimeout: 0, maxTimeout: 0 },
      stale: 30_000,
      staleRecovery: "fail-closed",
    });
    // Validate intermediate directories too: a private leaf cannot protect a writable parent.
    for (
      let parent = path.dirname(metadataDir);
      parent !== path.dirname(controlRoot) && parent !== controlRoot;
      parent = path.dirname(parent)
    ) {
      await privatePath(parent, true);
    }
    for (const entry of await fs.readdir(metadataDir)) {
      if (!/^(root|timestamp|snapshot|targets)\.json$/.test(entry)) {
        throw new UpgradeRecipeTrustError(
          "metadata-untrusted",
          "Unexpected files in the dedicated update metadata cache.",
        );
      }
      await readBounded(path.join(metadataDir, entry), MAX_METADATA_BYTES);
    }
    const rootBytes = await readBounded(path.join(metadataDir, "root.json"), MAX_METADATA_BYTES);
    metadataSchema.parse(JSON.parse(rootBytes.toString("utf8")));
    for (const base of [options.metadataBaseUrl, options.targetBaseUrl]) {
      const url = new URL(base);
      if (url.protocol !== "https:" || url.username || url.password) {
        throw new UpgradeRecipeTrustError(
          "metadata-untrusted",
          "Update metadata requires an authenticated HTTPS distribution endpoint.",
        );
      }
    }
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,255}$/.test(options.targetPath) ||
      options.targetPath.split("/").some((part) => part === "." || part === ".." || part === "")
    ) {
      throw new UpgradeRecipeTrustError("metadata-untrusted", "Invalid catalog target identity.");
    }
    const targetDir = path.join(controlRoot, "targets");
    await fs.mkdir(targetDir, { mode: 0o700, recursive: true });
    await privatePath(targetDir, true);
    const updater = new Updater({
      metadataDir,
      metadataBaseUrl: options.metadataBaseUrl,
      targetDir,
      targetBaseUrl: options.targetBaseUrl,
      fetcher: options.fetcher,
      config: {
        rootMaxLength: MAX_METADATA_BYTES,
        timestampMaxLength: MAX_METADATA_BYTES,
        snapshotMaxLength: MAX_METADATA_BYTES,
        targetsMaxLength: MAX_METADATA_BYTES,
        fetchTimeout: 30000,
        fetchRetries: 0,
      },
    });
    await updater.refresh();
    // Catalogs intentionally use the top-level targets role, not unbounded delegated policy.
    const targetsBytes = await fs.readFile(path.join(metadataDir, "targets.json"));
    const targets = z
      .object({ signed: z.object({ targets: z.record(z.string(), z.unknown()) }) })
      .parse(JSON.parse(targetsBytes.toString("utf8")));
    if (!(options.targetPath in targets.signed.targets)) {
      throw new UpgradeRecipeTrustError(
        "metadata-untrusted",
        "The trusted targets role does not authorize this catalog.",
      );
    }
    const target = await updater.getTargetInfo(options.targetPath);
    if (
      !target ||
      target.length > MAX_CATALOG_BYTES ||
      !/^[a-f0-9]{64}$/.test(target.hashes.sha256 ?? "")
    ) {
      throw new UpgradeRecipeTrustError(
        "metadata-untrusted",
        "Catalog target lacks a bounded SHA256 identity.",
      );
    }
    const destination = path.join(targetDir, `${target.hashes.sha256}.json`);
    try {
      await privatePath(destination, false);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
    await updater.downloadTarget(target, destination);
    // tuf-js writes files using the process umask. Protect before any subsequent reads.
    for (const role of ["root", "timestamp", "snapshot", "targets"] as const) {
      await fs.chmod(path.join(metadataDir, `${role}.json`), 0o600);
    }
    await fs.chmod(destination, 0o600);
    const bytes = await readBounded(destination, MAX_CATALOG_BYTES);
    if (bytes.length !== target.length || sha256(bytes) !== target.hashes.sha256) {
      throw new UpgradeRecipeTrustError(
        "metadata-untrusted",
        "Catalog artifact changed after TUF verification.",
      );
    }
    const envelope = envelopeSchema.parse(JSON.parse(bytes.toString("utf8")));
    const roles = await Promise.all(
      (["root", "timestamp", "snapshot", "targets"] as const).map(async (role) => {
        const data = await readBounded(path.join(metadataDir, `${role}.json`), MAX_METADATA_BYTES);
        const signed = metadataSchema.parse(JSON.parse(data.toString("utf8"))).signed;
        return { role, bytes: data, version: signed.version, expires: signed.expires };
      }),
    );
    const root = roles.find((entry) => entry.role === "root");
    if (!root) {
      throw new UpgradeRecipeTrustError(
        "metadata-untrusted",
        "Trusted root evidence is unavailable.",
      );
    }
    const versionOf = (role: typeof root.role) => {
      const metadata = roles.find((entry) => entry.role === role);
      if (!metadata) {
        throw new UpgradeRecipeTrustError(
          "metadata-untrusted",
          "Metadata role evidence is unavailable.",
        );
      }
      return metadata.version;
    };
    const digestOf = (role: typeof root.role) => {
      const metadata = roles.find((entry) => entry.role === role);
      if (!metadata) {
        throw new UpgradeRecipeTrustError(
          "metadata-untrusted",
          "Metadata role evidence is unavailable.",
        );
      }
      return sha256(metadata.bytes);
    };
    const result: AuthenticatedUpgradeRecipeCatalog = {
      catalog: envelope.catalog,
      digest: sha256(bytes),
      revokedRecipes: envelope.revokedRecipes,
      revokedArtifactIds: envelope.revokedArtifactIds,
      admission: {
        targetPath: options.targetPath,
        sha256: sha256(bytes),
        length: bytes.length,
        rootSha256: sha256(root.bytes),
        metadataVersions: {
          root: versionOf("root"),
          timestamp: versionOf("timestamp"),
          snapshot: versionOf("snapshot"),
          targets: versionOf("targets"),
        },
        metadataDigests: {
          root: digestOf("root"),
          timestamp: digestOf("timestamp"),
          snapshot: digestOf("snapshot"),
          targets: digestOf("targets"),
        },
        expiresAt: new Date(
          Math.min(...roles.map((entry) => Date.parse(entry.expires))),
        ).toISOString(),
      },
    };
    deepFreeze(result);
    admitted.add(result);
    const context = `${metadataDir}\0${options.targetPath}`;
    admissionContexts.set(result, context);
    admissionDirectories.set(result, metadataDir);
    latestAdmissions.set(context, result);
    assertUpgradeRecipeCatalogCurrent(result);
    return result;
  } catch (error) {
    if (error instanceof UpgradeRecipeTrustError) {
      throw error;
    }
    const expired = error instanceof Error && error.constructor.name === "ExpiredMetadataError";
    throw new UpgradeRecipeTrustError(
      expired ? "metadata-expired" : "metadata-untrusted",
      expired
        ? "Update metadata has expired; refresh from the trusted distribution owner."
        : "Update metadata authentication failed; preserve the current installation and trust cache.",
    );
  } finally {
    await refreshLock?.release();
  }
}

function assertAuthenticatedUpgradeRecipeCatalog(
  value: unknown,
): asserts value is AuthenticatedUpgradeRecipeCatalog {
  if (value === null || typeof value !== "object" || !admitted.has(value)) {
    throw new UpgradeRecipeTrustError(
      "metadata-untrusted",
      "Execution requires a catalog admitted by the authentication owner.",
    );
  }
}
/** Both fresh and original-run admissions pin the exact four-role cache generation. */
function assertMetadataGeneration(
  directory: string,
  admission: UpgradeRecipeCatalogAdmission,
): void {
  if (realpathSync(directory) !== directory) {
    throw new Error("Metadata storage identity changed.");
  }
  for (const role of ["root", "timestamp", "snapshot", "targets"] as const) {
    const filename = path.join(directory, `${role}.json`);
    const stat = lstatSync(filename);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > MAX_METADATA_BYTES ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid()) ||
      sha256(readFileSync(filename)) !== admission.metadataDigests[role]
    ) {
      throw new Error("Metadata generation changed.");
    }
  }
}

/** Fresh-run guard only. Recovery authority stays with the original durable run owner. */
export function assertUpgradeRecipeCatalogCurrent(
  value: AuthenticatedUpgradeRecipeCatalog,
  options: {
    recipe?: { id: string; revision: number };
    artifactIds?: readonly string[];
    now?: number;
  } = {},
): void {
  assertAuthenticatedUpgradeRecipeCatalog(value);
  const recovered = recoveredAdmissions.get(value);
  if (recovered) {
    recovered.assertCurrent();
    recovered.assertKnownCurrent();
  } else {
    const metadataDirectory = admissionDirectories.get(value);
    try {
      if (!metadataDirectory) {
        throw new Error("Metadata storage identity changed.");
      }
      assertMetadataGeneration(metadataDirectory, value.admission);
    } catch {
      throw new UpgradeRecipeTrustError(
        "metadata-untrusted",
        "Retained trust metadata changed in another invocation; reauthenticate and replan.",
      );
    }
    const context = admissionContexts.get(value);
    if (!context || latestAdmissions.get(context)?.digest !== value.digest) {
      throw new UpgradeRecipeTrustError(
        "metadata-untrusted",
        "New authenticated metadata supersedes this admission; replan before execution.",
      );
    }
    if (Date.parse(value.admission.expiresAt) <= (options.now ?? Date.now())) {
      throw new UpgradeRecipeTrustError(
        "metadata-expired",
        "A new upgrade requires current authenticated metadata.",
      );
    }
  }
  if (
    (options.recipe &&
      value.revokedRecipes.some(
        (entry) => entry.id === options.recipe?.id && entry.revision === options.recipe?.revision,
      )) ||
    options.artifactIds?.some((id) => value.revokedArtifactIds.includes(id))
  ) {
    throw new UpgradeRecipeTrustError(
      "recipe-revoked",
      "The trusted catalog revoked an execution recipe or artifact.",
    );
  }
}

const retainedAdmissionSchema = z.strictObject({
  targetPath: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  length: z.number().int().positive(),
  rootSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  metadataVersions: z.strictObject({
    root: z.number().int().positive(),
    timestamp: z.number().int().positive(),
    snapshot: z.number().int().positive(),
    targets: z.number().int().positive(),
  }),
  metadataDigests: z.strictObject({
    root: z.string(),
    timestamp: z.string(),
    snapshot: z.string(),
    targets: z.string(),
  }),
  expiresAt: z.iso.datetime(),
});
const retainedAuthenticatedCatalogSchema = z.strictObject({
  catalog: upgradeRecipeCatalogSchema,
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
  admission: retainedAdmissionSchema,
  revokedRecipes: z.array(recipeRef).max(10000),
  revokedArtifactIds: z.array(z.string()).max(10000),
});

/** Restore only an original durable admission; parsed JSON or an expired fresh cache never authorizes a new run. */
export async function recoverOriginalUpgradeRecipeCatalog(
  selected: RetainedUpgradeRecipeRun,
  authorizationBytes: Uint8Array,
  options: UpdateRunWriteOptions & {
    assertCurrent: () => void;
    catalog: AuthenticateUpgradeRecipeCatalogOptions;
  },
): Promise<AuthenticatedUpgradeRecipeCatalog> {
  const retained = retainedUpgradeRecipeRunSchema.parse(selected);
  const assertCurrent = options.assertCurrent;
  assertCurrent();
  const store = createRetainedUpgradeRecipeRunStore({
    ...options,
    path: retained.ledgerAuthority.databasePath,
  });
  const original = await store.read(retained.binding.runId);
  assertCurrent();
  if (
    !original ||
    original.status !== "running" ||
    !isDeepStrictEqual(original.pointer.ledgerAuthority, retained.ledgerAuthority) ||
    !isDeepStrictEqual(original.pointer.nativeAuthority, retained.nativeAuthority)
  ) {
    throw new UpgradeRecipeTrustError(
      "metadata-untrusted",
      "Original retained admission lost its exact running ledger owner.",
    );
  }
  const bytes = await store.readRetainedEnvelope(retained.binding.runId);
  if (
    !isDeepStrictEqual(
      retainedUpgradeRecipeRunSchema.parse(JSON.parse(bytes.toString("utf8"))),
      retained,
    )
  ) {
    throw new UpgradeRecipeTrustError(
      "metadata-untrusted",
      "Retained authorization selects different original evidence.",
    );
  }
  const recorded = await store.readArtifact(retained.authorizationArtifact);
  assertCurrent();
  if (!Buffer.from(authorizationBytes).equals(recorded)) {
    throw new UpgradeRecipeTrustError(
      "metadata-untrusted",
      "Authorization bytes differ from original durable custody.",
    );
  }
  const originalCatalog = retainedAuthenticatedCatalogSchema.parse(
    JSON.parse(recorded.toString("utf8")),
  );
  if (
    originalCatalog.digest !== originalCatalog.admission.sha256 ||
    originalCatalog.admission.targetPath !== options.catalog.targetPath
  ) {
    throw new UpgradeRecipeTrustError(
      "metadata-untrusted",
      "Original admission target identity changed.",
    );
  }
  const planBytes = await store.readArtifact(retained.planArtifact);
  const originalPlan = z
    .object({
      maintenance: z.object({ binding: z.unknown() }),
      catalogDigest: z.string(),
      catalog: z.record(z.string(), z.unknown()),
    })
    .parse(JSON.parse(planBytes.toString("utf8")));
  if (
    !isDeepStrictEqual(originalPlan.maintenance.binding, retained.binding) ||
    originalPlan.catalogDigest !== originalCatalog.digest
  ) {
    throw new UpgradeRecipeTrustError(
      "metadata-untrusted",
      "Original plan differs from recovered admission.",
    );
  }
  for (const key of [
    "controlRoot",
    "metadataDir",
    "metadataBaseUrl",
    "targetBaseUrl",
    "targetPath",
    "forbiddenRoots",
  ] as const) {
    if (!isDeepStrictEqual(originalPlan.catalog[key], options.catalog[key])) {
      throw new UpgradeRecipeTrustError(
        "metadata-untrusted",
        "Recovery cannot substitute original trust selectors.",
      );
    }
  }
  const metadataDirectory = path.resolve(options.catalog.metadataDir);
  await privatePath(path.resolve(options.catalog.controlRoot), true);
  await privatePath(metadataDirectory, true);
  const knownOriginal = () => {
    try {
      assertMetadataGeneration(metadataDirectory, originalCatalog.admission);
    } catch {
      throw new UpgradeRecipeTrustError(
        "metadata-untrusted",
        "Known metadata generation changed; current authenticated revocations are required.",
      );
    }
  };
  let latest: AuthenticatedUpgradeRecipeCatalog | undefined;
  try {
    knownOriginal();
  } catch {
    latest = await authenticateUpgradeRecipeCatalog(options.catalog);
  }
  assertCurrent();
  const value: AuthenticatedUpgradeRecipeCatalog = {
    ...originalCatalog,
    revokedRecipes: [...originalCatalog.revokedRecipes, ...(latest?.revokedRecipes ?? [])],
    revokedArtifactIds: [
      ...new Set([...originalCatalog.revokedArtifactIds, ...(latest?.revokedArtifactIds ?? [])]),
    ],
  };
  deepFreeze(value);
  admitted.add(value);
  recoveredAdmissions.set(value, {
    binding: structuredClone(retained.binding),
    assertCurrent,
    assertKnownCurrent: latest ? () => assertUpgradeRecipeCatalogCurrent(latest!) : knownOriginal,
  });
  assertUpgradeRecipeCatalogCurrent(value);
  return value;
}

/** Bind catalog recovery to one original recipe object, never a fresh apply admission. */
export function assertRecoveredUpgradeRecipeCatalogBinding(
  value: AuthenticatedUpgradeRecipeCatalog,
  binding: RetainedUpgradeRecipeRun["binding"],
): void {
  const recovered = recoveredAdmissions.get(value);
  if (!recovered || !isDeepStrictEqual(recovered.binding, binding)) {
    throw new UpgradeRecipeTrustError(
      "metadata-untrusted",
      "Recovered catalog cannot select another run or plan.",
    );
  }
  assertUpgradeRecipeCatalogCurrent(value);
}
