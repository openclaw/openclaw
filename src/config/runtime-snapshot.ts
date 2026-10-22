import { isDeepStrictEqual } from "node:util";
import { clearExecutablePathCache } from "../infra/executable-path.js";
import { prepareRuntimePluginsConfig } from "../plugins/config-state.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { notifyListeners, registerListener } from "../shared/listeners.js";
import {
  cloneEnvWithPlatformSemantics,
  resetPublishedConfigRuntimeEnv,
  type PreparedConfigRuntimeEnv,
} from "./config-env-vars.js";
import {
  cloneConfigWithResolutionFacts,
  copyConfigResolutionFacts,
  getConfigResolutionFacts,
  serializeConfigResolutionFacts,
} from "./resolution-facts.js";
import {
  captureRuntimeConfigWithSource,
  type CapturedRuntimeConfigRead,
  getRuntimeConfigCapture,
} from "./runtime-config-capture-state.js";
import { runtimeConfigPublication } from "./runtime-config-publication.js";
import { configSnapshotsMatch } from "./runtime-config-snapshot-match.js";
import { runtimeSessionPublicationChangeScope } from "./runtime-session-changes.js";
import {
  hashRuntimeConfigValue,
  hashModelConfig,
  matchesRuntimeConfigValueFact,
  matchesRuntimeSourceConfigValueFact,
  prepareRuntimeConfigValueFact,
  type RuntimeConfigValueFact,
} from "./runtime-snapshot-value-fact.js";
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
  | (Exclude<ConfigWriteAfterWrite, { mode: "restart" }> & { requiresRestart: false })
  | (Extract<ConfigWriteAfterWrite, { mode: "restart" }> & { requiresRestart: true });

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
};

let runtimeConfigSnapshot: OpenClawConfig | null = null;
let runtimeConfigCapturedSnapshot: OpenClawConfig | null = null;
let runtimeConfigSourceSnapshot: OpenClawConfig | null = null;
let runtimeConfigSnapshotMetadata: RuntimeConfigSnapshotMetadata | null = null;
let runtimeModelConfigCacheKey: string | null = null;
let runtimeConfigValueFact: RuntimeConfigValueFact | null = null;
let runtimeSourceConfigValueFact: RuntimeConfigValueFact | null = null;
let runtimeConfigAppliedHash: string | null = null;
let runtimeConfigSnapshotRevision = 0;
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
  }>
>();
const runtimeConfigWriteListeners = new Set<(event: RuntimeConfigWriteNotification) => void>();
const runtimeConfigSnapshotPreparers = new Map<
  Parameters<typeof registerRuntimeConfigSnapshotPreparer>[0],
  Parameters<typeof registerRuntimeConfigSnapshotPreparer>[1]
>();

export { hashRuntimeConfigValue } from "./runtime-snapshot-value-fact.js";

export function setRuntimeConfigSnapshot(
  config: OpenClawConfig,
  sourceConfig?: OpenClawConfig,
): void {
  preparePublishedRuntimeConfigSnapshot(config, sourceConfig, false);
}

function preparePublishedRuntimeConfigSnapshot(
  inputConfig: OpenClawConfig,
  sourceConfig: OpenClawConfig | undefined,
  valuesUnchanged: boolean,
): void {
  const config = getRuntimeConfigCapture(inputConfig)
    ? cloneConfigWithResolutionFacts(inputConfig)
    : inputConfig;
  const factSource = getConfigResolutionFacts(config) !== null ? config : (sourceConfig ?? config);
  copyConfigResolutionFacts(factSource, config);
  for (const prepare of runtimeConfigSnapshotPreparers.keys()) {
    prepare(config);
  }
  publishRuntimeConfigSnapshot(config, sourceConfig, valuesUnchanged);
}

function publishRuntimeConfigSnapshot(
  config: OpenClawConfig,
  sourceConfig?: OpenClawConfig,
  valuesUnchanged = false,
): void {
  const configFact = prepareRuntimeConfigValueFact(config, runtimeConfigValueFact);
  const facts = configFact.facts;
  // A no-op must match the live publication as well as its recorded value. Provenance can
  // change in place without changing the value hash; either kind of edit needs broad invalidation.
  const previousEditedInPlace =
    runtimeConfigSnapshot !== null &&
    runtimeConfigValueFact !== null &&
    !(
      matchesRuntimeConfigValueFact(runtimeConfigSnapshot, runtimeConfigValueFact) &&
      isDeepStrictEqual(
        serializeConfigResolutionFacts(runtimeConfigSnapshot),
        runtimeConfigValueFact.facts,
      )
    );
  const previousSourceEditedInPlace =
    runtimeConfigSourceSnapshot !== null &&
    runtimeSourceConfigValueFact !== null &&
    !matchesRuntimeSourceConfigValueFact(runtimeConfigSourceSnapshot, runtimeSourceConfigValueFact);
  // Authored policy can change while resolved runtime values stay identical. Only the
  // write-version stamp is irrelevant to that policy; compare against captured source bytes.
  const sourceMatchesPublished =
    sourceConfig === undefined
      ? runtimeConfigSourceSnapshot === null
      : runtimeConfigSourceSnapshot !== null &&
        runtimeSourceConfigValueFact !== null &&
        matchesRuntimeSourceConfigValueFact(sourceConfig, runtimeSourceConfigValueFact);
  // Compare with what the previous publication recorded, since its object may have been edited
  // in place; withhold only a distinct object matching that record, or a proven no-op.
  const matchesPublished =
    runtimeConfigSnapshot !== config &&
    runtimeConfigSnapshotMetadata?.fingerprint === configFact.fingerprint &&
    isDeepStrictEqual(runtimeConfigValueFact?.facts, facts);
  if (
    !previousEditedInPlace &&
    !previousSourceEditedInPlace &&
    sourceMatchesPublished &&
    (valuesUnchanged || matchesPublished)
  ) {
    return;
  }
  const sourceFact =
    sourceConfig && (sourceConfig !== config || !configFact.value)
      ? prepareRuntimeConfigValueFact(sourceConfig, runtimeSourceConfigValueFact)
      : configFact;
  const metadata: RuntimeConfigSnapshotMetadata = {
    revision: ++runtimeConfigSnapshotRevision,
    fingerprint: configFact.fingerprint,
    sourceFingerprint: sourceConfig ? sourceFact.fingerprint : null,
  };
  const scope = runtimeSessionPublicationChangeScope({
    previousRuntimeConfig: runtimeConfigSnapshot,
    runtimeConfig: config,
    previousSourceConfig: runtimeConfigSourceSnapshot,
    sourceConfig,
    runtimeUnchanged: valuesUnchanged || matchesPublished,
    sourceUnchanged: sourceMatchesPublished,
    previousEditedInPlace: previousEditedInPlace || previousSourceEditedInPlace,
  });
  prepareRuntimePluginsConfig(config);
  clearExecutablePathCache();
  runtimeConfigSnapshot = config;
  runtimeConfigCapturedSnapshot = null;
  runtimeConfigSourceSnapshot = sourceConfig ?? null;
  runtimeConfigSnapshotMetadata = metadata;
  if (
    runtimeModelConfigCacheKey === null ||
    configFact !== runtimeConfigValueFact ||
    sourceFact !== runtimeSourceConfigValueFact
  ) {
    runtimeModelConfigCacheKey = hashModelConfig(config, sourceConfig ?? config);
  }
  runtimeConfigPublication.current = { config, revision: metadata };
  runtimeConfigValueFact = configFact;
  runtimeSourceConfigValueFact = sourceFact;
  sessionChanges.emit({ all: true, scope });
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
  runtimeConfigSnapshotPreparers.set(prepare, options);
  if (runtimeConfigSnapshot) {
    prepare(runtimeConfigSnapshot);
  }
  return () => {
    runtimeConfigSnapshotPreparers.delete(prepare);
  };
}

/** Prepare off the publication path; the caller retains publication authority. */
async function prepareRuntimeConfigSnapshot(
  inputConfig: OpenClawConfig,
  context: RuntimeConfigSnapshotPreparationContext = {},
  assertCurrent?: () => void,
  sourceConfig?: OpenClawConfig,
): Promise<() => void> {
  const config = getRuntimeConfigCapture(inputConfig)
    ? cloneConfigWithResolutionFacts(inputConfig)
    : inputConfig;
  const factSource = getConfigResolutionFacts(config) !== null ? config : (sourceConfig ?? config);
  copyConfigResolutionFacts(factSource, config);
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
  return () => {
    assertCurrent?.();
    for (const contribute of contributions) {
      contribute();
    }
    assertCurrent?.();
    publishRuntimeConfigSnapshot(config, sourceConfig);
  };
}

export async function setAppliedRuntimeConfigSnapshot(
  config: OpenClawConfig,
  sourceConfig: OpenClawConfig,
): Promise<void> {
  const publish = await prepareRuntimeConfigSnapshot(config, {}, undefined, sourceConfig);
  publish();
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
  const published = runtimeConfigSnapshot;
  const sourceFacts = serializeConfigResolutionFacts(params.sourceConfig);
  // Rows read only the runtime object: a newer source changes them only through an in-place
  // edit since the last publication or through the provenance copied onto it here.
  const valuesUnchanged =
    runtimeConfigValueFact !== null &&
    matchesRuntimeConfigValueFact(published, runtimeConfigValueFact) &&
    isDeepStrictEqual(runtimeConfigValueFact.facts, sourceFacts);
  copyConfigResolutionFacts(params.sourceConfig, published);
  preparePublishedRuntimeConfigSnapshot(published, params.sourceConfig, valuesUnchanged);
  return true;
}

export function resetConfigRuntimeState(options: { preserveConfigEnv?: boolean } = {}): void {
  clearExecutablePathCache();
  prepareRuntimePluginsConfig(null);
  runtimeConfigSnapshot = null;
  runtimeConfigCapturedSnapshot = null;
  runtimeConfigSourceSnapshot = null;
  runtimeConfigSnapshotMetadata = null;
  runtimeModelConfigCacheKey = null;
  runtimeConfigPublication.current = undefined;
  runtimeConfigValueFact = null;
  runtimeSourceConfigValueFact = null;
  runtimeConfigAppliedHash = null;
  runtimeConfigSnapshotRevision = 0;
  resetPublishedConfigRuntimeEnv({ preserveOwnership: options.preserveConfigEnv });
}

export function clearRuntimeConfigSnapshot(): void {
  // Snapshot cleanup leaves process.env intact. Retain its config-owned layer so
  // the next startup/reload can replace it without treating it as ambient input.
  resetConfigRuntimeState({ preserveConfigEnv: true });
}

export function getRuntimeConfigSnapshot(options?: { capture?: boolean }): OpenClawConfig | null {
  if (options?.capture && runtimeConfigSnapshot) {
    return (runtimeConfigCapturedSnapshot ??= captureRuntimeConfigWithSource(
      runtimeConfigSnapshot,
      runtimeConfigSourceSnapshot ?? runtimeConfigSnapshot,
    ));
  }
  return runtimeConfigSnapshot;
}

/** Read the config published by runtime preparation without cold-loading storage. */
export function readRuntimeConfig(): OpenClawConfig {
  const config = getRuntimeConfigSnapshot();
  if (!config) {
    throw new Error(
      "Runtime config is not prepared. Await captureRuntimeConfigAsyncReader()() first.",
    );
  }
  return config;
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

/** Model projections ignore display settings, but retain authored values and resolution provenance. */
export function resolveRuntimeModelConfigCacheKey(config: OpenClawConfig): string {
  if (config === runtimeConfigSnapshot && runtimeModelConfigCacheKey !== null) {
    return runtimeModelConfigCacheKey;
  }
  return hashModelConfig(config, getRuntimeConfigCapture(config)?.source ?? config);
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
  return registerListener(runtimeConfigWriteListeners, listener);
}

export function registerManagedRuntimeConfigWriteOwner(
  configPath: string,
  preflight?: ManagedRuntimeConfigWritePreflight,
): (() => void) & { ownerId: symbol } {
  const owner = { id: Symbol("managed-runtime-config-write-owner"), preflight };
  const owners = managedRuntimeConfigWriteOwners.get(configPath) ?? new Set();
  owners.add(owner);
  managedRuntimeConfigWriteOwners.set(configPath, owners);
  const unregister = () => {
    const currentOwners = managedRuntimeConfigWriteOwners.get(configPath);
    currentOwners?.delete(owner);
    if (!currentOwners || currentOwners.size === 0) {
      managedRuntimeConfigWriteOwners.delete(configPath);
    }
  };
  return Object.assign(unregister, { ownerId: owner.id });
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
  notifyListeners(runtimeConfigWriteListeners, event);
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
      ? {
          config:
            config === runtimeConfigSnapshot
              ? getRuntimeConfigSnapshot({ capture: true })!
              : captureRuntimeConfigWithSource(config, runtimeConfigSourceSnapshot ?? config),
          env: cloneEnvWithPlatformSemantics(process.env),
        }
      : config;
  options.assertCurrent?.();
  if (runtimeConfigSnapshot) {
    return result(runtimeConfigSnapshot);
  }
  const assertCurrent = () => options.assertCurrent?.();
  try {
    const { config, runtimeEnv } = await loadFresh(assertCurrent);
    options.assertCurrent?.();
    if (runtimeConfigSnapshot) {
      return result(runtimeConfigSnapshot);
    }
    const commit = await prepareRuntimeConfigSnapshot(
      config,
      { env: runtimeEnv?.env },
      options.assertCurrent,
    );
    options.assertCurrent?.();
    if (runtimeConfigSnapshot) {
      return result(runtimeConfigSnapshot);
    }
    const publication = runtimeEnv?.publish();
    try {
      assertCurrent();
      commit();
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

export async function finalizeRuntimeSnapshotWrite(
  params: Parameters<typeof preflightRuntimeSnapshotWrite>[0] & {
    hadBothSnapshots: boolean;
    freshConfig: OpenClawConfig | RuntimeConfigAsyncLoader;
    notifyCommittedWrite: () => void;
    preflightResult?: unknown;
    deferRuntimeActivation?: boolean;
    assertCurrent?: () => void;
  },
): Promise<void> {
  const notifyCommittedWrite = () => {
    params.assertCurrent?.();
    params.notifyCommittedWrite();
  };
  params.assertCurrent?.();
  if (params.deferRuntimeActivation) {
    notifyCommittedWrite();
    return;
  }
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

  const assertCurrent = () => params.assertCurrent?.();
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
