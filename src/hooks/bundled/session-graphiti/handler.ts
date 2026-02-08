/**
 * Session Graphiti hook handler
 *
 * Stores recent conversation snippets in JSONL for Graphiti sync.
 */

import type { OpenClawConfig } from "../../../config/config.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { HookHandler } from "../../hooks.js";
import {
  resolveAgentIdFromSessionKey,
  resolveAgentWorkspaceDir,
} from "../../../agents/agent-scope.js";
import { DEFAULT_AGENT_WORKSPACE_DIR } from "../../../agents/workspace.js";
import { recordConversationMemory } from "../../../memory/conversation-journal.js";
import { resolveHookConfig } from "../../config.js";

const DEFAULT_MESSAGE_LIMIT = 12;
const SUPPORTED_ACTIONS = new Set(["new", "reset", "stop"]);

const storeConversationForGraphiti: HookHandler = async (event) => {
  if (event.type !== "command" || !SUPPORTED_ACTIONS.has(event.action)) {
    return;
  }

  const context = event.context || {};
  const cfg = context.cfg as OpenClawConfig | undefined;
  const agentId = resolveAgentIdFromSessionKey(event.sessionKey);

  const hookConfig = resolveHookConfig(cfg, "session-graphiti");
  const messageLimit =
    typeof hookConfig?.messages === "number" && hookConfig.messages > 0
      ? hookConfig.messages
      : DEFAULT_MESSAGE_LIMIT;

  const sessionEntry = (
    event.action === "stop"
      ? context.sessionEntry
      : (context.previousSessionEntry ?? context.sessionEntry)
  ) as SessionEntry | undefined;

  if (!sessionEntry?.sessionId) {
    console.warn("[session-graphiti] Missing session entry for action", event.action);
    return;
  }

  const workspaceDir =
    typeof context.workspaceDir === "string"
      ? context.workspaceDir
      : cfg
        ? resolveAgentWorkspaceDir(cfg, agentId)
        : DEFAULT_AGENT_WORKSPACE_DIR;

  try {
    const result = await recordConversationMemory({
      sessionEntry,
      sessionKey: event.sessionKey,
      agentId,
      eventAction: event.action,
      commandSource: context.commandSource as string | undefined,
      workspaceDir,
      messageLimit,
    });

    if (result.recorded) {
      console.log(`[session-graphiti] Stored conversation for ${sessionEntry.sessionId}`);
    }
  } catch (err) {
    console.error(
      "[session-graphiti] Failed to store conversation:",
      err instanceof Error ? err.message : String(err),
    );
  }
};

export default storeConversationForGraphiti;
