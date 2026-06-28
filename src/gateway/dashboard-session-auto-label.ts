// Auto-generates dashboard session labels from the first Control UI user message.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentDir } from "../agents/agent-scope.js";
import { generateConversationLabel } from "../auto-reply/reply/conversation-label-generator.js";
import { updateSessionStore } from "../config/sessions.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logVerbose } from "../globals.js";
import { parseSessionLabel } from "../sessions/session-label.js";
import { emitSessionsChanged } from "./server-methods/session-change-event.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

export const DASHBOARD_SESSION_AUTO_LABEL_PROMPT =
  "Generate a very short session title (2-6 words, max 30 chars) based on the user's message below. No emoji. Use the same language as the message. Be concise and descriptive. Return ONLY the title, nothing else.";

export const DASHBOARD_SESSION_AUTO_LABEL_MAX_LENGTH = 30;

export function isDashboardSessionKey(sessionKey: string): boolean {
  return /^agent:[^:]+:dashboard:[^:]+$/.test(sessionKey);
}

export function shouldAutoLabelDashboardSession(params: {
  sessionKey: string;
  entry?: SessionEntry;
  userMessage: string;
}): boolean {
  if (!isDashboardSessionKey(params.sessionKey)) {
    return false;
  }
  if (normalizeOptionalString(params.entry?.label)) {
    return false;
  }
  return Boolean(params.userMessage.trim());
}

type DashboardAutoLabelWriteResult =
  | { ok: true; label: string }
  | {
      ok: false;
      reason: "missing-entry" | "already-labeled" | "duplicate-label" | "invalid-label";
    };

export function scheduleDashboardSessionAutoLabel(params: {
  cfg: OpenClawConfig;
  context: Pick<
    GatewayRequestContext,
    | "broadcastToConnIds"
    | "chatAbortControllers"
    | "getRuntimeConfig"
    | "getSessionEventSubscriberConnIds"
  >;
  sessionKey: string;
  agentId: string;
  storePath: string | undefined;
  entry?: SessionEntry;
  userMessage: string;
}): void {
  if (
    !shouldAutoLabelDashboardSession({
      sessionKey: params.sessionKey,
      entry: params.entry,
      userMessage: params.userMessage,
    })
  ) {
    return;
  }
  if (!params.storePath) {
    return;
  }

  const storePath = params.storePath;
  const sessionKey = params.sessionKey;
  const userMessage = params.userMessage.trim().slice(0, 500);

  void (async () => {
    try {
      const generated = await generateConversationLabel({
        userMessage,
        prompt: DASHBOARD_SESSION_AUTO_LABEL_PROMPT,
        cfg: params.cfg,
        agentId: params.agentId,
        agentDir: resolveAgentDir(params.cfg, params.agentId),
        maxLength: DASHBOARD_SESSION_AUTO_LABEL_MAX_LENGTH,
      });
      if (!generated) {
        logVerbose("dashboard-session-auto-label: LLM returned empty label");
        return;
      }

      const validated = parseSessionLabel(generated);
      if (!validated.ok) {
        logVerbose(`dashboard-session-auto-label: invalid label: ${validated.error}`);
        return;
      }

      const result = await updateSessionStore<DashboardAutoLabelWriteResult>(
        storePath,
        (store) => {
          const entry = store[sessionKey];
          if (!entry) {
            return { ok: false, reason: "missing-entry" };
          }
          if (normalizeOptionalString(entry.label)) {
            return { ok: false, reason: "already-labeled" };
          }
          for (const [key, other] of Object.entries(store)) {
            if (key !== sessionKey && other?.label === validated.label) {
              return { ok: false, reason: "duplicate-label" };
            }
          }
          entry.label = validated.label;
          entry.updatedAt = Math.max(entry.updatedAt ?? 0, Date.now());
          store[sessionKey] = entry;
          return { ok: true, label: validated.label };
        },
        {
          skipSaveWhenResult: (value) => !value.ok,
        },
      );

      if (!result.ok) {
        if (result.reason !== "already-labeled") {
          logVerbose(`dashboard-session-auto-label: skipped (${result.reason})`);
        }
        return;
      }

      emitSessionsChanged(params.context, {
        sessionKey,
        agentId: params.agentId,
        reason: "patch",
      });
      logVerbose(`dashboard-session-auto-label: set label "${result.label}"`);
    } catch (err) {
      logVerbose(
        `dashboard-session-auto-label: failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  })();
}
