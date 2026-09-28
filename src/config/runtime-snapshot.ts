// Produces redacted runtime config snapshots for diagnostics and UI surfaces.
import { isDeepStrictEqual } from "node:util";
import { sha256Base64Url } from "../infra/crypto-digest.js";
import { clearExecutablePathCache } from "../infra/executable-path.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { isDeeplyFrozenPlainData } from "../shared/immutable-data.js";
import {
  resetPublishedConfigRuntimeEnv,
  type PreparedConfigRuntimeEnv,
} from "./config-env-vars.js";
import { getScopedConfigSnapshotPreparation } from "./io.snapshot-preparation-scope.js";
import type {
  CapturedConfigSnapshotPreparation,
  ConfigSnapshotPreparation,
} from "./io.snapshot-preparation.types.js";
import {
  copyConfigResolutionFacts,
  getConfigResolutionFacts,
  serializeConfigResolutionFacts,
} from "./resolution-facts.js";
import {
  captureRuntimeConfigRead,
  type CapturedRuntimeConfigRead,
  getRuntimeConfigCapture,
} from "./runtime-config-capture-state.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "./types.js";

export type RuntimeConfigSnapshotRefreshOptions = {
  includeAuthStoreRefs?: boolean;
  requireImmediateApplication?: boolean;
};

export type RuntimeConfigSnapshotRefreshParams = RuntimeConfigSnapshotRefreshOptions & {
  sourceConfig: OpenClawConfig;
  preflightResult?: unknown;
  /** Original write authority; refresh owners recheck immediately before activation. */
  assertCurrent?: () => void;
};
type MaybePromise<T> = T | Promise<T>;

export type RuntimeConfigSnapshotPreparationContext = { env?: NodeJS.ProcessEnv };

export type ConfigWriteAfterWrite =
  | { mode: "auto" }
  | { mode: "restart"; reason: string }
  | { mode: "none"; reason: string };

export type ConfigWriteFollowUp =
  | {
      mode: "auto";
      requiresRestart: false;
    }
  | {
      mode: "none";
      reason: string;
      requiresRestart: false;
    }
  | {
      mode: "restart";
      reason: string;
      requiresRestart: true;
    };

export function resolveConfigWriteAfterWrite(
  afterWrite?: ConfigWriteAfterWrite,
): ConfigWriteAfterWrite {
  return afterWrite ?? { mode: "auto" };
}

export function resolveConfigWriteFollowUp(
  afterWrite?: ConfigWriteAfterWrite,
): ConfigWriteFollowUp {
  const resolved = resolveConfigWriteAfterWrite(afterWrite);
  if (resolved.mode === "restart") {
    return {
      mode: "restart",
      reason: resolved.reason,
      requiresRestart: true,
    };
  }
  if (resolved.mode === "none") {
    return {
      mode: "none",
      reason: resolved.reason,
      requiresRestart: false,
    };
  }
  return {
    mode: "auto",
    requiresRestart: false,
  };
}

export type RuntimeConfigSnapshotRefreshHandler = {
  preflight?: (params: RuntimeConfigSnapshotRefreshParams) => MaybePromise<unknown>;
  refresh: (params: RuntimeConfigSnapshotRefreshParams) => boolean | Promise<boolean>;
  clearOnRefreshFailure?: () => void;
};

export type RuntimeConfigWriteNotification = {
  configPath: string;
  snapshot: ConfigFileSnapshot;
  sourceConfig: OpenClawConfig;
  runtimeConfig: OpenClawConfig;
  persistedHash: string;
  revision: number;
  fingerprint: string;
  sourceFingerprint: string | null;
  writtenAtMs: number;
  afterWrite?: ConfigWriteAfterWrite;
  runtimeRefresh?: RuntimeConfigSnapshotRefreshOptions;
  preparedCandidate?: RuntimeConfigWritePreparedCandidate;
  preparedCandidatesByOwner?: ReadonlyMap<symbol, RuntimeConfigWritePreparedCandidate>;
};

export type RuntimeConfigWritePreparedCandidate = {
  runtimeConfig: OpenClawConfig;
  compareConfig: OpenClawConfig;
  runtimeEnv?: PreparedConfigRuntimeEnv;
  reapplyRuntimeOverlays?: (config: OpenClawConfig) => OpenClawConfig;
  reapplyCompareOverlays?: (config: OpenClawConfig) => OpenClawConfig;
};

export type RuntimeConfigSnapshotMetadata = {
  revision: number;
  fingerprint: string;
  sourceFingerprint: string | null;
  updatedAtMs: number;
};

let runtimeConfigSnapshot: OpenClawConfig | null = null;
let runtimeConfigSourceSnapshot: OpenClawConfig | null = null;
let runtimeConfigSnapshotMetadata: RuntimeConfigSnapshotMetadata | null = null;
let runtimeConfigAppliedHash: string | null = null;
let runtimeConfigSnapshotRevision = 0;
let runtimeConfigSnapshotGeneration = 0;
let runtimeConfigPreparerGeneration = 0;
let runtimeConfigSnapshotRefreshHandler: RuntimeConfigSnapshotRefreshHandler | null = null;
type ManagedRuntimeConfigWritePreflight = (
  sourceConfig: OpenClawConfig,
  refreshOptions?: RuntimeConfigSnapshotRefreshOptions,
) => MaybePromise<RuntimeConfigWritePreparedCandidate>;
const managedRuntimeConfigWriteOwners = new Map<
  string,
  Set<{
    id: symbol;
    preflight?: ManagedRuntimeConfigWritePreflight;
    prepareSnapshot?: ConfigSnapshotPreparation;
  }>
>();
const runtimeConfigWriteListeners = new Set<(event: RuntimeConfigWriteNotification) => void>();
const runtimeConfigSnapshotPreparers = new Map<
  (config: OpenClawConfig) => void,
  | {
      prepareAsync: (
        config: OpenClawConfig,
        context: RuntimeConfigSnapshotPreparationContext,
      ) => Promise<() => void>;
    }
  | undefined
>();

function stableConfigStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableConfigStringify(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).toSorted();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableConfigStringify(record[key])}`)
    .join(",")}}`;
}

function configSnapshotsMatch(left: OpenClawConfig, right: OpenClawConfig): boolean {
  if (left === right) {
    return true;
  }
  // Fresh reads allocate new facts. Compare their complete provenance, not object identity
  // or just JSON config bytes: same-byte values can name different authored SecretRefs.
  if (
    getConfigResolutionFacts(left) !== getConfigResolutionFacts(right) &&
    !isDeepStrictEqual(serializeConfigResolutionFacts(left), serializeConfigResolutionFacts(right))
  ) {
    return false;
  }
  try {
    return stableConfigStringify(left) === stableConfigStringify(right);
  } catch {
    return false;
  }
}

// Diagnostic callers stop at their raw revision; this owner accepts config objects.
// Only immutable identities share hashes across reads.
const immutableConfigHashes = new WeakMap<OpenClawConfig, string>();

export function hashRuntimeConfigValue(value: OpenClawConfig): string {
  const immutable = isDeeplyFrozenPlainData(value);
  const cached = immutable ? immutableConfigHashes.get(value) : undefined;
  if (cached !== undefined) {
    return cached;
  }
  const fingerprint = sha256Base64Url(stableConfigStringify(value));
  if (immutable) {
    immutableConfigHashes.set(value, fingerprint);
  }
  return fingerprint;
}

function createRuntimeConfigSnapshotMetadata(
  config: OpenClawConfig,
  sourceConfig?: OpenClawConfig,
): RuntimeConfigSnapshotMetadata {
  runtimeConfigSnapshotRevision += 1;
  return {
    revision: runtimeConfigSnapshotRevision,
    fingerprint: hashRuntimeConfigValue(config),
    sourceFingerprint: sourceConfig ? hashRuntimeConfigValue(sourceConfig) : null,
    updatedAtMs: Date.now(),
  };
}

export function setRuntimeConfigSnapshot(
  config: OpenClawConfig,
  sourceConfig?: OpenClawConfig,
): void {
  const factSource = getConfigResolutionFacts(config) !== null ? config : (sourceConfig ?? config);
  copyConfigResolutionFacts(factSource, config);
  for (const prepare of runtimeConfigSnapshotPreparers.keys()) {
    prepare(config);
  }
  publishRuntimeConfigSnapshot(config, sourceConfig);
}

function publishRuntimeConfigSnapshot(config: OpenClawConfig, sourceConfig?: OpenClawConfig): void {
  runtimeConfigSnapshotGeneration += 1;
  clearExecutablePathCache();
  runtimeConfigSnapshot = config;
  runtimeConfigSourceSnapshot = sourceConfig ?? null;
  runtimeConfigSnapshotMetadata = createRuntimeConfigSnapshotMetadata(config, sourceConfig);
  sessionChanges.emit({ all: true, scope: "config" });
}

export function registerRuntimeConfigSnapshotPreparer(
  prepare: (config: OpenClawConfig) => void,
  options?: {
    prepareAsync: (
      config: OpenClawConfig,
      context: RuntimeConfigSnapshotPreparationContext,
    ) => Promise<() => void>;
  },
): () => void {
  runtimeConfigPreparerGeneration += 1;
  runtimeConfigSnapshotPreparers.set(prepare, options);
  if (runtimeConfigSnapshot) {
    prepare(runtimeConfigSnapshot);
  }
  return () => {
    runtimeConfigPreparerGeneration += 1;
    runtimeConfigSnapshotPreparers.delete(prepare);
  };
}

function preparationFingerprint(config: OpenClawConfig): string {
  return sha256Base64Url(
    stableConfigStringify({ config, facts: serializeConfigResolutionFacts(config) }),
  );
}

/** Prepare off the publication path; a superseded candidate must be discarded by its owner. */
async function prepareRuntimeConfigSnapshot(
  config: OpenClawConfig,
  context: RuntimeConfigSnapshotPreparationContext = {},
  assertCurrent?: () => void,
): Promise<() => boolean> {
  const generation = runtimeConfigSnapshotGeneration;
  const preparerGeneration = runtimeConfigPreparerGeneration;
  const fingerprint = preparationFingerprint(config);
  const envFingerprint = context.env ? sha256Base64Url(stableConfigStringify(context.env)) : null;
  const prepared = await Promise.allSettled(
    [...runtimeConfigSnapshotPreparers].map(async ([prepare, options]) =>
      options ? options.prepareAsync(config, context) : () => prepare(config),
    ),
  );
  const contributions: Array<() => void> = [];
  for (const result of prepared) {
    if (result.status === "rejected") {
      throw result.reason;
    }
    contributions.push(result.value);
  }
  const isCurrent = () => {
    assertCurrent?.();
    return (
      runtimeConfigSnapshotGeneration === generation &&
      runtimeConfigPreparerGeneration === preparerGeneration &&
      preparationFingerprint(config) === fingerprint &&
      (context.env ? sha256Base64Url(stableConfigStringify(context.env)) : null) === envFingerprint
    );
  };
  let consumed = false;
  return () => {
    if (consumed || !isCurrent()) {
      return false;
    }
    consumed = true;
    for (const contribute of contributions) {
      contribute();
      // Contributions may reenter config publication or revoke the admitting owner.
      if (!isCurrent()) {
        return false;
      }
    }
    publishRuntimeConfigSnapshot(config);
    return true;
  };
}

export function setAppliedRuntimeConfigSnapshot(
  config: OpenClawConfig,
  sourceConfig: OpenClawConfig,
): void {
  setRuntimeConfigSnapshot(config, sourceConfig);
  runtimeConfigAppliedHash = hashRuntimeConfigValue(sourceConfig);
}

/** Publish a newer canonical source without changing the active runtime object. */
export function setRuntimeConfigSourceSnapshotIfCurrent(params: {
  expectedRevision: number;
  sourceConfig: OpenClawConfig;
}): boolean {
  if (
    !runtimeConfigSnapshot ||
    !runtimeConfigSnapshotMetadata ||
    runtimeConfigSnapshotMetadata.revision !== params.expectedRevision
  ) {
    return false;
  }
  copyConfigResolutionFacts(params.sourceConfig, runtimeConfigSnapshot);
  setRuntimeConfigSnapshot(runtimeConfigSnapshot, params.sourceConfig);
  return true;
}

export function resetConfigRuntimeState(options: { preserveConfigEnv?: boolean } = {}): void {
  runtimeConfigSnapshotGeneration += 1;
  clearExecutablePathCache();
  runtimeConfigSnapshot = null;
  runtimeConfigSourceSnapshot = null;
  runtimeConfigSnapshotMetadata = null;
  runtimeConfigAppliedHash = null;
  runtimeConfigSnapshotRevision = 0;
  resetPublishedConfigRuntimeEnv({ preserveOwnership: options.preserveConfigEnv });
}

export function clearRuntimeConfigSnapshot(): void {
  // Snapshot cleanup leaves process.env intact. Retain its config-owned layer so
  // the next startup/reload can replace it without treating it as ambient input.
  resetConfigRuntimeState({ preserveConfigEnv: true });
}

export function getRuntimeConfigSnapshot(): OpenClawConfig | null {
  return runtimeConfigSnapshot;
}

export function getRuntimeConfigSourceSnapshot(): OpenClawConfig | null {
  return runtimeConfigSourceSnapshot;
}

export function getRuntimeConfigSnapshotMetadata(): RuntimeConfigSnapshotMetadata | null {
  return runtimeConfigSnapshotMetadata;
}

/** Resolved source-config revision accepted by the active Gateway runtime. */
export function getRuntimeConfigAppliedHash(): string | null {
  return runtimeConfigAppliedHash;
}

export function setRuntimeConfigAppliedHash(hash: string | null): void {
  runtimeConfigAppliedHash = hash;
}

export function resolveRuntimeConfigCacheKey(config: OpenClawConfig): string {
  const metadata = runtimeConfigSnapshotMetadata;
  if (metadata && config === runtimeConfigSnapshot) {
    return `runtime:${metadata.revision}:${metadata.fingerprint}`;
  }
  return `config:${hashRuntimeConfigValue(config)}`;
}

export function selectApplicableRuntimeConfig(params: {
  inputConfig?: OpenClawConfig;
  runtimeConfig?: OpenClawConfig | null;
  runtimeSourceConfig?: OpenClawConfig | null;
}): OpenClawConfig | undefined {
  const runtimeConfig = params.runtimeConfig ?? null;
  if (!runtimeConfig) {
    return params.inputConfig;
  }
  const inputConfig = params.inputConfig;
  if (!inputConfig) {
    return runtimeConfig;
  }
  if (inputConfig === runtimeConfig) {
    return inputConfig;
  }
  const runtimeSourceConfig = params.runtimeSourceConfig ?? null;
  // A pinned file config is not an activated secrets snapshot. Without its source
  // contract, replacing an explicit config can discard command-resolved credentials.
  if (runtimeSourceConfig && configSnapshotsMatch(inputConfig, runtimeSourceConfig)) {
    return runtimeConfig;
  }
  return inputConfig;
}

/** Bind a retained consumer to its current runtime owner while preserving scoped configs. */
export function createRuntimeConfigReader(inputConfig: OpenClawConfig): () => OpenClawConfig {
  const origin = getRuntimeConfigCapture(inputConfig)?.origin ?? inputConfig;
  const followsRuntimeConfig =
    runtimeConfigSnapshot === origin ||
    (runtimeConfigSourceSnapshot !== null &&
      configSnapshotsMatch(inputConfig, runtimeConfigSourceSnapshot));
  return () => (followsRuntimeConfig ? runtimeConfigSnapshot : null) ?? inputConfig;
}

export function setRuntimeConfigSnapshotRefreshHandler(
  refreshHandler: RuntimeConfigSnapshotRefreshHandler | null,
): void {
  runtimeConfigSnapshotRefreshHandler = refreshHandler;
}

export function getRuntimeConfigSnapshotRefreshHandler(): RuntimeConfigSnapshotRefreshHandler | null {
  return runtimeConfigSnapshotRefreshHandler;
}

export function registerRuntimeConfigWriteListener(
  listener: (event: RuntimeConfigWriteNotification) => void,
): () => void {
  runtimeConfigWriteListeners.add(listener);
  return () => {
    runtimeConfigWriteListeners.delete(listener);
  };
}

export function registerManagedRuntimeConfigWriteOwner(
  configPath: string,
  preflight?: ManagedRuntimeConfigWritePreflight,
  prepareSnapshot?: ConfigSnapshotPreparation,
): (() => void) & { ownerId: symbol } {
  const owner = { id: Symbol("managed-runtime-config-write-owner"), preflight, prepareSnapshot };
  const owners = managedRuntimeConfigWriteOwners.get(configPath) ?? new Set();
  owners.add(owner);
  managedRuntimeConfigWriteOwners.set(configPath, owners);
  let released = false;
  const unregister = () => {
    if (released) {
      return;
    }
    released = true;
    const currentOwners = managedRuntimeConfigWriteOwners.get(configPath);
    currentOwners?.delete(owner);
    if (!currentOwners || currentOwners.size === 0) {
      managedRuntimeConfigWriteOwners.delete(configPath);
    }
  };
  return Object.assign(unregister, { ownerId: owner.id });
}

/** A read retains one exact host owner; release cannot redirect it to a replacement. */
export function captureManagedConfigSnapshotPreparation(
  configPath: string,
): CapturedConfigSnapshotPreparation | null {
  const scoped = getScopedConfigSnapshotPreparation(configPath);
  const owner = [...(managedRuntimeConfigWriteOwners.get(configPath) ?? [])].find(
    (candidate) => candidate.prepareSnapshot,
  );
  const prepare = scoped?.prepare ?? owner?.prepareSnapshot;
  if (!prepare) {
    return null;
  }
  const isCurrent =
    scoped?.isCurrent ??
    (() => Boolean(owner && managedRuntimeConfigWriteOwners.get(configPath)?.has(owner)));
  const assertCurrent = () => {
    if (!isCurrent()) {
      throw new Error("Gateway config snapshot preparation owner has closed");
    }
  };
  const run = async <T>(
    operation: (prepare: ConfigSnapshotPreparation) => Promise<T>,
  ): Promise<T> => {
    assertCurrent();
    try {
      return await operation(prepare);
    } finally {
      assertCurrent();
    }
  };
  return Object.assign(run, { assertCurrent });
}

export async function preflightManagedRuntimeConfigWrite(
  configPath: string,
  sourceConfig: OpenClawConfig,
  refreshOptions?: RuntimeConfigSnapshotRefreshOptions,
): Promise<Map<symbol, RuntimeConfigWritePreparedCandidate>> {
  const owners = managedRuntimeConfigWriteOwners.get(configPath);
  if (!owners) {
    if (refreshOptions?.requireImmediateApplication) {
      throw new Error(
        "The Gateway cannot apply this activation. Start the Gateway, then retry the saved sign-in.",
      );
    }
    return new Map();
  }
  const preparedCandidates = new Map<symbol, RuntimeConfigWritePreparedCandidate>();
  for (const owner of owners) {
    if (owner.preflight) {
      preparedCandidates.set(owner.id, await owner.preflight(sourceConfig, refreshOptions));
    }
  }
  return preparedCandidates;
}

export function hasManagedRuntimeConfigWriteOwner(configPath: string): boolean {
  return managedRuntimeConfigWriteOwners.has(configPath);
}

export function notifyRuntimeConfigWriteListeners(event: RuntimeConfigWriteNotification): void {
  for (const listener of runtimeConfigWriteListeners) {
    try {
      listener(event);
    } catch {
      // Best-effort observer path only; successful writes must still complete.
    }
  }
}

export function loadPinnedRuntimeConfig(loadFresh: () => OpenClawConfig): OpenClawConfig {
  if (runtimeConfigSnapshot) {
    return runtimeConfigSnapshot;
  }
  const config = loadFresh();
  setRuntimeConfigSnapshot(config);
  return getRuntimeConfigSnapshot() ?? config;
}

type RuntimeConfigAsyncLoader = (assertCurrent: () => void) => Promise<{
  config: OpenClawConfig;
  runtimeEnv?: PreparedConfigRuntimeEnv;
}>;
/** Pin a strict cold load, optionally capturing its source and env before yielding. */
export function loadPinnedRuntimeConfigAsync(
  loadFresh: RuntimeConfigAsyncLoader,
  options: { assertCurrent?: () => void; capture: true },
): Promise<CapturedRuntimeConfigRead>;
export function loadPinnedRuntimeConfigAsync(
  loadFresh: RuntimeConfigAsyncLoader,
  options?: { assertCurrent?: () => void; capture?: false },
): Promise<OpenClawConfig>;
export async function loadPinnedRuntimeConfigAsync(
  loadFresh: RuntimeConfigAsyncLoader,
  options: { assertCurrent?: () => void; capture?: boolean } = {},
): Promise<OpenClawConfig | CapturedRuntimeConfigRead> {
  const result = (config: OpenClawConfig) =>
    options.capture
      ? captureRuntimeConfigRead(config, runtimeConfigSourceSnapshot ?? config)
      : config;
  options.assertCurrent?.();
  if (runtimeConfigSnapshot) {
    return result(runtimeConfigSnapshot);
  }
  const generation = runtimeConfigSnapshotGeneration;
  const assertCurrent = () => {
    options.assertCurrent?.();
    if (runtimeConfigSnapshotGeneration !== generation) {
      throw new Error("Runtime config load was superseded before publication");
    }
  };
  try {
    const { config, runtimeEnv } = await loadFresh(assertCurrent);
    options.assertCurrent?.();
    if (runtimeConfigSnapshot) {
      return result(runtimeConfigSnapshot);
    }
    assertCurrent();
    const commit = await prepareRuntimeConfigSnapshot(
      config,
      { env: runtimeEnv?.env },
      options.assertCurrent,
    );
    options.assertCurrent?.();
    if (runtimeConfigSnapshot) {
      return result(runtimeConfigSnapshot);
    }
    assertCurrent();
    const publication = runtimeEnv?.publish();
    try {
      assertCurrent();
      if (!commit()) {
        throw new Error("Runtime config preparation was superseded before publication");
      }
      publication?.commit();
    } catch (error) {
      publication?.();
      throw error;
    }
    return result(getRuntimeConfigSnapshot() ?? config);
  } catch (error) {
    options.assertCurrent?.();
    if (runtimeConfigSnapshot) {
      return result(runtimeConfigSnapshot);
    }
    throw error;
  }
}

export async function preflightRuntimeSnapshotWrite(params: {
  nextSourceConfig: OpenClawConfig;
  refreshOptions?: RuntimeConfigSnapshotRefreshOptions;
  createRefreshError: (detail: string, cause: unknown) => Error;
  formatRefreshError: (error: unknown) => string;
}): Promise<unknown> {
  if (params.refreshOptions?.requireImmediateApplication) {
    throw new Error(
      "The Gateway cannot apply this activation. Start the Gateway, then retry the saved sign-in.",
    );
  }
  const refreshHandler = getRuntimeConfigSnapshotRefreshHandler();
  if (!refreshHandler?.preflight) {
    return undefined;
  }
  try {
    return await refreshHandler.preflight({
      sourceConfig: params.nextSourceConfig,
      ...params.refreshOptions,
    });
  } catch (error) {
    throw params.createRefreshError(params.formatRefreshError(error), error);
  }
}

export async function finalizeRuntimeSnapshotWrite(params: {
  nextSourceConfig: OpenClawConfig;
  refreshOptions?: RuntimeConfigSnapshotRefreshOptions;
  hadBothSnapshots: boolean;
  freshConfig: OpenClawConfig | RuntimeConfigAsyncLoader;
  notifyCommittedWrite: () => void;
  createRefreshError: (detail: string, cause: unknown) => Error;
  formatRefreshError: (error: unknown) => string;
  preflightResult?: unknown;
  deferRuntimeActivation?: boolean;
  assertCurrent?: () => void;
}): Promise<void> {
  const notifyCommittedWrite = () => {
    params.assertCurrent?.();
    params.notifyCommittedWrite();
  };
  params.assertCurrent?.();
  if (params.deferRuntimeActivation) {
    notifyCommittedWrite();
    return;
  }
  const generation = runtimeConfigSnapshotGeneration;
  const refreshHandler = getRuntimeConfigSnapshotRefreshHandler();
  if (refreshHandler) {
    let refreshed: boolean;
    try {
      refreshed = await refreshHandler.refresh({
        sourceConfig: params.nextSourceConfig,
        ...params.refreshOptions,
        preflightResult: params.preflightResult,
        ...(params.assertCurrent ? { assertCurrent: params.assertCurrent } : {}),
      });
    } catch (error) {
      // An expired writer must not clear the last-known-good runtime either.
      params.assertCurrent?.();
      try {
        refreshHandler.clearOnRefreshFailure?.();
      } catch {
        // Keep the original refresh failure as the surfaced error.
      }
      throw params.createRefreshError(params.formatRefreshError(error), error);
    }
    // Refresh can yield before returning even when it declines activation.
    params.assertCurrent?.();
    if (refreshed) {
      notifyCommittedWrite();
      return;
    }
  }

  const assertCurrent = () => {
    params.assertCurrent?.();
    if (runtimeConfigSnapshotGeneration !== generation) {
      throw new Error("Runtime config reload was superseded before publication");
    }
  };
  const { config, runtimeEnv } =
    typeof params.freshConfig === "function"
      ? await params.freshConfig(assertCurrent)
      : { config: params.freshConfig };
  assertCurrent();
  const publication = runtimeEnv?.publish();
  try {
    assertCurrent();
    setRuntimeConfigSnapshot(config, params.hadBothSnapshots ? params.nextSourceConfig : undefined);
    publication?.commit();
  } catch (error) {
    publication?.();
    throw error;
  }
  notifyCommittedWrite();
}
