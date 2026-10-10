import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  canonicalizeMainSessionAlias,
  resolveAgentMainSessionKey,
} from "../config/sessions/main-session.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { loadSessionEntry, patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import { readSessionEntryInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  isSubagentSessionKey,
  normalizeAgentId,
  resolveAgentIdFromSessionKey,
  toAgentStoreSessionKey,
} from "../routing/session-key.js";
import { resolveMainScopedEventSessionKey } from "./event-session-routing.js";
import type { HeartbeatConfig } from "./heartbeat-config.js";

export function resolveHeartbeatSessionKey(
  cfg: OpenClawConfig,
  agentId: string,
  heartbeat?: HeartbeatConfig,
  forcedSessionKey?: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const sessionCfg = cfg.session;
  const scope = sessionCfg?.scope ?? "per-sender";
  const resolvedAgentId = normalizeAgentId(agentId);
  const mainSessionKey =
    scope === "global" ? "global" : resolveAgentMainSessionKey({ cfg, agentId: resolvedAgentId });
  const storePath = resolveSessionStorePathCore(sessionCfg?.store, {
    // A literal `global` row is global only inside the selected agent's store.
    // Falling back here leaks the default agent's route into secondary heartbeats.
    agentId: resolvedAgentId,
    env,
  });
  const selectSession = (sessionKey = mainSessionKey, suppressOriginatingContext = false) => ({
    sessionKey,
    storePath,
    suppressOriginatingContext,
  });

  if (scope === "global") {
    return selectSession();
  }

  const resolveCandidate = (requestKey: string) => {
    const candidate = toAgentStoreSessionKey({
      agentId: resolvedAgentId,
      requestKey,
      mainKey: cfg.session?.mainKey,
    });
    if (isSubagentSessionKey(candidate)) {
      return undefined;
    }
    const canonical = canonicalizeMainSessionAlias({
      cfg,
      agentId: resolvedAgentId,
      sessionKey: candidate,
    });
    return canonical !== "global" &&
      !isSubagentSessionKey(canonical) &&
      resolveAgentIdFromSessionKey(canonical) === normalizeAgentId(resolvedAgentId)
      ? canonical
      : undefined;
  };

  // Guard: never route heartbeats to subagent sessions, regardless of entry path.
  const forced = forcedSessionKey?.trim();
  if (forced && isSubagentSessionKey(forced)) {
    return selectSession(mainSessionKey, true);
  }

  const forcedCanonical = forced ? resolveCandidate(forced) : undefined;
  if (forcedCanonical) {
    return selectSession(
      resolveMainScopedEventSessionKey({
        cfg,
        sessionKey: forcedCanonical,
        agentId: resolvedAgentId,
      }) ?? forcedCanonical,
    );
  }

  const trimmed = heartbeat?.session?.trim() ?? "";
  if (!trimmed || isSubagentSessionKey(trimmed)) {
    return selectSession();
  }

  const normalized = normalizeLowercaseStringOrEmpty(trimmed);
  if (normalized === "main" || normalized === "global") {
    return selectSession();
  }

  return selectSession(resolveCandidate(trimmed) || mainSessionKey);
}

/** The heartbeat's event queue session and its stored row. */
export type ResolvedHeartbeatSession = {
  sessionKey: string;
  storePath: string;
  suppressOriginatingContext: boolean;
  entry: SessionEntry | undefined;
};

export async function resolveHeartbeatSession(
  cfg: OpenClawConfig,
  agentId: string,
  heartbeat?: HeartbeatConfig,
  forcedSessionKey?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedHeartbeatSession> {
  const resolved = resolveHeartbeatSessionKey(cfg, agentId, heartbeat, forcedSessionKey, env);
  return {
    ...resolved,
    entry: await readSessionEntryInWorker({
      agentId,
      storePath: resolved.storePath,
      sessionKey: resolved.sessionKey,
      env,
    }),
  };
}

function isHeartbeatSessionOf(sessionKey: string, baseSessionKey: string): boolean {
  return (
    sessionKey.startsWith(baseSessionKey) &&
    /^(:heartbeat)+$/.test(sessionKey.slice(baseSessionKey.length))
  );
}

function resolveIsolatedHeartbeatSessionKey(params: {
  agentId: string;
  sessionKey: string;
  configuredSessionKey: string;
  sessionEntry?: { heartbeatIsolatedBaseSessionKey?: string };
}) {
  const storedBaseSessionKey = params.sessionEntry?.heartbeatIsolatedBaseSessionKey?.trim();
  if (params.configuredSessionKey === "global") {
    // The base global row stays literal inside its agent store; its isolated sibling
    // must be agent-qualified so ordinary session writes remain canonical.
    const isolatedSessionKey = toAgentStoreSessionKey({
      agentId: params.agentId,
      requestKey: "global:heartbeat",
    });
    if (
      params.sessionKey === "global" ||
      (storedBaseSessionKey === "global" &&
        (params.sessionKey === isolatedSessionKey ||
          isHeartbeatSessionOf(params.sessionKey, isolatedSessionKey)))
    ) {
      return { isolatedSessionKey, isolatedBaseSessionKey: "global" };
    }
  }
  // Collapse repeated `:heartbeat` suffixes introduced by wake-triggered re-entry.
  // The guard on configuredSessionKey ensures we do not strip a legitimate single
  // `:heartbeat` suffix that is part of the user-configured base key itself
  // (e.g. heartbeat.session: "alerts:heartbeat"). When the configured key already
  // ends with `:heartbeat`, a forced wake passes `configuredKey:heartbeat` which
  // must be treated as a new base rather than an existing isolated key.
  let isolatedBaseSessionKey = params.sessionKey;
  if (storedBaseSessionKey && isHeartbeatSessionOf(params.sessionKey, storedBaseSessionKey)) {
    isolatedBaseSessionKey = storedBaseSessionKey;
  } else if (
    isHeartbeatSessionOf(params.sessionKey, params.configuredSessionKey) &&
    !params.configuredSessionKey.endsWith(":heartbeat")
  ) {
    isolatedBaseSessionKey = params.configuredSessionKey;
  }
  return {
    isolatedSessionKey: `${isolatedBaseSessionKey}:heartbeat`,
    isolatedBaseSessionKey,
  };
}

/** Execution key and descriptive conversation chosen for a heartbeat event queue. */
export type HeartbeatSessionSelection = ResolvedHeartbeatSession & {
  run:
    | { kind: "shared"; sessionKey: string }
    | { kind: "isolated"; sessionKey: string; baseSessionKey: string };
  conversationEntry: SessionEntry | undefined;
  inspectsRunQueue: boolean;
};

/** Selects the execution key and descriptive conversation for an already-resolved event queue. */
export function resolveHeartbeatSessionSelection(
  cfg: OpenClawConfig,
  agentId: string,
  heartbeat: HeartbeatConfig | undefined,
  session: ResolvedHeartbeatSession,
  isolated: boolean,
  env: NodeJS.ProcessEnv = process.env,
): HeartbeatSessionSelection {
  if (!isolated) {
    return {
      ...session,
      run: { kind: "shared", sessionKey: session.sessionKey },
      conversationEntry: session.entry,
      inspectsRunQueue: true,
    };
  }
  const configured = resolveHeartbeatSessionKey(cfg, agentId, heartbeat, undefined, env);
  const { isolatedSessionKey, isolatedBaseSessionKey } = resolveIsolatedHeartbeatSessionKey({
    agentId,
    sessionKey: session.sessionKey,
    configuredSessionKey: configured.sessionKey,
    sessionEntry: session.entry,
  });
  return {
    ...session,
    run: {
      kind: "isolated",
      sessionKey: isolatedSessionKey,
      baseSessionKey: isolatedBaseSessionKey,
    },
    conversationEntry:
      isolatedBaseSessionKey === session.sessionKey
        ? session.entry
        : loadSessionEntry({
            agentId,
            storePath: session.storePath,
            sessionKey: isolatedBaseSessionKey,
            env,
          }),
    // Legacy isolated queues retain their route after the execution key is canonicalized.
    inspectsRunQueue: session.sessionKey !== isolatedBaseSessionKey,
  };
}

export function resolveStaleHeartbeatIsolatedSessionKey(params: {
  sessionKey: string;
  isolatedSessionKey: string;
  isolatedBaseSessionKey: string;
}) {
  if (params.sessionKey === params.isolatedSessionKey) {
    return undefined;
  }
  return isHeartbeatSessionOf(params.sessionKey, params.isolatedBaseSessionKey)
    ? params.sessionKey
    : undefined;
}

export async function restoreHeartbeatUpdatedAt(params: {
  agentId: string;
  storePath: string;
  sessionKey: string;
  updatedAt?: number;
}) {
  const { updatedAt, ...scope } = params;
  if (typeof updatedAt !== "number") {
    return;
  }
  const entry = loadSessionEntry(scope);
  if (!entry || entry.updatedAt === Math.max(entry.updatedAt ?? 0, updatedAt)) {
    return;
  }
  await patchSessionEntryCore(
    scope,
    (nextEntry, context) => {
      const resolvedUpdatedAt = Math.max(nextEntry.updatedAt ?? 0, updatedAt);
      return context.existingEntry && nextEntry.updatedAt !== resolvedUpdatedAt
        ? { ...nextEntry, updatedAt: resolvedUpdatedAt }
        : null;
    },
    { replaceEntry: true },
  );
}
