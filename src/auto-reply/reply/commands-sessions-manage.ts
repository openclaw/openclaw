import type { CommandHandler } from "./commands-types.js";
import { callGateway } from "../../gateway/call.js";
import { logVerbose } from "../../globals.js";
import { formatTimeAgo } from "../../infra/format-time/format-relative.ts";

const COMMAND = "/session";

export const handleSessionManageCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const normalized = params.command.commandBodyNormalized;
  if (!normalized.startsWith(COMMAND)) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /session from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  const rest = normalized.slice(COMMAND.length).trim();
  const [actionRaw, ...restTokens] = rest.split(/\s+/).filter(Boolean);
  const action = actionRaw?.toLowerCase();

  if (!action) {
    const help = [
      "📋 Session Management",
      "Usage:",
      "  /session new <name>  - Create a new named session",
      "  /session list        - List available sessions",
      "",
      "Named sessions are persistent and won't be reset by /new.",
    ].join("\n");
    return { shouldContinue: false, reply: { text: help } };
  }

  if (action === "new") {
    const label = restTokens.join(" ").trim();
    if (!label) {
      return {
        shouldContinue: false,
        reply: { text: "⚠️ Usage: /session new <name>" },
      };
    }

    try {
      const result = await callGateway<{
        ok: boolean;
        key: string;
        sessionId: string;
        entry: unknown;
      }>({
        method: "sessions.create",
        params: { label, persistent: true },
      });

      if (result?.ok && result.key) {
        // Build URL for webchat (try to detect if we're in webchat)
        const isWebchat = params.command.channel === "webchat";
        const switchUrl = isWebchat
          ? `${typeof window !== "undefined" ? window.location.origin : ""}?session=${result.key}`
          : null;

        const lines = [
          `✅ Created session "${label}"`,
          `Key: ${result.key}`,
          switchUrl ? `Switch: ${switchUrl}` : undefined,
          "",
          "This session is persistent and won't be reset by /new.",
        ].filter(Boolean);

        return { shouldContinue: false, reply: { text: lines.join("\n") } };
      }

      return {
        shouldContinue: false,
        reply: { text: "❌ Failed to create session." },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        shouldContinue: false,
        reply: { text: `❌ Failed to create session: ${message}` },
      };
    }
  }

  if (action === "list") {
    try {
      const result = await callGateway<{
        count: number;
        sessions: Array<{
          key: string;
          label?: string;
          persistent?: boolean;
          userCreated?: boolean;
          updatedAt?: number;
          contextTokens?: number;
        }>;
      }>({
        method: "sessions.list",
        params: { limit: 50 },
      });

      if (!result || !Array.isArray(result.sessions) || result.sessions.length === 0) {
        return {
          shouldContinue: false,
          reply: { text: "📋 No sessions found." },
        };
      }

      const currentKey = params.sessionKey || "main";
      const lines = ["📋 Available Sessions", ""];

      // Show persistent/user-created sessions first
      const userSessions = result.sessions.filter((s) => s.persistent || s.userCreated);
      const otherSessions = result.sessions.filter((s) => !s.persistent && !s.userCreated);

      if (userSessions.length > 0) {
        lines.push("Named Sessions:");
        userSessions.forEach((session) => {
          const isCurrent = session.key === currentKey;
          const badge = isCurrent ? "→ " : "  ";
          const name = session.label || session.key;
          const age = session.updatedAt
            ? formatTimeAgo(Date.now() - session.updatedAt, { fallback: "" })
            : "";
          const tokens = session.contextTokens ? ` · ${session.contextTokens} tokens` : "";
          lines.push(`${badge}${name}${age ? ` · ${age}` : ""}${tokens}`);
        });
      }

      if (otherSessions.length > 0 && otherSessions.length <= 10) {
        lines.push("");
        lines.push("Other Sessions:");
        otherSessions.forEach((session) => {
          const isCurrent = session.key === currentKey;
          const badge = isCurrent ? "→ " : "  ";
          const name = session.label || session.key;
          const age = session.updatedAt
            ? formatTimeAgo(Date.now() - session.updatedAt, { fallback: "" })
            : "";
          lines.push(`${badge}${name}${age ? ` · ${age}` : ""}`);
        });
      }

      lines.push("");
      lines.push(`Total: ${result.count} sessions`);

      return { shouldContinue: false, reply: { text: lines.join("\n") } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        shouldContinue: false,
        reply: { text: `❌ Failed to list sessions: ${message}` },
      };
    }
  }

  return { shouldContinue: false, reply: { text: "⚠️ Unknown action. Try: new, list" } };
};
