import {
  asNullableRecord as asConfigRecord,
  isRecord,
} from "@openclaw/normalization-core/record-coerce";
import type { Result } from "@openclaw/normalization-core/result";
import { createDeferredCore, type Deferred } from "../../../../src/shared/deferred.js";
import type { GatewayBrowserClient, GatewayHelloOk } from "../../api/gateway.ts";
import type { ConfigSnapshot, ConfigUiHints } from "../../api/types.ts";
import type { ApplicationGatewayPhase } from "../../app/gateway.ts";
import { normalizeAgentId } from "../sessions/session-key.ts";

export type ConfigAutoSaveStatus =
  | "idle"
  | "saving"
  | "saved"
  | "rejected"
  | "error"
  | "conflict"
  | "paused";

type RuntimeConfigGatewaySnapshot = {
  client: GatewayBrowserClient | null;
  phase: ApplicationGatewayPhase;
  sessionKey: string;
  hello?: GatewayHelloOk | null;
};

const initialConfigValue = <T>(value: T): T => value;

export function createInitialConfigState(snapshot?: Partial<RuntimeConfigGatewaySnapshot>) {
  return {
    client: snapshot?.client ?? null,
    connected: snapshot?.phase === "connected",
    applySessionKey: snapshot?.sessionKey ?? "main",
    configLoading: false,
    configRaw: "{\n}\n",
    configRawOriginal: "",
    configRawOriginalParsed: initialConfigValue<Record<string, unknown> | null>(null),
    configRawOriginalParsePending: initialConfigValue<Promise<void> | null>(null),
    configValid: initialConfigValue<boolean | null>(null),
    configIssues: initialConfigValue<unknown[]>([]),
    configSaving: false,
    configApplying: false,
    configAutoSaveStatus: initialConfigValue<ConfigAutoSaveStatus>("idle"),
    configRecoveryError: initialConfigValue<string | null>(null),
    configNeedsApply: false,
    configSnapshot: initialConfigValue<ConfigSnapshot | null>(null),
    configDraftBaseHash: initialConfigValue<string | null>(null),
    configSchema: initialConfigValue<unknown>(null),
    configSchemaVersion: initialConfigValue<string | null>(null),
    configSchemaLoading: false,
    configUiHints: initialConfigValue<ConfigUiHints>({}),
    configForm: initialConfigValue<Record<string, unknown> | null>(null),
    configFormOriginal: initialConfigValue<Record<string, unknown> | null>(null),
    configFormDirty: false,
    configFormMode: initialConfigValue<"form" | "raw">("form"),
    configSearchQuery: "",
    configActiveSection: initialConfigValue<string | null>(null),
    configActiveSubsection: initialConfigValue<string | null>(null),
    lastError: initialConfigValue<string | null>(null),
  };
}

type ProducedRuntimeConfigState = ReturnType<typeof createInitialConfigState>;
export type RuntimeConfigState = Omit<ProducedRuntimeConfigState, "configDraftBaseHash"> &
  Partial<Pick<ProducedRuntimeConfigState, "configDraftBaseHash">> & {
    chatError?: string | null;
  };

const requestVersionsByState = new WeakMap<
  RuntimeConfigState,
  { config: number; schema: number }
>();
const connectionEpochsByState = new WeakMap<object, number>();
const staleConfigSnapshots = new WeakSet<object>();
export type ConfigRead = {
  version: number;
  client: GatewayBrowserClient;
  connectionEpoch: number;
  completion: Deferred<Result<void, string>>;
  invalidated: Deferred<Result<void, string>>;
};
const configReadsByState = new WeakMap<object, ConfigRead>();

function invalidateConfigRead(state: object): void {
  const read = configReadsByState.get(state);
  configReadsByState.delete(state);
  read?.invalidated.resolve({ ok: false, error: "The configuration refresh was superseded." });
}

export function currentConfigRead(state: RuntimeConfigState): ConfigRead | undefined {
  return configReadsByState.get(state);
}

export function beginConfigRead(
  state: RuntimeConfigState,
  client: GatewayBrowserClient,
): ConfigRead {
  const read: ConfigRead = {
    version: nextRequestVersion(state, "config"),
    client,
    connectionEpoch: currentConfigConnectionEpoch(state),
    completion: createDeferredCore(),
    invalidated: createDeferredCore(),
  };
  // Register before request dispatch can synchronously start a successor read.
  configReadsByState.set(state, read);
  return read;
}

export type RuntimeConfigGateway = {
  readonly snapshot: RuntimeConfigGatewaySnapshot;
  subscribe: (listener: (snapshot: RuntimeConfigGatewaySnapshot) => void) => () => void;
};

export type LoadConfigOptions = {
  preservePendingChanges?: boolean;
  discardPendingChanges?: boolean;
};

export type ConfigGatewayClient = {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
};

type ConfigConnectionState = {
  client: ConfigGatewayClient | null;
  connected: boolean;
};

export function nextRequestVersion(state: RuntimeConfigState, key: "config" | "schema"): number {
  if (key === "config") {
    invalidateConfigRead(state);
  }
  const current = requestVersionsByState.get(state) ?? { config: 0, schema: 0 };
  const next = { ...current, [key]: current[key] + 1 };
  requestVersionsByState.set(state, next);
  return next[key];
}

export function clearConfigRequestVersions(state: RuntimeConfigState): void {
  invalidateConfigRead(state);
  requestVersionsByState.delete(state);
}

export function currentConfigConnectionEpoch(state: object): number {
  return connectionEpochsByState.get(state) ?? 0;
}

export function setConfigSnapshot(state: RuntimeConfigState, snapshot: ConfigSnapshot): void {
  state.configSnapshot = snapshot;
  staleConfigSnapshots.delete(state);
}

export function invalidateConfigConnection(state: object): void {
  staleConfigSnapshots.add(state);
  invalidateConfigRead(state);
  connectionEpochsByState.set(state, currentConfigConnectionEpoch(state) + 1);
}

export function isCurrentConfigConnection(
  state: ConfigConnectionState,
  client: ConfigGatewayClient,
  connectionEpoch: number,
): boolean {
  return (
    state.connected &&
    state.client === client &&
    currentConfigConnectionEpoch(state) === connectionEpoch
  );
}

export function isCurrentRequest(
  state: RuntimeConfigState,
  key: "config" | "schema",
  version: number,
  client: GatewayBrowserClient,
  connectionEpoch: number,
): boolean {
  return (
    isCurrentConfigConnection(state, client, connectionEpoch) &&
    requestVersionsByState.get(state)?.[key] === version
  );
}

export function resolveEditableSnapshotConfig(
  snapshot: ConfigSnapshot | null | undefined,
): Record<string, unknown> | null {
  return (
    asConfigRecord(snapshot?.sourceConfig) ??
    asConfigRecord(snapshot?.resolved) ??
    asConfigRecord(snapshot?.config)
  );
}

export function currentConfigObject(
  state: Pick<RuntimeConfigState, "configForm" | "configSnapshot">,
): Record<string, unknown> | null {
  return !staleConfigSnapshots.has(state)
    ? (state.configForm ?? resolveEditableSnapshotConfig(state.configSnapshot))
    : null;
}
export type AgentConfigEntryTarget = {
  path: ["agents", "entries", string];
  entry: Record<string, unknown>;
};

const AGENT_CONFIG_ENTRY_ID_PATTERN = /^[a-z0-9_][a-z0-9_-]{0,63}$/i;
const BLOCKED_AGENT_CONFIG_ENTRY_IDS = new Set(["__proto__", "prototype", "constructor"]);

function normalizeAgentConfigEntryId(agentId: string): string | null {
  const trimmedAgentId = agentId.trim();
  if (!AGENT_CONFIG_ENTRY_ID_PATTERN.test(trimmedAgentId)) {
    return null;
  }
  const normalizedAgentId = normalizeAgentId(trimmedAgentId);
  return BLOCKED_AGENT_CONFIG_ENTRY_IDS.has(normalizedAgentId) ? null : normalizedAgentId;
}

export function resolveAgentConfigEntryTarget(
  config: Record<string, unknown> | null,
  agentId: string,
): AgentConfigEntryTarget | null {
  const normalizedAgentId = normalizeAgentConfigEntryId(agentId);
  if (!normalizedAgentId) {
    return null;
  }
  const agents = asConfigRecord(config?.agents);
  const entries = asConfigRecord(agents?.entries);
  const authoredAgentId = Object.keys(entries ?? {}).find(
    (candidate) =>
      AGENT_CONFIG_ENTRY_ID_PATTERN.test(candidate) &&
      normalizeAgentId(candidate) === normalizedAgentId,
  );
  if (!entries || !authoredAgentId) {
    return null;
  }
  const entry = entries[authoredAgentId];
  if (!isRecord(entry)) {
    return null;
  }
  return {
    path: ["agents", "entries", authoredAgentId],
    entry,
  };
}

export function agentConfigEntry(
  state: RuntimeConfigState,
  agentId: string,
  options: { ensure?: boolean } = {},
): AgentConfigEntryTarget | null {
  const normalizedAgentId = normalizeAgentConfigEntryId(agentId);
  if (!normalizedAgentId) {
    return null;
  }
  const source = state.configForm ?? resolveEditableSnapshotConfig(state.configSnapshot);
  const existing = resolveAgentConfigEntryTarget(source, normalizedAgentId);
  if (existing) {
    return existing;
  }
  if (!options.ensure) {
    return null;
  }
  const path = ["agents", "entries", normalizedAgentId] as const;
  return { path: [...path], entry: {} };
}
