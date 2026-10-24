import { note } from "../../packages/terminal-core/src/note.js";
import { resolveAgentMainSessionKey } from "../config/sessions/main-session.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ExistingAgentDatabaseTarget } from "../infra/session-sqlite-migration-readers.js";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../routing/session-key.js";
import { repairCanonicalSessionEntries } from "./doctor-session-delivery-state.js";

/**
 * Return whether a row is provably a dashboard root that sessions.create would
 * now record as a direct chat, so it can receive the stamp it missed.
 *
 * The rule mirrors the creation-time dashboard-root condition from durable
 * facts only: operator-created, a generated `dashboard:` key, grouped under its
 * agent's main session, no external delivery route, and no spawn, fork, plugin
 * owner or incognito boundary.
 * Channel and group sessions are created via `channel`, never `operator`, and
 * never use a dashboard key, so they cannot match. Rows from before dashboard
 * roots were grouped under main lack the parent link and stay unstamped.
 */
export function isUnstampedDashboardRoot(
  entry: SessionEntry,
  sessionKey: string,
  cfg: OpenClawConfig,
): boolean {
  if (entry.chatType !== undefined || entry.createdVia !== "operator") {
    return false;
  }
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed?.rest.startsWith("dashboard:") || isIncognitoSessionKey(sessionKey)) {
    return false;
  }
  if (entry.incognito || entry.spawnedBy || entry.forkSource || entry.pluginOwnerId) {
    return false;
  }
  // A row bound to an external channel route is never relabeled from its creation stamp.
  if (entry.delivery?.kind === "external") {
    return false;
  }
  return entry.parentSessionKey === resolveAgentMainSessionKey({ cfg, agentId: parsed.agentId });
}

/** Record dashboard roots created before creation-time stamping as direct chats. */
export function repairLegacyDashboardChatTypes(params: {
  apply: boolean;
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  targets?: readonly ExistingAgentDatabaseTarget[];
  integrityCheck?: "quick" | "full";
}) {
  const sessionKeys: string[] = [];
  const report = repairCanonicalSessionEntries({
    ...params,
    updateDeliveryProjection: false,
    transform(entry, sessionKey, phase) {
      if (!isUnstampedDashboardRoot(entry, sessionKey, params.cfg)) {
        return entry;
      }
      if (phase === (params.apply ? "repair" : "scan")) {
        sessionKeys.push(sessionKey);
      }
      return { ...entry, chatType: "direct" };
    },
  });
  // Messages are published after the rewrite transactions commit.
  if (sessionKeys.length > 0) {
    const verb = params.apply ? "Recorded" : "Would record";
    note(
      [
        `- ${verb} ${sessionKeys.length} dashboard chat(s) as direct chats so their linked automations can use memory:`,
        ...sessionKeys.map((key) => `  - ${key}`),
        ...(params.apply ? [] : ['- Run "openclaw doctor --fix" to record them.']),
      ].join("\n"),
      "Session chat type",
    );
  }
  return report;
}
