import { listAgentIds, resolveDefaultAgentId } from "../agents/agent-scope.js";
import {
  resolveAgentMainSessionKey,
  updateSessionStoreEntry,
  type SessionEntry,
} from "../config/sessions.js";
import type { AgentEventPayload } from "../infra/agent-events.js";
import { DEFAULT_AGENT_ID, parseAgentSessionKey } from "../routing/session-key.js";
import { loadSessionEntry } from "./session-utils.js";
import type { GatewaySessionRow, SessionRunStatus } from "./session-utils.types.js";

type LifecyclePhase = "start" | "end" | "error";

type LifecycleEventLike = Pick<AgentEventPayload, "ts"> &
  Partial<Pick<AgentEventPayload, "runId">> & {
    data?: {
      phase?: unknown;
      startedAt?: unknown;
      endedAt?: unknown;
      aborted?: unknown;
      stopReason?: unknown;
    };
  };

type LifecycleSessionShape = Pick<
  GatewaySessionRow,
  "updatedAt" | "status" | "startedAt" | "endedAt" | "runtimeMs" | "abortedLastRun"
>;

type PersistedLifecycleSessionShape = Pick<
  SessionEntry,
  | "updatedAt"
  | "status"
  | "startedAt"
  | "endedAt"
  | "runtimeMs"
  | "abortedLastRun"
  | "lifecycleRunId"
>;

type GatewaySessionLifecycleSnapshot = Partial<LifecycleSessionShape>;
type LifecycleStoreTargetCandidate = { sessionKey: string; updatedAt: number };

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function resolveLifecyclePhase(event: LifecycleEventLike): LifecyclePhase | null {
  const phase = typeof event.data?.phase === "string" ? event.data.phase : "";
  return phase === "start" || phase === "end" || phase === "error" ? phase : null;
}

function resolveLifecycleRunId(event: LifecycleEventLike): string | undefined {
  const runId = typeof event.runId === "string" ? event.runId.trim() : "";
  return runId || undefined;
}

function resolveTerminalStatus(event: LifecycleEventLike): SessionRunStatus {
  const phase = resolveLifecyclePhase(event);
  if (phase === "error") {
    return "failed";
  }

  const stopReason = typeof event.data?.stopReason === "string" ? event.data.stopReason : "";
  if (stopReason === "aborted") {
    return "killed";
  }

  return event.data?.aborted === true ? "timeout" : "done";
}

function resolveLifecycleStartPhaseStartedAt(event: LifecycleEventLike): number | undefined {
  if (isFiniteTimestamp(event.data?.startedAt)) {
    return event.data.startedAt;
  }
  return isFiniteTimestamp(event.ts) ? event.ts : undefined;
}

function resolveTerminalLifecycleStartedAt(
  existingStartedAt: number | undefined,
  event: LifecycleEventLike,
): number | undefined {
  if (isFiniteTimestamp(event.data?.startedAt)) {
    return event.data.startedAt;
  }
  if (isFiniteTimestamp(existingStartedAt)) {
    return existingStartedAt;
  }
  return undefined;
}

function resolveLifecycleEndedAt(event: LifecycleEventLike): number | undefined {
  if (isFiniteTimestamp(event.data?.endedAt)) {
    return event.data.endedAt;
  }
  return isFiniteTimestamp(event.ts) ? event.ts : undefined;
}

function isTerminalSessionStatus(status: unknown): boolean {
  return status === "done" || status === "failed" || status === "killed" || status === "timeout";
}

function resolveStoredTerminalAt(
  entry?: Partial<PersistedLifecycleSessionShape> | null,
): number | undefined {
  if (!entry || !isTerminalSessionStatus(entry.status)) {
    return undefined;
  }
  if (isFiniteTimestamp(entry.endedAt)) {
    return entry.endedAt;
  }
  return isFiniteTimestamp(entry.updatedAt) ? entry.updatedAt : undefined;
}

function terminalEventPredatesStoredRun(params: {
  entry?: Partial<PersistedLifecycleSessionShape> | null;
  event: LifecycleEventLike;
}): boolean {
  const phase = resolveLifecyclePhase(params.event);
  if (phase !== "end" && phase !== "error") {
    return false;
  }
  const entryRunId = params.entry?.lifecycleRunId?.trim();
  const eventRunId = resolveLifecycleRunId(params.event);
  const entryStartedAt = isFiniteTimestamp(params.entry?.startedAt)
    ? params.entry.startedAt
    : undefined;
  const eventStartedAt = isFiniteTimestamp(params.event.data?.startedAt)
    ? params.event.data.startedAt
    : undefined;
  const eventEndedAt = resolveLifecycleEndedAt(params.event);
  if (entryRunId && eventRunId && entryRunId !== eventRunId) {
    if (eventStartedAt !== undefined && entryStartedAt !== undefined) {
      return eventStartedAt <= entryStartedAt;
    }
    const entryTerminalAt = resolveStoredTerminalAt(params.entry);
    if (entryTerminalAt !== undefined && eventEndedAt !== undefined) {
      return eventEndedAt <= entryTerminalAt;
    }
    return entryStartedAt !== undefined;
  }
  if (entryRunId && eventRunId && entryRunId === eventRunId) {
    const entryTerminalAt = resolveStoredTerminalAt(params.entry);
    if (
      entryTerminalAt !== undefined &&
      eventEndedAt !== undefined &&
      eventEndedAt < entryTerminalAt
    ) {
      return true;
    }
  }
  if (entryStartedAt === undefined) {
    return false;
  }
  if (eventStartedAt !== undefined) {
    return eventStartedAt < entryStartedAt;
  }
  return eventEndedAt !== undefined && eventEndedAt < entryStartedAt;
}

function shouldReuseStoredLifecycleTiming(params: {
  entry?: Partial<PersistedLifecycleSessionShape> | null;
  event: LifecycleEventLike;
}): boolean {
  const phase = resolveLifecyclePhase(params.event);
  if (phase !== "end" && phase !== "error") {
    return true;
  }
  const entryRunId = params.entry?.lifecycleRunId?.trim();
  const eventRunId = resolveLifecycleRunId(params.event);
  return !(entryRunId && eventRunId && entryRunId !== eventRunId);
}

function resolveRuntimeMs(params: {
  startedAt?: number;
  endedAt?: number;
  existingRuntimeMs?: number;
}): number | undefined {
  const { startedAt, endedAt, existingRuntimeMs } = params;
  if (isFiniteTimestamp(startedAt) && isFiniteTimestamp(endedAt)) {
    return Math.max(0, endedAt - startedAt);
  }
  if (
    typeof existingRuntimeMs === "number" &&
    Number.isFinite(existingRuntimeMs) &&
    existingRuntimeMs >= 0
  ) {
    return existingRuntimeMs;
  }
  return undefined;
}

export function deriveGatewaySessionLifecycleSnapshot(params: {
  session?: Partial<LifecycleSessionShape> | null;
  event: LifecycleEventLike;
}): GatewaySessionLifecycleSnapshot {
  const phase = resolveLifecyclePhase(params.event);
  if (!phase) {
    return {};
  }

  const existing = params.session ?? undefined;
  if (phase === "start") {
    const startedAt = resolveLifecycleStartPhaseStartedAt(params.event);
    const updatedAt = startedAt ?? existing?.updatedAt;
    return {
      updatedAt,
      status: "running",
      startedAt,
      endedAt: undefined,
      runtimeMs: undefined,
      abortedLastRun: false,
    };
  }

  const startedAt = resolveTerminalLifecycleStartedAt(existing?.startedAt, params.event);
  const endedAt = resolveLifecycleEndedAt(params.event);
  const updatedAt = endedAt ?? existing?.updatedAt;
  return {
    updatedAt,
    status: resolveTerminalStatus(params.event),
    startedAt,
    endedAt,
    runtimeMs: resolveRuntimeMs({
      startedAt,
      endedAt,
      existingRuntimeMs: existing?.runtimeMs,
    }),
    abortedLastRun: resolveTerminalStatus(params.event) === "killed",
  };
}

export function derivePersistedSessionLifecyclePatch(params: {
  entry?: Partial<PersistedLifecycleSessionShape> | null;
  event: LifecycleEventLike;
}): Partial<PersistedLifecycleSessionShape> {
  const phase = resolveLifecyclePhase(params.event);
  if (terminalEventPredatesStoredRun(params)) {
    return {};
  }
  const session = shouldReuseStoredLifecycleTiming(params) ? params.entry : undefined;
  const snapshot = deriveGatewaySessionLifecycleSnapshot({
    session,
    event: params.event,
  });
  const lifecycleRunId = resolveLifecycleRunId(params.event);
  return {
    ...snapshot,
    updatedAt: typeof snapshot.updatedAt === "number" ? snapshot.updatedAt : undefined,
    ...(phase && lifecycleRunId ? { lifecycleRunId } : {}),
  };
}

function resolveLegacyMainLifecycleStoreTarget(params: {
  canonicalKey: string;
  cfg: ReturnType<typeof loadSessionEntry>["cfg"];
  store: ReturnType<typeof loadSessionEntry>["store"];
}): LifecycleStoreTargetCandidate | undefined {
  const parsed = parseAgentSessionKey(params.canonicalKey);
  if (!parsed) {
    return undefined;
  }
  const mainKey = resolveAgentMainSessionKey({ cfg: params.cfg, agentId: parsed.agentId });
  if (params.canonicalKey !== mainKey) {
    return undefined;
  }
  const candidates = new Set([
    `agent:${parsed.agentId}:main`,
    `agent:${parsed.agentId}:${parsed.rest}`,
  ]);
  if (parsed.agentId === resolveDefaultAgentId(params.cfg)) {
    candidates.add("main");
    candidates.add(parsed.rest);
  }
  if (
    parsed.agentId === resolveDefaultAgentId(params.cfg) &&
    !listAgentIds(params.cfg).includes(DEFAULT_AGENT_ID)
  ) {
    candidates.add(`agent:${DEFAULT_AGENT_ID}:main`);
    candidates.add(`agent:${DEFAULT_AGENT_ID}:${parsed.rest}`);
  }
  let freshest: LifecycleStoreTargetCandidate | undefined;
  const consider = (key: string) => {
    const entry = params.store[key];
    if (!entry) {
      return;
    }
    const updatedAt = entry.updatedAt ?? 0;
    if (!freshest || updatedAt > freshest.updatedAt) {
      freshest = { sessionKey: key, updatedAt };
    }
  };

  for (const candidate of candidates) {
    consider(candidate);
    const folded = candidate.toLowerCase();
    for (const key of Object.keys(params.store)) {
      if (key.toLowerCase() === folded) {
        consider(key);
      }
    }
  }
  return freshest;
}

export function resolveGatewaySessionLifecycleStoreTarget(params: {
  sessionKey: string;
}): { storePath: string; sessionKey: string } | undefined {
  const sessionEntry = loadSessionEntry(params.sessionKey);
  const matchedTarget = sessionEntry.entry
    ? {
        sessionKey: sessionEntry.legacyKey ?? sessionEntry.canonicalKey,
        updatedAt: sessionEntry.entry.updatedAt ?? 0,
      }
    : undefined;
  const legacyMainTarget = resolveLegacyMainLifecycleStoreTarget({
    canonicalKey: sessionEntry.canonicalKey,
    cfg: sessionEntry.cfg,
    store: sessionEntry.store,
  });
  const target =
    legacyMainTarget && (!matchedTarget || legacyMainTarget.updatedAt > matchedTarget.updatedAt)
      ? legacyMainTarget
      : matchedTarget;
  if (!target) {
    return undefined;
  }
  return { storePath: sessionEntry.storePath, sessionKey: target.sessionKey };
}

export async function persistGatewaySessionLifecycleEvent(params: {
  sessionKey: string;
  event: LifecycleEventLike;
}): Promise<boolean> {
  const phase = resolveLifecyclePhase(params.event);
  if (!phase) {
    return false;
  }

  const target = resolveGatewaySessionLifecycleStoreTarget({ sessionKey: params.sessionKey });
  if (!target) {
    return false;
  }

  let applied = false;
  await updateSessionStoreEntry({
    storePath: target.storePath,
    sessionKey: target.sessionKey,
    update: async (entry) => {
      const patch = derivePersistedSessionLifecyclePatch({
        entry,
        event: params.event,
      });
      if (Object.keys(patch).length === 0) {
        return null;
      }
      applied = true;
      return patch;
    },
  });
  return applied;
}
