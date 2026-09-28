// Stores and resolves the last TUI session per workspace.
import { createHash } from "node:crypto";
import { normalizeLowercaseStringOrEmpty as normalizeMarker } from "@openclaw/normalization-core/string-coerce";
import { normalizeAgentId } from "../routing/session-key.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  executeOpenClawStateWorker,
  runOpenClawStateWorkerOperation,
} from "../state/openclaw-state-worker-store.js";
import type { TuiSessionList } from "./tui-backend.js";
import { TUI_LAST_SESSION_STATE_KEY_PREFIX } from "./tui-last-session.contract.js";
import { matchesOwnedTuiSession } from "./tui-session-events.js";
import type { SessionScope } from "./tui-types.js";

function stateDatabaseOptions(stateDir?: string) {
  return stateDir
    ? { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } }
    : { env: process.env };
}

/** Builds a stable private-store key for the current TUI connection, agent, and session scope. */
export function buildTuiLastSessionScopeKey(params: {
  connectionUrl: string;
  agentId: string;
  sessionScope: SessionScope;
}): string {
  const agentId = normalizeAgentId(params.agentId);
  const connectionUrl = params.connectionUrl.trim() || "local";
  return createHash("sha256")
    .update(`${params.sessionScope}\n${agentId}\n${connectionUrl}`)
    .digest("hex")
    .slice(0, 32);
}

function isHeartbeatSessionKey(sessionKey: string): boolean {
  return normalizeMarker(sessionKey).endsWith(":heartbeat");
}

/** Detects heartbeat/system sessions that should not become the remembered human session. */
function isHeartbeatLikeTuiSession(session: TuiSessionList["sessions"][number]): boolean {
  if (isHeartbeatSessionKey(session.key)) {
    return true;
  }
  const markers = [
    session.provider,
    session.lastProvider,
    session.lastChannel,
    session.lastTo,
    session.origin?.provider,
    session.origin?.surface,
    session.origin?.label,
  ];
  return markers.some((marker) => normalizeMarker(marker) === "heartbeat");
}

/** Reads the remembered session key for a scope from canonical shared state. */
export async function readTuiLastSessionKey(params: {
  scopeKey: string;
  stateDir?: string;
}): Promise<string | null> {
  const result = await executeExistingOpenClawStateRead(stateDatabaseOptions(params.stateDir), {
    type: "tui.lastSession.read",
    stateKey: `${TUI_LAST_SESSION_STATE_KEY_PREFIX}${params.scopeKey}`,
  });
  if (result === undefined) {
    return null;
  }
  if (!result.ok || result.type !== "tui.lastSession.read") {
    throw new Error("Unexpected remembered TUI session read result");
  }
  if (!result.row) {
    return null;
  }
  const stored: unknown = JSON.parse(result.row.value_json);
  if (typeof stored !== "string") {
    throw new Error("Remembered TUI session key must be a string");
  }
  const rememberedKey = stored.trim();
  return rememberedKey && !isHeartbeatSessionKey(rememberedKey) ? rememberedKey : null;
}

/** Writes the remembered session key unless it is empty, unknown, or heartbeat-owned. */
export async function writeTuiLastSessionKey(params: {
  scopeKey: string;
  sessionKey: string;
  stateDir?: string;
}): Promise<void> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey || sessionKey === "unknown" || isHeartbeatSessionKey(sessionKey)) {
    return;
  }
  await executeOpenClawStateWorker(
    captureOpenClawStateWorkerContext(stateDatabaseOptions(params.stateDir)),
    {
      type: "tui.lastSession.write",
      input: { stateKey: `${TUI_LAST_SESSION_STATE_KEY_PREFIX}${params.scopeKey}`, sessionKey },
    },
  );
}

/** Owns pending session-memory writes through TUI shutdown and reports the first failure. */
export function createRememberSessionKeyWriter(params: {
  buildScopeKey: (sessionKey: string) => string;
  reportFailure: (message: string) => void;
  write: typeof writeTuiLastSessionKey;
}) {
  const work = new AsyncWorkScope();
  let failureReported = false;
  return {
    remember: (sessionKey: string): Promise<void> => {
      const trimmed = sessionKey.trim();
      if (work.isClosing || !trimmed || trimmed === "unknown") {
        return Promise.resolve();
      }
      const scopeKey = params.buildScopeKey(trimmed);
      return work.track(async () => {
        try {
          await params.write({ scopeKey, sessionKey: trimmed });
        } catch (err) {
          if (!failureReported) {
            failureReported = true;
            params.reportFailure(err instanceof Error ? err.message : String(err));
          }
        }
      });
    },
    close: () => work.drain(),
  };
}

/** Removes restore pointers that target sessions retired by doctor repair. */
export async function clearTuiLastSessionPointers(params: {
  sessionKeys: ReadonlySet<string>;
  stateDir?: string;
}): Promise<number> {
  if (params.sessionKeys.size === 0) {
    return 0;
  }
  const retiredSessionKeys = [...params.sessionKeys];
  const options = stateDatabaseOptions(params.stateDir);
  const context = captureOpenClawStateWorkerContext(options);
  const result = await executeExistingOpenClawStateRead(
    options,
    {
      type: "tui.lastSession.retiredPointers",
      retiredSessionKeys,
    },
    { context },
  );
  if (result === undefined) {
    return 0;
  }
  if (!result.ok || result.type !== "tui.lastSession.retiredPointers") {
    throw new Error("Unexpected retired TUI session pointer result");
  }
  if (result.stateKeys.length === 0) {
    return 0;
  }
  return (
    (await runOpenClawStateWorkerOperation(
      context,
      (scope) =>
        scope.execute({
          type: "tui.lastSession.clear",
          input: { stateKeys: result.stateKeys, retiredSessionKeys },
        }),
      { existingOnly: true },
    )) ?? 0
  );
}

/** Resolves a remembered key to a currently listed session for the active agent. */
export function resolveRememberedTuiSessionKey(params: {
  rememberedKey: string | null | undefined;
  currentAgentId: string;
  sessions: TuiSessionList["sessions"];
}): string | null {
  const rememberedKey = params.rememberedKey?.trim();
  if (!rememberedKey) {
    return null;
  }
  if (isHeartbeatSessionKey(rememberedKey)) {
    return null;
  }
  const currentAgentId = normalizeAgentId(params.currentAgentId);
  const match = params.sessions.find(
    (session) =>
      !isHeartbeatLikeTuiSession(session) &&
      matchesOwnedTuiSession(
        rememberedKey,
        currentAgentId,
        { sessionKey: session.key },
        currentAgentId,
      ),
  );
  return match?.key ?? null;
}
