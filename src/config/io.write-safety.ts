import type fs from "node:fs";
import path from "node:path";
import {
  replaceFileAtomicSync,
  type ReplaceFileAtomicDestinationState,
} from "@openclaw/fs-safe/atomic";
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

export type ConfigFileWritePathSnapshot = {
  targetPath: string;
  entries: Array<
    | { path: string; kind: "missing-directory" }
    | { path: string; kind: "existing"; dev: string; ino: string; link?: string }
  >;
};

/** The captured path facts survive an update's delegated finalizer; they grant no write authority. */
export function assertConfigFileWritePathSnapshot(
  snapshot: ConfigFileWritePathSnapshot,
  ioFs: typeof fs,
): void {
  const conflict = () =>
    new ConfigMutationConflictError("included config target changed since last load", {
      retryable: false,
    });
  for (const expected of snapshot.entries) {
    const stat = ioFs.lstatSync(expected.path, { bigint: true, throwIfNoEntry: false });
    if (expected.kind === "missing-directory") {
      if (stat && !stat.isDirectory()) {
        throw conflict();
      }
      continue;
    }
    if (
      !stat ||
      stat.dev.toString() !== expected.dev ||
      stat.ino.toString() !== expected.ino ||
      (expected.link === undefined
        ? !stat.isDirectory()
        : !stat.isSymbolicLink() || ioFs.readlinkSync(expected.path) !== expected.link)
    ) {
      throw conflict();
    }
  }
  if (ioFs.lstatSync(snapshot.targetPath, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw conflict();
  }
}

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
  const snapshot: ConfigFileWritePathSnapshot = {
    targetPath,
    entries: [...facts].map(([entry, fact]) =>
      fact.kind === "missing-directory"
        ? { path: entry, kind: fact.kind }
        : {
            path: entry,
            kind: fact.kind,
            dev: fact.dev.toString(),
            ino: fact.ino.toString(),
            link: fact.link,
          },
    ),
  };
  const assertCurrent = () => assertConfigFileWritePathSnapshot(snapshot, ioFs);
  assertCurrent();
  return { path: filePath, snapshot, assertCurrent };
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

/** Keep config conflicts and compensation policy outside the atomic file owner. */
export function createConfigFileWriteGuard(
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
  let expectedSnapshot = publication?.snapshot;
  let publishedIdentity = publication?.publicationIdentity;
  const authority = createConfigWriteAuthorityGuard(assertCurrent);
  let refusal: { error: unknown } | undefined;
  const current = () => {
    if (refusal) {
      throw refusal.error;
    }
    authority();
  };
  const assertPublishedIdentity = () => {
    publication?.targetPathProof?.assertCurrent();
    if (publishedIdentity === undefined) {
      return;
    }
    const entry = fsModule.lstatSync(configPath, { bigint: true, throwIfNoEntry: false });
    if (
      publishedIdentity === null
        ? entry !== undefined
        : !entry ||
          entry.dev !== publishedIdentity.dev ||
          entry.ino !== publishedIdentity.ino ||
          !entry.isFile() ||
          entry.nlink !== 1n
    ) {
      throw new ConfigMutationConflictError("config publication identity changed", {
        retryable: false,
      });
    }
  };
  const assertBeforeMutation = () => {
    try {
      current();
      assertPublishedIdentity();
      if (expectedSnapshot) {
        assertBaseSnapshotStillCurrent(
          expectedSnapshot,
          configPath,
          fsModule,
          publication?.includeGraph,
          includePathProofs,
        );
      }
    } catch (error) {
      // A transient path/hash failure also revokes the rest of this publication.
      refusal ??= { error };
      throw refusal.error;
    }
  };
  const onDestinationState = (state: ReplaceFileAtomicDestinationState) => {
    publishedIdentity = state.state === "removed" ? null : { dev: state.dev, ino: state.ino };
    if (state.state === "published") {
      expectedSnapshot = undefined;
      publication?.onRootPublished?.();
    } else {
      // Our own removal/create replaces the old root bytes; include inputs stay pinned.
      expectedSnapshot = publication && {
        ...publication.snapshot,
        exists: state.state === "writing",
        raw: null,
      };
      publication?.onRootRemoved?.();
    }
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
    // Recovery owns later transitions and uses the enclosing owner's current authority.
    return { assertCurrent: assertRollbackOwner, publicationIdentity: publishedIdentity };
  };
  let stagedIdentity: ConfigFileWriteIdentity | undefined;
  const fileSystem: typeof fs = {
    ...fsModule,
    writeFileSync: new Proxy(fsModule.writeFileSync, {
      apply(target, thisArg, args) {
        const result = Reflect.apply(target, thisArg, args);
        if (typeof args[0] === "number") {
          stagedIdentity = fsModule.fstatSync(args[0], { bigint: true });
        }
        return result;
      },
    }),
    renameSync(source, destination) {
      fsModule.renameSync(source, destination);
      if (destination === configPath && stagedIdentity) {
        // fs-safe's verified receipt arrives later; a successful rename already needs recovery.
        onDestinationState({ state: "published", path: configPath, ...stagedIdentity });
      }
    },
    ...(publication?.preserveDirectoryMode
      ? {
          fchmodSync: (fd, mode) => {
            if (!fsModule.fstatSync(fd).isDirectory()) {
              fsModule.fchmodSync(fd, mode);
            }
          },
        }
      : {}),
  };
  return {
    fileSystem,
    assertCurrent: current,
    assertBeforeMutation,
    onDestinationState,
    assertPublishedIdentity,
    captureRollbackProof,
  };
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

export type ConfigFileRollbackPublication = (publish: () => void, didMutate: () => boolean) => void;

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
  withPublication?: ConfigFileRollbackPublication;
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
  const previousRaw = params.previousSnapshot.exists ? params.previousSnapshot.raw : undefined;
  if (params.previousSnapshot.exists && typeof previousRaw !== "string") {
    return false;
  }
  let mutated = false;
  const guard = createConfigFileWriteGuard(params.configPath, params.fsModule, assertCurrent, {
    publicationIdentity: params.publicationIdentity,
    snapshot: { ...params.previousSnapshot, exists: currentRaw !== null, raw: currentRaw },
    includeGraph: { hashes: {}, targets: {} },
    preserveDirectoryMode: params.preserveDirectoryMode,
    onRootPublished: () => {
      mutated = true;
    },
    onRootRemoved: () => {
      mutated = true;
    },
  });
  const publish = () => {
    if (typeof previousRaw === "string") {
      replaceFileAtomicSync({
        filePath: params.configPath,
        content: previousRaw,
        dirMode: 0o700,
        mode: 0o600,
        copyFallbackOnPermissionError: true,
        syncTempFile: params.durable,
        syncParentDir: params.durable,
        destinationHardlinks: params.destinationHardlinks,
        throwOnCleanupError: true,
        fileSystem: guard.fileSystem,
        assertBeforeMutation: guard.assertBeforeMutation,
        onDestinationState: guard.onDestinationState,
      });
      return;
    }
    guard.assertBeforeMutation();
    params.fsModule.rmSync(params.configPath, { force: true });
    mutated = true;
  };
  if (params.withPublication) {
    params.withPublication(publish, () => mutated);
  } else {
    publish();
  }
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
    stampConfigWriteMetadata(parsed.parsed as OpenClawConfig, params.lastTouchedVersionOverride),
    null,
    2,
  )
    .trimEnd()
    .concat("\n");
  return Buffer.byteLength(canonical, "utf-8");
}
