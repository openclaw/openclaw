import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { AnyAgentTool } from "../agents/tools/common.js";
import type { TelegramTotpConfig } from "../config/types.telegram.js";
import { expandToolGroups, normalizeToolName } from "../agents/tool-policy.js";
import { hasValidSession } from "./totp-store.js";

/**
 * Wraps tools that require TOTP authentication.
 * If the sender does not have a valid TOTP session, the tool will throw an error
 * prompting the user to authenticate first.
 */
export function wrapToolsWithTotpGate(
  tools: AnyAgentTool[],
  params: {
    totpConfig: TelegramTotpConfig;
    senderId: string;
  },
): AnyAgentTool[] {
  const { totpConfig, senderId } = params;
  const protectedGroups = totpConfig.protectedToolGroups;
  if (!protectedGroups || protectedGroups.length === 0) {
    return tools;
  }

  const protectedNames = new Set(expandToolGroups(protectedGroups));

  return tools.map((tool) => {
    const normalized = normalizeToolName(tool.name);
    if (!protectedNames.has(normalized)) {
      return tool;
    }
    if (!tool.execute) {
      return tool;
    }
    const originalExecute = tool.execute;
    return {
      ...tool,
      execute: async (
        toolCallId: string,
        toolParams: unknown,
        signal?: AbortSignal,
        onUpdate?: (partialResult: AgentToolResult<unknown>) => void,
      ) => {
        const valid = await hasValidSession(senderId);
        if (!valid) {
          throw new Error(
            `TOTP authentication required. Tool "${tool.name}" is protected by two-factor authentication. ` +
              "Please send your 6-digit authenticator code in the chat to create a session before using this tool.",
          );
        }
        return await originalExecute(toolCallId, toolParams, signal, onUpdate);
      },
    };
  });
}
