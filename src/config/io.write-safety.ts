import fs from "node:fs";
import path from "node:path";
import { replaceFileAtomicSync } from "@openclaw/fs-safe/atomic";
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { resolvePathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { isMissingPathError } from "../infra/errors.js";
import { isPathInside } from "../security/scan-paths.js";
import { isRecord } from "../utils.js";
import { hashConfigIncludeRaw } from "./includes.js";
import { stampConfigWriteMetadata } from "./io.meta.js";
import { hashConfigRaw, parseConfigJson5 } from "./io.read-helpers.js";
import type { NormalizedConfigIoDeps } from "./io.read.types.js";
import type { ConfigWriteOptions } from "./io.types.js";
import { ConfigMutationConflictError } from "./mutation-conflict.js";
import { resolveStateDir } from "./paths.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "./types.js";
import { createConfigWriteAuthorityGuard } from "./write-authority.js";
import { captureConfigWriteLockGuard } from "./write-lock.js";

/** Pin path lookups without pinning the regular file this write will replace. */
export function captureConfigFileWritePathProof(
  filePath: string,
  targetPath: string,
  ioFs: typeof fs,
) {
  const facts = new Map<
    string,
    { kind: "missing-directory" } | { kind: "existing"; dev: bigint; ino: bigint; link?: string }
  >();
  const visited = new Set<string>();
  const conflict = () =>
    new ConfigMutationConflictError("included config target changed since last load", {
      retryable: false,
    });
  const remember = (entry: string, stat: fs.BigIntStats | undefined, link?: string) => {
    if (!facts.has(entry)) {
      facts.set(
        entry,
        stat
          ? { kind: "existing", dev: stat.dev, ino: stat.ino, link }
          : { kind: "missing-directory" },
      );
    }
  };
  const capture = (entry: string): void => {
    if (visited.has(entry)) {
      return;
    }
    visited.add(entry);
    const parent = path.dirname(entry);
    if (parent === entry) {
      return;
    }
    capture(parent);
    let realParent: string;
    try {
      realParent = ioFs.realpathSync(parent);
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
      realParent = resolvePathViaExistingAncestorSync(parent);
    }
    remember(realParent, ioFs.lstatSync(realParent, { bigint: true, throwIfNoEntry: false }));
    const lookup = path.join(realParent, path.basename(entry));
    const stat = ioFs.lstatSync(lookup, { bigint: true, throwIfNoEntry: false });
    if (!stat) {
      if (!isPathInside(lookup, targetPath)) {
        throw conflict();
      }
      return;
    }
    if (stat.isSymbolicLink()) {
      const link = ioFs.readlinkSync(lookup);
      remember(lookup, stat, link);
      capture(path.isAbsolute(link) ? link : `${realParent}${path.sep}${link}`);
    }
  };
  if (path.normalize(resolvePathViaExistingAncestorSync(filePath)) !== targetPath) {
    throw conflict();
  }
  capture(filePath);
  capture(targetPath);
  const assertCurrent = () => {
    for (const [entry, expected] of facts) {
      const stat = ioFs.lstatSync(entry, { bigint: true, throwIfNoEntry: false });
      if (expected.kind === "missing-directory") {
        if (stat && !stat.isDirectory()) {
          throw conflict();
        }
        continue;
      }
      if (
        !stat ||
        stat.dev !== expected.dev ||
        stat.ino !== expected.ino ||
        (expected.link === undefined
          ? !stat.isDirectory()
          : !stat.isSymbolicLink() || ioFs.readlinkSync(entry) !== expected.link)
      ) {
        throw conflict();
      }
    }
    if (ioFs.lstatSync(targetPath, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw conflict();
    }
  };
  assertCurrent();
  return { path: filePath, assertCurrent };
}

/** Pin the root directory while choosing a physical publication target. */
export function captureConfigRootWriteTarget(filePath: string, ioFs: typeof fs) {
  const directory = path.dirname(filePath);
  const original = ioFs.lstatSync(directory, { bigint: true, throwIfNoEntry: false });
  if (!original?.isSymbolicLink()) {
    const assertCurrent = () => {
      const current = ioFs.lstatSync(directory, { bigint: true, throwIfNoEntry: false });
      if (
        original
          ? !current ||
            !current.isDirectory() ||
            current.dev !== original.dev ||
            current.ino !== original.ino
          : current && !current.isDirectory()
      ) {
        throw new ConfigMutationConflictError("config directory changed since last load", {
          retryable: false,
        });
      }
    };
    assertCurrent();
    return { path: filePath, pathProof: { path: filePath, assertCurrent } };
  }
  // Resolve only the immediate parent; following the leaf could redirect publication.
  const targetPath = path.join(ioFs.realpathSync(directory), path.basename(filePath));
  return {
    path: targetPath,
    pathProof: captureConfigFileWritePathProof(filePath, targetPath, ioFs),
  };
}

type ConfigFileWriteIdentity = Pick<fs.BigIntStats, "dev" | "ino">;

export type ConfigFileWriteRollbackProof = {
  assertCurrent: () => void;
  publicationIdentity: ConfigFileWriteIdentity | null;
};

type ConfigPermissionHardeningParams = {
  deps: Pick<NormalizedConfigIoDeps, "fs"> & { logger: Pick<typeof console, "warn"> };
  configPath: string;
  context: string;
};

function formatConfigPermissionHardeningWarning(params: {
  configPath: string;
  context: string;
  error: unknown;
}): string {
  const detail = params.error instanceof Error ? params.error.message : String(params.error);
  return `Config permission hardening failed (${params.context}): ${params.configPath}: ${detail}`;
}

export async function chmodConfigBestEffort(
  params: ConfigPermissionHardeningParams,
): Promise<void> {
  try {
    await params.deps.fs.promises.chmod?.(params.configPath, 0o600);
  } catch (error) {
    params.deps.logger.warn(formatConfigPermissionHardeningWarning({ ...params, error }));
  }
}

export function chmodConfigBestEffortSync(params: ConfigPermissionHardeningParams): void {
  try {
    params.deps.fs.chmodSync?.(params.configPath, 0o600);
  } catch (error) {
    params.deps.logger.warn(formatConfigPermissionHardeningWarning({ ...params, error }));
  }
}

/** Fence new effects; descriptor-bound completion and private cleanup retain their own identity. */
export function createGuardedConfigFileSystem(
  configPath: string,
  fsModule: typeof fs,
  assertCurrent?: () => void,
  publication?: {
    publicationIdentity?: ConfigFileWriteIdentity | null;
    snapshot: Pick<ConfigFileSnapshot, "path" | "exists" | "raw" | "readError">;
    includeGraph: { hashes: Record<string, string>; targets: Record<string, string> };
    onRootRemoved?: () => void;
    onRootPublished?: () => void;
    preserveDirectoryMode?: boolean;
    targetPathProof?: ReturnType<typeof captureConfigFileWritePathProof>;
  },
) {
  const includePathProofs = new Map(
    Object.entries(publication?.includeGraph.targets ?? {}).map(([includePath, target]) => [
      includePath,
      publication?.targetPathProof?.path === includePath
        ? publication.targetPathProof
        : captureConfigFileWritePathProof(includePath, target, fsModule),
    ]),
  );
  let expectedPublication = publication;
  const authority = createConfigWriteAuthorityGuard(assertCurrent);
  const check = (assertion: () => void) => {
    // A path/hash refusal is as terminal as a lease refusal, even if its next read succeeds.
    try {
      current();
      assertion();
    } catch (error) {
      refusal ??= { error };
      throw refusal.error;
    }
  };
  let refusal: { error: unknown } | undefined;
  const current = () => {
    if (refusal) {
      throw refusal.error;
    }
    authority();
  };
  const assertPublication = () =>
    check(() => {
      assertTargetIdentity(publishedIdentity);
      if (expectedPublication) {
        assertBaseSnapshotStillCurrent(
          expectedPublication.snapshot,
          configPath,
          fsModule,
          expectedPublication.includeGraph,
          includePathProofs,
        );
      }
    });
  type Opened = { path: string; stat: fs.BigIntStats; writable: boolean; private: boolean };
  const descriptors = new Map<number, Opened>();
  const privatePaths = new Map<string, Opened>();
  let publishedIdentity = publication?.publicationIdentity;
  const same = (a: ConfigFileWriteIdentity, b: ConfigFileWriteIdentity) =>
    a.dev === b.dev && a.ino === b.ino;
  const assertTargetIdentity = (identity: ConfigFileWriteIdentity | null | undefined) => {
    if (identity === undefined) {
      return;
    }
    const entry = fsModule.lstatSync(configPath, { bigint: true, throwIfNoEntry: false });
    if (
      identity === null
        ? entry !== undefined
        : !entry || !same(entry, identity) || !entry.isFile() || entry.nlink !== 1n
    ) {
      throw new ConfigMutationConflictError("config publication identity changed", {
        retryable: false,
      });
    }
  };
  const assertIdentity = (opened: Opened, fd?: number) => {
    const entry = fsModule.lstatSync(opened.path, { bigint: true });
    const held = fd === undefined ? opened.stat : fsModule.fstatSync(fd, { bigint: true });
    if (
      !same(entry, opened.stat) ||
      !same(held, opened.stat) ||
      entry.isSymbolicLink() ||
      (entry.isFile() && (entry.nlink !== 1n || held.nlink !== 1n))
    ) {
      throw new ConfigMutationConflictError("config write descriptor target changed", {
        retryable: false,
      });
    }
  };
  const assertDescriptorWrite = (fd: number) =>
    check(() => {
      const opened = descriptors.get(fd);
      if (!opened?.writable) {
        throw new ConfigMutationConflictError("config write descriptor has no captured owner", {
          retryable: false,
        });
      }
      if (opened.path !== configPath) {
        assertPublication();
      } else {
        // Exclusive open already changed the destination. Keep other inputs pinned,
        // but compare this destination's identity rather than its old content hash.
        publication?.targetPathProof?.assertCurrent();
        for (const proof of includePathProofs.values()) {
          proof.assertCurrent();
        }
        if (publication) {
          assertBaseSnapshotStillCurrent(
            { ...publication.snapshot, raw: null, exists: true },
            configPath,
            fsModule,
            publication.includeGraph,
            includePathProofs,
          );
        }
      }
      assertIdentity(opened, fd);
    });
  const assertPublishedIdentity = () => {
    publication?.targetPathProof?.assertCurrent();
    assertTargetIdentity(publishedIdentity);
  };
  const captureRollbackProof = (assertOwner: () => void): ConfigFileWriteRollbackProof => {
    const assertRollbackOwner = () => {
      assertOwner();
      publication?.targetPathProof?.assertCurrent();
    };
    assertRollbackOwner();
    assertPublishedIdentity();
    if (publishedIdentity === undefined) {
      throw new ConfigMutationConflictError("config write has no publication to roll back", {
        retryable: false,
      });
    }
    // Copy the publication fact. The recovery adapter, not this old publisher,
    // owns its later remove/create transitions. The original owner stays live.
    return { assertCurrent: assertRollbackOwner, publicationIdentity: publishedIdentity };
  };
  const fileSystem: typeof fs = {
    ...fsModule,
    mkdirSync: new Proxy(fsModule.mkdirSync, {
      apply(target, thisArg, args) {
        assertPublication();
        return Reflect.apply(target, thisArg, args);
      },
    }),
    openSync: (filePath, flags, mode) => {
      const writable =
        typeof flags === "number"
          ? (flags &
              (fs.constants.O_WRONLY |
                fs.constants.O_RDWR |
                fs.constants.O_CREAT |
                fs.constants.O_TRUNC)) !==
            0
          : /[wa+]/.test(flags);
      if (writable) {
        assertPublication();
      }
      const fd = fsModule.openSync(filePath, flags, mode);
      try {
        const pathname = String(filePath);
        const exclusive =
          typeof flags === "number" ? (flags & fs.constants.O_EXCL) !== 0 : flags.includes("x");
        const opened = {
          path: pathname,
          stat: fsModule.fstatSync(fd, { bigint: true }),
          writable,
          private: writable && exclusive && pathname !== configPath,
        };
        descriptors.set(fd, opened);
        if (opened.private) {
          privatePaths.set(pathname, opened);
        }
        if (writable && pathname === configPath) {
          publishedIdentity = opened.stat;
          publication?.onRootRemoved?.();
        }
        return fd;
      } catch (error) {
        try {
          fsModule.closeSync(fd);
        } catch (closeError) {
          throw new AggregateError(
            [error, closeError],
            "Config descriptor adoption and close failed",
            { cause: closeError },
          );
        }
        throw error;
      }
    },
    writeFileSync: new Proxy(fsModule.writeFileSync, {
      apply(target, thisArg, args) {
        if (typeof args[0] === "number") {
          assertDescriptorWrite(args[0]);
        } else {
          assertPublication();
        }
        return Reflect.apply(target, thisArg, args);
      },
    }),
    ftruncateSync: (fd, length) => {
      assertDescriptorWrite(fd);
      return fsModule.ftruncateSync(fd, length);
    },
    writeSync: new Proxy(fsModule.writeSync, {
      apply(target, thisArg, args) {
        assertDescriptorWrite(args[0]);
        return Reflect.apply(target, thisArg, args);
      },
    }),
    fchmodSync: (fd, mode) => {
      const opened = descriptors.get(fd);
      if (publication?.preserveDirectoryMode && fsModule.fstatSync(fd).isDirectory()) {
        return;
      }
      if (opened?.writable) {
        // Final mode is completion of the owned dispatch, not permission to publish again.
        assertIdentity(opened, fd);
      } else {
        assertPublication();
        if (opened) {
          assertIdentity(opened, fd);
        }
      }
      return fsModule.fchmodSync(fd, mode);
    },
    fsyncSync: (fd) => {
      const opened = descriptors.get(fd);
      if (opened) {
        assertIdentity(opened, fd);
      }
      return fsModule.fsyncSync(fd);
    },
    closeSync: (fd) => {
      try {
        return fsModule.closeSync(fd);
      } finally {
        descriptors.delete(fd);
      }
    },
    renameSync: (source, destination) => {
      assertPublication();
      const owned =
        privatePaths.get(String(source)) ??
        [...descriptors.values()].find((entry) => entry.path === String(source));
      if (owned) {
        assertIdentity(owned);
      }
      fsModule.renameSync(source, destination);
      privatePaths.delete(String(source));
      if (owned) {
        owned.path = String(destination);
      }
      if (destination === configPath) {
        publishedIdentity = owned?.stat ?? fsModule.lstatSync(configPath, { bigint: true });
        expectedPublication = undefined;
        publication?.onRootPublished?.();
      }
    },
    unlinkSync: (filePath) => {
      const owned = privatePaths.get(String(filePath));
      if (owned) {
        // The atomic owner also checks this identity; never apply caller revocation to
        // removal of its private stage, and never remove a replacement at that name.
        assertIdentity(owned);
      } else {
        assertPublication();
        const opened = [...descriptors.values()].find((entry) => entry.path === String(filePath));
        if (opened) {
          assertIdentity(opened);
        }
      }
      fsModule.unlinkSync(filePath);
      privatePaths.delete(String(filePath));
    },
    rmSync: (filePath, options) => {
      assertPublication();
      fsModule.rmSync(filePath, options);
      if (filePath === configPath && expectedPublication) {
        publishedIdentity = null;
        expectedPublication.onRootRemoved?.();
        expectedPublication = {
          ...expectedPublication,
          snapshot: { ...expectedPublication.snapshot, exists: false, raw: null },
        };
      }
    },
  };
  return { fileSystem, assertCurrent: current, assertPublishedIdentity, captureRollbackProof };
}

export function assertBaseSnapshotStillCurrent(
  snapshot: Pick<ConfigFileSnapshot, "path" | "exists" | "raw" | "readError">,
  configPath: string,
  ioFs: typeof fs,
  includeGraph?: { hashes: Record<string, string>; targets: Record<string, string> },
  includePathProofs?: ReadonlyMap<string, ReturnType<typeof captureConfigFileWritePathProof>>,
): void {
  if (snapshot.path !== configPath) {
    throw new ConfigMutationConflictError("config path changed since last load", {
      retryable: false,
    });
  }
  for (const [includePath, expectedHash] of Object.entries(includeGraph?.hashes ?? {})) {
    try {
      const expectedTarget = includeGraph?.targets[includePath];
      if (!expectedTarget) {
        throw new ConfigMutationConflictError("included config target changed since last load", {
          retryable: false,
        });
      }
      const pathProof = includePathProofs?.get(includePath);
      pathProof?.assertCurrent();
      if (!pathProof && path.normalize(ioFs.realpathSync(includePath)) !== expectedTarget) {
        throw new ConfigMutationConflictError("included config target changed since last load", {
          retryable: false,
        });
      }
      // Aliases of the file being published share its owned-removal expectation below.
      if (expectedTarget === configPath) {
        continue;
      }
      if (hashConfigIncludeRaw(ioFs.readFileSync(expectedTarget, "utf-8")) !== expectedHash) {
        throw new ConfigMutationConflictError("included config changed since last load");
      }
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
      throw new ConfigMutationConflictError("included config disappeared since last load");
    }
  }
  // Unreadable snapshots cannot be re-read; destructive guards reject them later.
  if (snapshot.readError) {
    return;
  }
  const expectedHash = snapshot.raw === null ? null : hashConfigRaw(snapshot.raw);
  let currentRaw: string | null = null;
  let currentExists = true;
  try {
    currentRaw = ioFs.readFileSync(configPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw error;
    }
    currentExists = false;
  }
  const currentHash = currentExists ? hashConfigRaw(currentRaw) : null;
  if (
    currentExists !== snapshot.exists ||
    (currentExists && expectedHash !== null && currentHash !== expectedHash)
  ) {
    throw new ConfigMutationConflictError("config changed since last load");
  }
}

export async function tightenStateDirPermissionsIfNeeded(params: {
  configPath: string;
  env: NodeJS.ProcessEnv;
  homedir: () => string;
  fsModule: typeof fs;
  assertConfigPathForWrite?: () => void;
}): Promise<void> {
  const assertCurrent = captureConfigWriteLockGuard(params.configPath);
  if (process.platform === "win32") {
    return;
  }
  const stateDir = resolveStateDir(params.env, params.homedir);
  const configDir = path.dirname(params.configPath);
  if (path.resolve(configDir) !== path.resolve(stateDir)) {
    return;
  }
  try {
    const stat = await params.fsModule.promises.stat(configDir);
    if ((stat.mode & 0o077) !== 0) {
      assertCurrent?.();
      params.assertConfigPathForWrite?.();
      await params.fsModule.promises.chmod(configDir, 0o700);
    }
  } catch {
    assertCurrent?.();
    params.assertConfigPathForWrite?.();
    // Best-effort hardening only; the config write must still proceed.
  }
}

export async function rollbackConfigFileWriteIfUnchanged(params: {
  configPath: string;
  previousSnapshot: Pick<ConfigFileSnapshot, "path" | "exists" | "raw" | "readError">;
  committedHash: string;
  preserveDirectoryMode?: boolean;
  durable?: boolean;
  destinationHardlinks?: "reject";
  fsModule: typeof fs;
  assertCurrent?: () => void;
  publicationIdentity?: ConfigFileWriteIdentity | null;
}): Promise<boolean> {
  // Restore the original target, even when another config path is now selected.
  // The captured owner and committed hash, not current selection, authorize compensation.
  const assertCurrent = params.assertCurrent;
  assertCurrent?.();
  let currentRaw: string | null = null;
  try {
    currentRaw = await params.fsModule.promises.readFile(params.configPath, "utf-8");
  } catch (error) {
    assertCurrent?.();
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw error;
    }
  }
  assertCurrent?.();
  if (hashConfigRaw(currentRaw) !== params.committedHash) {
    return false;
  }
  if (params.previousSnapshot.exists && typeof params.previousSnapshot.raw === "string") {
    replaceFileAtomicSync({
      filePath: params.configPath,
      content: params.previousSnapshot.raw,
      dirMode: 0o700,
      mode: 0o600,
      copyFallbackOnPermissionError: true,
      syncTempFile: params.durable,
      syncParentDir: params.durable,
      destinationHardlinks: params.destinationHardlinks,
      throwOnCleanupError: true,
      fileSystem: createGuardedConfigFileSystem(params.configPath, params.fsModule, assertCurrent, {
        publicationIdentity: params.publicationIdentity,
        snapshot: { ...params.previousSnapshot, exists: currentRaw !== null, raw: currentRaw },
        includeGraph: { hashes: {}, targets: {} },
        preserveDirectoryMode: params.preserveDirectoryMode,
      }).fileSystem,
    });
    return true;
  }
  if (params.previousSnapshot.exists) {
    return false;
  }
  createGuardedConfigFileSystem(params.configPath, params.fsModule, assertCurrent, {
    publicationIdentity: params.publicationIdentity,
    snapshot: { ...params.previousSnapshot, exists: currentRaw !== null, raw: currentRaw },
    includeGraph: { hashes: {}, targets: {} },
  }).fileSystem.rmSync(params.configPath, { force: true });
  return true;
}

function normalizeStatNumber(value: number | null | undefined): number | null {
  return asFiniteNumber(value) ?? null;
}

function normalizeStatId(value: number | bigint | null | undefined): string | null {
  if (typeof value === "bigint") {
    return value.toString();
  }
  return typeof value === "number" && Number.isFinite(value) ? String(value) : null;
}

export function resolveConfigStatMetadata(stat: fs.Stats | null): {
  dev: string | null;
  ino: string | null;
  mode: number | null;
  nlink: number | null;
  uid: number | null;
  gid: number | null;
} {
  return {
    dev: normalizeStatId(stat?.dev ?? null),
    ino: normalizeStatId(stat?.ino ?? null),
    mode: normalizeStatNumber(stat ? stat.mode & 0o777 : null),
    nlink: normalizeStatNumber(stat?.nlink ?? null),
    uid: normalizeStatNumber(stat?.uid ?? null),
    gid: normalizeStatNumber(stat?.gid ?? null),
  };
}

export function resolveConfigWriteSuspiciousReasons(params: {
  existsBefore: boolean;
  unreadableBefore: boolean;
  sizeBaselineBytes: number | null;
  nextBytes: number | null;
  hasMetaBefore: boolean;
  gatewayModeBefore: string | null;
  gatewayModeAfter: string | null;
}): string[] {
  const reasons: string[] = [];
  if (!params.existsBefore) {
    return reasons;
  }
  if (params.unreadableBefore) {
    reasons.push("unreadable-config-before-write");
  }
  if (
    typeof params.sizeBaselineBytes === "number" &&
    typeof params.nextBytes === "number" &&
    params.sizeBaselineBytes >= 512 &&
    params.nextBytes < Math.floor(params.sizeBaselineBytes * 0.5)
  ) {
    reasons.push(`size-drop:${params.sizeBaselineBytes}->${params.nextBytes}`);
  }
  if (!params.hasMetaBefore) {
    reasons.push("missing-meta-before-write");
  }
  if (params.gatewayModeBefore && !params.gatewayModeAfter) {
    reasons.push("gateway-mode-removed");
  }
  return reasons;
}

export function resolveConfigWriteBlockingReasons(
  suspicious: string[],
  options: Pick<ConfigWriteOptions, "allowConfigSizeDrop"> = {},
): string[] {
  return suspicious.filter(
    (reason) =>
      reason === "unreadable-config-before-write" ||
      (reason.startsWith("size-drop:") && options.allowConfigSizeDrop !== true) ||
      reason === "gateway-mode-removed",
  );
}

export function formatConfigArtifactTimestamp(ts: string): string {
  return ts.replaceAll(":", "-").replaceAll(".", "-");
}

export function resolveConfigSizeBaselineBytes(params: {
  raw: string | null;
  json5: { parse: (value: string) => unknown };
  lastTouchedVersionOverride?: string;
}): number | null {
  if (params.raw === null) {
    return null;
  }
  const rawBytes = Buffer.byteLength(params.raw, "utf-8");
  const parsed = parseConfigJson5(params.raw, params.json5);
  if (!parsed.ok || !isRecord(parsed.parsed)) {
    return rawBytes;
  }
  const canonical = JSON.stringify(
    stampConfigWriteMetadata(
      parsed.parsed as OpenClawConfig,
      undefined,
      params.lastTouchedVersionOverride,
    ),
    null,
    2,
  )
    .trimEnd()
    .concat("\n");
  return Buffer.byteLength(canonical, "utf-8");
}
