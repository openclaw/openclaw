/**
 * Prepares the Watched Sessions system-prompt section (openclaw#114797).
 *
 * Ambient group watches make same-agent group sessions readable from the main
 * session, but the model only acts on that when the prompt names them. Prepare
 * runs before synchronous prompt assembly, mirroring prepareAgentMemoryPrompt.
 */
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { loadExactSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import { withSessionStoreReaderInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { resolveStateDir } from "../config/state-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { deriveSessionTitle } from "../gateway/session-utils-core.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import { resolveSandboxSessionToolsVisibility } from "../plugin-sdk/session-visibility.js";
import { buildAgentMainSessionKey, parseAgentSessionKey } from "../routing/session-key.js";
import { prepareAmbientGroupWatchTargetsRead } from "../sessions/session-state-events.ambient-read.js";
import { listAmbientGroupWatchTargets } from "../sessions/session-state-events.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { sanitizeForPromptLiteral } from "./sanitize-for-prompt.js";

/** Watched-session facts resolved before synchronous prompt assembly. */
export type PreparedWatchedSessionsPrompt = {
  /** Key-sorted capped rows; deterministic bytes keep the prompt cache stable. */
  sessions: Array<{ key: string; title?: string }>;
  /** Watch targets beyond the row cap; rendered as an overflow note. */
  hiddenCount: number;
  /** Granted read tools the section may name, in render order. */
  readToolNames: string[];
  listToolAvailable: boolean;
};

// Caps prompt bytes for pathological watch counts; the render notes the overflow.
const WATCHED_SESSIONS_PROMPT_LIMIT = 20;
// Titles are external group names; clamp so one hostile rename cannot bloat the prompt.
const WATCHED_SESSION_TITLE_MAX_CHARS = 80;

const WATCHED_SESSION_READ_TOOLS = ["sessions_history", "sessions_search"];

type WatchedSessionsPromptParams = {
  enabled: boolean;
  config?: OpenClawConfig;
  sessionKey?: string;
  sandboxed?: boolean;
  toolNames: Iterable<string>;
  capabilityToolNames?: Iterable<string>;
};

function resolveWatchedSessionsPromptAccess(params: WatchedSessionsPromptParams) {
  const sessionKey = params.sessionKey?.trim();
  if (!params.enabled || !sessionKey) {
    return undefined;
  }
  // Ambient watch cursors are written only for buildAgentMainSessionKey watchers
  // (registerMainSessionGroupWatch), so any other session key can skip the probe.
  const parsedKey = parseAgentSessionKey(sessionKey);
  if (!parsedKey || buildAgentMainSessionKey({ agentId: parsedKey.agentId }) !== sessionKey) {
    return undefined;
  }
  // Sandboxed sessions with the default "spawned" clamp list/read only spawned
  // rows, so the section would advertise reads that context cannot make. The
  // "all" clamp lifts that restriction and keeps the section.
  if (params.sandboxed && resolveSandboxSessionToolsVisibility(params.config ?? {}) === "spawned") {
    return undefined;
  }
  const availableTools = new Set(
    [...params.toolNames, ...(params.capabilityToolNames ?? [])]
      .map((tool) => tool.trim().toLowerCase())
      .filter(Boolean),
  );
  const readToolNames = WATCHED_SESSION_READ_TOOLS.filter((tool) => availableTools.has(tool));
  if (readToolNames.length === 0) {
    return undefined;
  }
  return {
    sessionKey,
    agentId: parsedKey.agentId,
    readToolNames,
    listToolAvailable: availableTools.has("sessions_list"),
  };
}

function watchedSessionRow(key: string, entry?: SessionEntry) {
  const row: { key: string; title?: string } = { key };
  const title = deriveSessionTitle(entry);
  if (title) {
    row.title = truncateUtf16Safe(title, WATCHED_SESSION_TITLE_MAX_CHARS);
  }
  return row;
}

/** Released synchronous SDK compatibility; bundled runtimes use the async preparer. */
export function prepareWatchedSessionsPrompt(
  params: WatchedSessionsPromptParams,
): PreparedWatchedSessionsPrompt | undefined {
  const access = resolveWatchedSessionsPromptAccess(params);
  if (!access) {
    return undefined;
  }
  // Sorted by key, not recency: recency-ordered rows would reshuffle prompt
  // bytes on every group message and defeat provider prompt caching.
  const targets = [...listAmbientGroupWatchTargets(access.sessionKey)].toSorted();
  if (targets.length === 0) {
    return undefined;
  }
  const sessions = targets.slice(0, WATCHED_SESSIONS_PROMPT_LIMIT).map((key) => {
    // Exact persisted-key probe: watch cursors store canonical keys, so the
    // alias-resolving loader's full-snapshot scan is wasted work here.
    const entry = loadExactSessionEntryReadOnly({ sessionKey: key, clone: false })?.entry;
    return watchedSessionRow(key, entry);
  });
  return {
    sessions,
    hiddenCount: targets.length - sessions.length,
    readToolNames: access.readToolNames,
    listToolAvailable: access.listToolAvailable,
  };
}

/** Resolve durable watched-session facts without executing SQL on the caller thread. */
export async function prepareWatchedSessionsPromptAsync(
  params: WatchedSessionsPromptParams & { assertCurrent: () => void },
): Promise<PreparedWatchedSessionsPrompt | undefined> {
  const input = {
    ...params,
    toolNames: [...params.toolNames],
    capabilityToolNames: [...(params.capabilityToolNames ?? [])],
  };
  const access = resolveWatchedSessionsPromptAccess(input);
  if (!access) {
    return undefined;
  }
  const assertCallerCurrent = params.assertCurrent;
  assertCallerCurrent();
  const env = cloneEnvWithPlatformSemantics(process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const storePath = resolveOpenClawAgentSqlitePath({ agentId: access.agentId, env });
  const identity = readDatabasePathIdentitySync(storePath);
  const assertCurrent = () => {
    assertCallerCurrent();
    const current = readDatabasePathIdentitySync(storePath);
    if (
      current.key !== identity.key ||
      current.birthtime !== identity.birthtime ||
      current.canonicalPath !== identity.canonicalPath
    ) {
      throw new Error("Watched-session title store changed during preparation");
    }
  };
  const watches = prepareAmbientGroupWatchTargetsRead(access.sessionKey, { env });
  try {
    const targets = [...new Set(await watches.read())].toSorted();
    assertCurrent();
    if (targets.length === 0) {
      return undefined;
    }
    const prepared = await withSessionStoreReaderInWorker(
      {
        agentId: access.agentId,
        storePath,
        env,
      },
      async ({ reader, database, continuation, assertCurrent: assertStoreCurrent }) => {
        const keys = targets.slice(0, WATCHED_SESSIONS_PROMPT_LIMIT);
        const result = await reader.readExactEntries({
          sessionKeys: keys,
          projection: "list",
          env: database.env,
          continuation,
        });
        assertStoreCurrent();
        assertCurrent();
        // Watch cursors grant disclosure. A removed/replaced watch while titles
        // were loading must not escape as stale prompt facts.
        const currentTargets = [...new Set(await watches.read())].toSorted();
        assertStoreCurrent();
        watches.assertCurrent();
        assertCurrent();
        if (
          currentTargets.length !== targets.length ||
          currentTargets.some((key, index) => key !== targets[index]) ||
          !watches.isCurrent() ||
          !resolveWatchedSessionsPromptAccess(input)
        ) {
          return undefined;
        }
        const entries = new Map(result.entries.map(({ sessionKey, entry }) => [sessionKey, entry]));
        return {
          sessions: keys.map((key) => watchedSessionRow(key, entries.get(key))),
          hiddenCount: targets.length - keys.length,
          readToolNames: access.readToolNames,
          listToolAvailable: access.listToolAvailable,
        };
      },
      { backing: true, dataOnly: true },
    );
    watches.assertCurrent();
    assertCurrent();
    return watches.isCurrent() && resolveWatchedSessionsPromptAccess(input) ? prepared : undefined;
  } finally {
    watches.release();
  }
}

/** Renders the shared Watched Sessions block used by every prompt-assembly surface. */
export function buildWatchedSessionsPromptLines(
  prepared?: PreparedWatchedSessionsPrompt,
): string[] {
  if (!prepared || prepared.sessions.length === 0) {
    return [];
  }
  const listHint = prepared.listToolAvailable ? "; rows appear in sessions_list" : "";
  return [
    "## Watched Sessions",
    `Group/topic sessions this session ambiently watches. Readable now (read-only) via ${prepared.readToolNames.join("/")}${listHint}.`,
    ...prepared.sessions.map((session) => {
      const title = session.title ? ` — ${sanitizeForPromptLiteral(session.title)}` : "";
      return `- ${sanitizeForPromptLiteral(session.key)}${title}`;
    }),
    ...(prepared.hiddenCount > 0
      ? [
          prepared.listToolAvailable
            ? `(+${prepared.hiddenCount} more: sessions_list kinds=["group"].)`
            : `(+${prepared.hiddenCount} more.)`,
        ]
      : []),
    "",
  ];
}
