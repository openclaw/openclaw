import type { ClawdbotConfig } from "../../config/config.js";
import { loadConfig } from "../../config/config.js";
import { logVerbose } from "../../globals.js";
import { normalizeAccountId } from "../../routing/session-key.js";
import type { AnyAgentTool } from "./common.js";
import { handleSlackAction } from "./slack-actions.js";
import { SlackToolSchema } from "./slack-schema.js";

type SlackToolOptions = {
  agentAccountId?: string;
  config?: ClawdbotConfig;
  /** Current channel ID for auto-threading. */
  currentChannelId?: string;
  /** Current thread timestamp for auto-threading. */
  currentThreadTs?: string;
  /** Reply-to mode for auto-threading. */
  replyToMode?: "off" | "first" | "all";
  /** Mutable ref to track if a reply was sent (for "first" mode). */
  hasRepliedRef?: { value: boolean };
};

function resolveAgentAccountId(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return normalizeAccountId(trimmed);
}

function resolveConfiguredAccountId(
  cfg: ClawdbotConfig,
  accountId: string,
): string | undefined {
  if (accountId === "default") return accountId;
  const accounts = cfg.slack?.accounts;
  if (!accounts || typeof accounts !== "object") return undefined;
  if (accountId in accounts) return accountId;
  const match = Object.keys(accounts).find(
    (key) => key.toLowerCase() === accountId.toLowerCase(),
  );
  return match;
}

function hasAccountId(params: Record<string, unknown>): boolean {
  const raw = params.accountId;
  if (typeof raw !== "string") return false;
  return raw.trim().length > 0;
}

export function createSlackTool(options?: SlackToolOptions): AnyAgentTool {
  const agentAccountId = resolveAgentAccountId(options?.agentAccountId);
  return {
    label: "Slack",
    name: "slack",
    description: "Manage Slack messages, reactions, and pins.",
    parameters: SlackToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const cfg = options?.config ?? loadConfig();
      const resolvedAccountId = agentAccountId
        ? resolveConfiguredAccountId(cfg, agentAccountId)
        : undefined;
      const resolvedParams =
        resolvedAccountId && !hasAccountId(params)
          ? { ...params, accountId: resolvedAccountId }
          : params;
      if (hasAccountId(resolvedParams)) {
        const action =
          typeof params.action === "string" ? params.action : "unknown";
        logVerbose(
          `slack tool: action=${action} accountId=${String(
            resolvedParams.accountId,
          ).trim()}`,
        );
      }
      return await handleSlackAction(resolvedParams, cfg, {
        currentChannelId: options?.currentChannelId,
        currentThreadTs: options?.currentThreadTs,
        replyToMode: options?.replyToMode,
        hasRepliedRef: options?.hasRepliedRef,
      });
    },
  };
}
