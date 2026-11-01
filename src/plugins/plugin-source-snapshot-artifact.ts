import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { createFileSync, createRootFileOpenBatchSync } from "@openclaw/fs-safe/advanced";
import { readFileDescriptorBoundedSync } from "../infra/boundary-file-read.js";
import { hasErrnoCode } from "../infra/errno.js";
import { isPathInside } from "../infra/path-guards.js";
import { retireSqliteDatabaseAdmissionForPath } from "../infra/sqlite-database-admission.js";
import { isSqliteLockError } from "../infra/sqlite-error-diagnostics.js";
import { createPrivateSqliteTempDirectorySync } from "../infra/sqlite-private-directory.js";
import {
  acquireSqliteStagingToken,
  SQLITE_STAGING_TOKEN_FILES,
  type SqliteStagingToken,
} from "../infra/sqlite-staging-token.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { PluginGenerationArtifact } from "./plugin-generation-artifact.types.js";
import { retainPluginSourceCaptureRoot } from "./plugin-source-capture-context.js";
import {
  PLUGIN_SOURCE_SNAPSHOT_PREFIX,
  PLUGIN_SOURCE_SNAPSHOT_STAGING_PREFIX,
  resolvePluginSourceCapturesDirectory,
} from "./plugin-source-capture-path.js";
import { hashPluginSourceFile, pluginSourceStatIdentity } from "./plugin-source-file.js";
import {
  capturePluginSnapshotPayload,
  digestPluginSnapshotClosure,
  resolvePluginSnapshotLink,
} from "./plugin-source-snapshot-payload.js";
import type {
  PluginSourceSnapshotBinding,
  PluginSourceSnapshotDescriptor,
} from "./plugin-source-snapshot.types.js";

const PLUGIN_SOURCE_SNAPSHOT_FORMAT = 1;
const MANIFEST = "manifest.json";
const PAYLOAD = "payload";
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
type Entry = { path: string; identity: string } & (
  | { kind: "directory" }
  | { kind: "file"; contentHash: string; sizeBytes: number; mode: number }
  | { kind: "link"; target: string }
);
type Manifest = PluginSourceSnapshotBinding & {
  formatVersion: number;
  generation: string;
  sourceRoot: string;
  root: string;
  aliases: Record<string, string>;
  sourceDigest: string;
  payloadIdentity: string;
  tokenIdentity: string;
  hardlinks: string[];
  platform: string;
  arch: string;
  abi: string;
  entries: Entry[];
};
const readers = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginSourceSnapshotReaders"),
  () => new Map<string, { token: SqliteStagingToken; tokenIdentity: string; references: number }>(),
);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const ownerIdentity = (stat: fs.BigIntStats) =>
  `${stat.dev}:${stat.ino}:${stat.uid}:${stat.gid}:${stat.mode}`;

export class PluginSourceSnapshotValidationError extends Error {
  readonly code = "PLUGIN_SOURCE_SNAPSHOT_INVALID";
  constructor(
    readonly artifactPath: string,
    detail: string,
    options?: ErrorOptions,
  ) {
    super(`Installed plugin source snapshot is invalid at ${artifactPath}: ${detail}`, options);
    this.name = "PluginSourceSnapshotValidationError";
  }
}

function fail(root: string, detail: string): never {
  throw new PluginSourceSnapshotValidationError(root, detail);
}

function tokenIdentity(root: string): string {
  const tokenPath = path.join(root, SQLITE_STAGING_TOKEN_FILES[0]);
  const stat = fs.lstatSync(tokenPath, { bigint: true });
  if (
    !stat.isFile() ||
    stat.nlink !== 1n ||
    (process.getuid && stat.uid !== BigInt(process.getuid())) ||
    (process.platform !== "win32" && (stat.mode & 0o022n) !== 0n)
  ) {
    fail(root, `unsafe token ownership or permissions: ${tokenPath}`);
  }
  return ownerIdentity(stat);
}

function privateEntry(file: string, root: string, kind: "directory" | "file" | "link") {
  const stat = fs.lstatSync(file, { bigint: true });
  if (
    !(kind === "directory"
      ? stat.isDirectory()
      : kind === "file"
        ? stat.isFile()
        : stat.isSymbolicLink()) ||
    (process.getuid && stat.uid !== BigInt(process.getuid())) ||
    (kind !== "link" && process.platform !== "win32" && (stat.mode & 0o077n) !== 0n) ||
    (kind === "file" && stat.nlink !== 1n) ||
    (process.platform === "win32" && (stat.dev === 0n || stat.ino === 0n))
  ) {
    fail(root, `unsafe ${kind} ownership, permissions or identity: ${file}`);
  }
  return stat;
}

function relativeMember(root: string, member: string): string {
  const relative = path.relative(root, member);
  if (!relative || !isPathInside(root, member)) {
    fail(root, `member leaves its payload: ${member}`);
  }
  return relative;
}

function scanPayload(
  root: string,
  opened: ReturnType<typeof createRootFileOpenBatchSync>,
  publishedPayload = root,
): Entry[] {
  const entries: Entry[] = [];
  const visit = (directory: string) => {
    const before = privateEntry(directory, root, "directory");
    for (const name of fs.readdirSync(directory).toSorted()) {
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file, { bigint: true });
      const relative = relativeMember(root, file);
      if (stat.isSymbolicLink()) {
        privateEntry(file, root, "link");
        const target = resolvePluginSnapshotLink(root, file, publishedPayload, (detail) =>
          fail(root, detail),
        );
        if (
          pluginSourceStatIdentity(stat) !==
          pluginSourceStatIdentity(privateEntry(file, root, "link"))
        ) {
          fail(root, `dependency link changed while validating: ${file}`);
        }
        entries.push({
          path: relative,
          kind: "link",
          target: relativeMember(root, target),
          identity: pluginSourceStatIdentity(stat),
        });
      } else if (stat.isDirectory()) {
        privateEntry(file, root, "directory");
        entries.push({
          path: relative,
          kind: "directory",
          identity: pluginSourceStatIdentity(stat),
        });
        visit(file);
      } else {
        privateEntry(file, root, "file");
        const content = hashPluginSourceFile(
          file,
          root,
          undefined,
          undefined,
          opened.openFile.bind(opened),
        );
        const after = privateEntry(file, root, "file");
        if (pluginSourceStatIdentity(stat) !== pluginSourceStatIdentity(after)) {
          fail(root, `file changed while validating: ${file}`);
        }
        entries.push({
          path: relative,
          kind: "file",
          identity: pluginSourceStatIdentity(after),
          ...content,
          mode: Number(after.mode & 0o777n),
        });
      }
    }
    if (
      pluginSourceStatIdentity(before) !==
      pluginSourceStatIdentity(privateEntry(directory, root, "directory"))
    ) {
      fail(root, `directory changed while validating: ${directory}`);
    }
  };
  visit(root);
  return entries;
}

/** Logical closure facts exclude ephemeral capture paths and inode identities. */
export function pluginSourceSnapshotClosureDigest(capture: PluginGenerationArtifact): string {
  return digestPluginSnapshotClosure(capture, (detail) => fail(capture.boundaryRoot, detail));
}

/** Publish completed immutable source before making its descriptor reachable from the index. */
export async function stagePluginSourceSnapshot(params: {
  stateDir: string;
  capture: PluginGenerationArtifact;
  binding: PluginSourceSnapshotBinding;
  assertCurrent: () => void | Promise<void>;
}) {
  await params.assertCurrent();
  if (
    params.binding.contentDigest !== params.capture.sourceDigest ||
    params.binding.dependencyClosureDigest !== pluginSourceSnapshotClosureDigest(params.capture)
  ) {
    fail(
      params.capture.boundaryRoot,
      "captured content or dependency closure does not match the installation record",
    );
  }
  const requestedParent = resolvePluginSourceCapturesDirectory(params.stateDir);
  fs.mkdirSync(requestedParent, { recursive: true, mode: 0o700 });
  const parent = fs.realpathSync.native(requestedParent);
  privateEntry(parent, parent, "directory");
  const generation = randomUUID();
  const stage = createPrivateSqliteTempDirectorySync(parent, PLUGIN_SOURCE_SNAPSHOT_STAGING_PREFIX);
  const root = path.join(parent, `${PLUGIN_SOURCE_SNAPSHOT_PREFIX}${generation}`);
  const stagingIdentity = ownerIdentity(privateEntry(stage, stage, "directory"));
  let published = false;
  let token: SqliteStagingToken | undefined;
  const releaseStage = retainPluginSourceCaptureRoot(stage);
  let settled = false;
  let submitted = false;
  const disposeAsync = async () => {
    if (settled) {
      return;
    }
    settled = true;
    try {
      token?.(true);
      token = undefined;
      const cleanupRoot = published ? root : stage;
      const current = fs.lstatSync(cleanupRoot, { bigint: true, throwIfNoEntry: false });
      if (current && ownerIdentity(current) === stagingIdentity) {
        await fsPromises.rm(cleanupRoot, { recursive: true, force: true });
      }
    } finally {
      releaseStage();
    }
  };
  try {
    token = acquireSqliteStagingToken(stage, "create");
    const expectedTokenIdentity = tokenIdentity(stage);
    const payload = path.join(stage, PAYLOAD);
    const publishedPayload = path.join(root, PAYLOAD);
    capturePluginSnapshotPayload(params.capture, payload, publishedPayload, (detail) =>
      fail(stage, detail),
    );
    using opened = createRootFileOpenBatchSync();
    const entries = scanPayload(payload, opened, publishedPayload);
    const expected = params.capture.sourceSnapshotFacts;
    if (
      !expected ||
      entries.length !== expected.files.size + expected.directories.size + expected.links.size ||
      entries.some((entry) => {
        if (entry.kind === "directory") {
          return !expected.directories.has(entry.path);
        }
        if (entry.kind === "link") {
          return expected.links.get(entry.path) !== entry.target;
        }
        const original = expected.files.get(entry.path);
        return (
          !original ||
          original.contentHash !== entry.contentHash ||
          original.sizeBytes !== entry.sizeBytes ||
          (process.platform !== "win32" && original.mode !== entry.mode)
        );
      })
    ) {
      fail(
        params.capture.boundaryRoot,
        "source changed after its installation receipt was captured",
      );
    }
    const manifest: Manifest = {
      ...params.binding,
      formatVersion: PLUGIN_SOURCE_SNAPSHOT_FORMAT,
      generation,
      sourceRoot: params.capture.sourceRoot,
      root: relativeMember(params.capture.boundaryRoot, params.capture.rootDir),
      aliases: Object.fromEntries(
        Object.entries(params.capture.sourceAliases).map(([source, target]) => [
          source,
          relativeMember(params.capture.boundaryRoot, target),
        ]),
      ),
      sourceDigest: params.capture.sourceDigest,
      payloadIdentity: pluginSourceStatIdentity(privateEntry(payload, stage, "directory")),
      tokenIdentity: expectedTokenIdentity,
      hardlinks: [...expected.hardlinks],
      platform: process.platform,
      arch: process.arch,
      abi: process.versions.modules ?? "",
      entries,
    };
    const bytes = JSON.stringify(manifest);
    {
      using file = createFileSync(path.join(stage, MANIFEST), { mode: 0o600 });
      fs.writeFileSync(file.fd, bytes);
      fs.fsyncSync(file.fd);
    }
    const descriptor = {
      ...params.binding,
      formatVersion: PLUGIN_SOURCE_SNAPSHOT_FORMAT,
      generation,
      platform: manifest.platform,
      arch: manifest.arch,
      abi: manifest.abi,
      artifact: {
        path: stage,
        identity: stagingIdentity,
        manifestIdentity: pluginSourceStatIdentity(
          privateEntry(path.join(stage, MANIFEST), stage, "file"),
        ),
        manifestDigest: digest(bytes),
        tokenIdentity: expectedTokenIdentity,
      },
    };
    await params.assertCurrent();
    assertSnapshotIdentities(descriptor, manifest, publishedPayload);
    return {
      descriptor: { ...descriptor, artifact: { ...descriptor.artifact, path: root } },
      async publish() {
        if (settled || submitted) {
          throw new Error("Plugin source snapshot publication already settled");
        }
        submitted = true;
        try {
          await params.assertCurrent();
          assertSnapshotIdentities(descriptor, manifest, publishedPayload);
          token!();
          token = undefined;
          // Windows cannot rename while admission retains the closed token's descriptor.
          retireSqliteDatabaseAdmissionForPath(path.join(stage, SQLITE_STAGING_TOKEN_FILES[0]));
          fs.renameSync(stage, root);
          descriptor.artifact.path = root;
          published = true;
          await params.assertCurrent();
          assertSnapshotIdentities(descriptor, manifest);
          settled = true;
          releaseStage();
          return descriptor;
        } catch (error) {
          await disposeAsync();
          throw error;
        }
      },
      dispose: () => {
        void disposeAsync().catch(() => {});
      },
      disposeAsync,
    };
  } catch (error) {
    await disposeAsync();
    throw error;
  }
}

function assertArtifactPath(stateDir: string, artifactPath: string) {
  const parent = fs.realpathSync.native(resolvePluginSourceCapturesDirectory(stateDir));
  if (path.basename(artifactPath).startsWith(PLUGIN_SOURCE_SNAPSHOT_STAGING_PREFIX)) {
    fail(artifactPath, "unfinished snapshot staging namespace");
  }
  if (
    path.dirname(artifactPath) !== parent ||
    !path.basename(artifactPath).startsWith(PLUGIN_SOURCE_SNAPSHOT_PREFIX) ||
    fs.realpathSync.native(artifactPath) !== artifactPath
  ) {
    fail(artifactPath, "artifact is outside the private capture owner");
  }
  privateEntry(parent, artifactPath, "directory");
}

function validateSnapshot(stateDir: string, descriptor: PluginSourceSnapshotDescriptor): Manifest {
  const root = descriptor.artifact.path;
  assertArtifactPath(stateDir, root);
  if (
    descriptor.formatVersion !== PLUGIN_SOURCE_SNAPSHOT_FORMAT ||
    descriptor.platform !== process.platform ||
    descriptor.arch !== process.arch ||
    descriptor.abi !== (process.versions.modules ?? "")
  ) {
    fail(root, "capture format or platform/ABI is incompatible");
  }
  if (ownerIdentity(privateEntry(root, root, "directory")) !== descriptor.artifact.identity) {
    fail(root, "artifact root identity changed");
  }
  if (tokenIdentity(root) !== descriptor.artifact.tokenIdentity) {
    fail(root, "snapshot token identity changed");
  }
  const manifestPath = path.join(root, MANIFEST);
  if (
    pluginSourceStatIdentity(privateEntry(manifestPath, root, "file")) !==
    descriptor.artifact.manifestIdentity
  ) {
    fail(root, "manifest identity changed");
  }
  using opened = createRootFileOpenBatchSync();
  const pinned = opened.openFile({
    absolutePath: manifestPath,
    rootPath: root,
    boundaryLabel: "plugin snapshot manifest",
    rejectHardlinks: true,
  });
  if (!pinned.ok) {
    fail(root, "manifest failed guarded open");
  }
  let bytes: string;
  try {
    bytes = readFileDescriptorBoundedSync(pinned.fd, MAX_MANIFEST_BYTES).toString("utf8");
  } finally {
    fs.closeSync(pinned.fd);
  }
  if (digest(bytes) !== descriptor.artifact.manifestDigest) {
    fail(root, "manifest content digest changed");
  }
  // SAFETY: The verified digest and exact inode bind these bytes to our own serialized format.
  const manifest = JSON.parse(bytes) as Manifest;
  for (const key of [
    "formatVersion",
    "generation",
    "installRecordHash",
    "contentDigest",
    "dependencyClosureDigest",
    "buildResolutionDigest",
    "packageIntegrity",
    "platform",
    "arch",
    "abi",
  ] as const) {
    if (manifest[key] !== descriptor[key]) {
      fail(root, `manifest binding changed: ${key}`);
    }
  }
  if (manifest.sourceDigest !== descriptor.contentDigest) {
    fail(root, "manifest source receipt does not match installation content");
  }
  if (manifest.tokenIdentity !== descriptor.artifact.tokenIdentity) {
    fail(root, "manifest token identity does not match installation");
  }
  const payload = path.join(root, PAYLOAD);
  const observed = scanPayload(payload, opened);
  if (JSON.stringify(observed) !== JSON.stringify(manifest.entries)) {
    fail(root, "payload content, identity or membership changed");
  }
  const allowed = new Set<string>([MANIFEST, PAYLOAD, ...SQLITE_STAGING_TOKEN_FILES]);
  if (fs.readdirSync(root).some((name) => !allowed.has(name))) {
    fail(root, "unexpected artifact member");
  }
  for (const name of SQLITE_STAGING_TOKEN_FILES) {
    const tokenPath = path.join(root, name);
    const stat = fs.lstatSync(tokenPath, { bigint: true, throwIfNoEntry: false });
    if (stat && (!stat.isFile() || (process.platform !== "win32" && (stat.mode & 0o022n) !== 0n))) {
      fail(root, `unsafe token permissions or type: ${tokenPath}`);
    }
  }
  if (
    ownerIdentity(privateEntry(root, root, "directory")) !== descriptor.artifact.identity ||
    pluginSourceStatIdentity(privateEntry(manifestPath, root, "file")) !==
      descriptor.artifact.manifestIdentity
  ) {
    fail(root, "artifact changed while validating");
  }
  return manifest;
}

function assertSnapshotIdentities(
  descriptor: Pick<PluginSourceSnapshotDescriptor, "artifact">,
  manifest: Manifest,
  publishedPayload = path.join(descriptor.artifact.path, PAYLOAD),
): void {
  const root = descriptor.artifact.path;
  if (tokenIdentity(root) !== descriptor.artifact.tokenIdentity) {
    fail(root, "snapshot token identity changed after source validation");
  }
  if (
    ownerIdentity(privateEntry(root, root, "directory")) !== descriptor.artifact.identity ||
    pluginSourceStatIdentity(privateEntry(path.join(root, MANIFEST), root, "file")) !==
      descriptor.artifact.manifestIdentity
  ) {
    fail(root, "artifact changed after source validation");
  }
  const payload = path.join(root, PAYLOAD);
  if (
    pluginSourceStatIdentity(privateEntry(payload, root, "directory")) !== manifest.payloadIdentity
  ) {
    fail(root, "payload root changed after source validation");
  }
  for (const entry of manifest.entries) {
    if (
      pluginSourceStatIdentity(privateEntry(path.join(payload, entry.path), root, entry.kind)) !==
      entry.identity
    ) {
      fail(
        root,
        `payload member changed after source validation: ${path.join(payload, entry.path)}`,
      );
    }
    if (entry.kind === "link") {
      const target = resolvePluginSnapshotLink(
        payload,
        path.join(payload, entry.path),
        publishedPayload,
        (detail) => fail(root, detail),
      );
      if (path.relative(payload, target) !== entry.target) {
        fail(root, `dependency link target changed: ${path.join(payload, entry.path)}`);
      }
      if (
        pluginSourceStatIdentity(privateEntry(path.join(payload, entry.path), root, "link")) !==
        entry.identity
      ) {
        fail(root, `dependency link changed while validating: ${path.join(payload, entry.path)}`);
      }
    }
  }
}

/** Reader custody lasts until every runtime instance derived from this source has released it. */
export async function acquirePluginSourceSnapshot(params: {
  stateDir: string;
  descriptor: PluginSourceSnapshotDescriptor;
  assertCurrent: () => void | Promise<void>;
}) {
  const root = params.descriptor.artifact.path;
  await params.assertCurrent();
  let held = readers.get(root);
  let acquired = false;
  let checkingAuthority = false;
  try {
    assertArtifactPath(params.stateDir, root);
    if (!held) {
      const expectedToken = tokenIdentity(root);
      held = {
        token: acquireSqliteStagingToken(root, "read"),
        tokenIdentity: expectedToken,
        references: 0,
      };
      readers.set(root, held);
    }
    held.references++;
    acquired = true;
    const reader = held;
    const assertReader = () => {
      if (tokenIdentity(root) !== reader.tokenIdentity) {
        fail(root, "snapshot reader token identity changed");
      }
    };
    assertReader();
    const manifest = validateSnapshot(params.stateDir, params.descriptor);
    checkingAuthority = true;
    await params.assertCurrent();
    checkingAuthority = false;
    assertReader();
    assertSnapshotIdentities(params.descriptor, manifest);
    let released = false;
    const release = () => {
      if (released) {
        return;
      }
      released = true;
      if (--reader.references === 0) {
        readers.delete(root);
        reader.token();
      }
    };
    const payload = path.join(root, PAYLOAD);
    return {
      rootDir: path.join(payload, manifest.root),
      sourceRoot: manifest.sourceRoot,
      sourceAliases: Object.fromEntries(
        Object.entries(manifest.aliases).map(([source, relative]) => [
          source,
          path.join(payload, relative),
        ]),
      ),
      sourceDigest: manifest.sourceDigest,
      assertCurrent: () => {
        try {
          assertReader();
          assertSnapshotIdentities(params.descriptor, manifest);
        } catch (error) {
          if (error instanceof PluginSourceSnapshotValidationError && error.artifactPath === root) {
            throw error;
          }
          throw new PluginSourceSnapshotValidationError(
            root,
            "snapshot changed after source validation",
            { cause: error },
          );
        }
      },
      sourcePaths: new Set(manifest.entries.map((entry) => path.join(payload, entry.path))),
      sourceHardlinks: new Set(manifest.hardlinks.map((file) => path.join(payload, file))),
      sourceLinks: new Map(
        manifest.entries.flatMap((entry) =>
          entry.kind === "link"
            ? [[path.join(payload, entry.path), path.join(payload, entry.target)] as const]
            : [],
        ),
      ),
      release,
      releaseAsync: async () => release(),
    };
  } catch (error) {
    if (held && acquired && --held.references === 0) {
      readers.delete(root);
      held.token();
    }
    if (
      checkingAuthority ||
      (error instanceof PluginSourceSnapshotValidationError && error.artifactPath === root)
    ) {
      throw error;
    }
    throw new PluginSourceSnapshotValidationError(
      root,
      `snapshot validation failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/** Lifecycle owner supplies authoritative retired descriptors and current index reachability. */
export async function collectPluginSourceSnapshots<
  Snapshot extends
    | PluginSourceSnapshotDescriptor
    | Omit<PluginSourceSnapshotDescriptor, "installedRevision">,
>(params: {
  stateDir: string;
  retainedPaths: ReadonlySet<string>;
  retiredSnapshots: readonly Snapshot[];
  assertCurrent: () => void | Promise<void>;
}) {
  const removed: string[] = [];
  const removedSnapshots: Snapshot[] = [];
  const warnings: string[] = [];
  for (const descriptor of params.retiredSnapshots) {
    const root = descriptor.artifact.path;
    if (params.retainedPaths.has(root) || readers.has(root)) {
      continue;
    }
    let token: SqliteStagingToken | undefined;
    const assertRetiredIdentity = () => {
      assertArtifactPath(params.stateDir, root);
      if (
        ownerIdentity(privateEntry(root, root, "directory")) !== descriptor.artifact.identity ||
        tokenIdentity(root) !== descriptor.artifact.tokenIdentity
      ) {
        fail(root, "retired artifact or token identity changed; refusing collection");
      }
    };
    try {
      await params.assertCurrent();
      assertRetiredIdentity();
      token = acquireSqliteStagingToken(root, "reclaim");
      await params.assertCurrent();
      if (params.retainedPaths.has(root) || readers.has(root)) {
        continue;
      }
      assertRetiredIdentity();
      token(true);
      token = undefined;
      await fsPromises.rm(root, { recursive: true, force: true });
      removed.push(root);
      removedSnapshots.push(descriptor);
    } catch (error) {
      if (hasErrnoCode(error, "ENOENT") && !fs.existsSync(root)) {
        removed.push(root);
        removedSnapshots.push(descriptor);
      } else if (!isSqliteLockError(error)) {
        warnings.push(`Plugin source snapshot cleanup failed at ${root}: ${String(error)}`);
      }
    } finally {
      token?.();
    }
  }
  return { removed, removedSnapshots, warnings };
}
