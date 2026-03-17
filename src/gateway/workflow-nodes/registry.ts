/**
 * Workflow Nodes Registry
 *
 * Central registry for all workflow node handlers
 */

import { agentPromptHandler } from "./agent-prompt.js";
import { customJSHandler } from "./custom-js.js";
import { delayHandler } from "./delay.js";
import { executeToolHandler } from "./execute-tool.js";
import { remoteInvokeHandler } from "./remote-invoke.js";
import { sendMessageHandler } from "./send-message.js";
import { ttsHandler } from "./tts.js";
import type { WorkflowNodeHandler } from "./types.js";

/**
 * Registry of all workflow node handlers
 */
export const workflowNodeRegistry: Map<string, WorkflowNodeHandler> = new Map([
  ["agent-prompt", agentPromptHandler],
  ["send-message", sendMessageHandler],
  ["execute-tool", executeToolHandler],
  ["remote-invoke", remoteInvokeHandler],
  ["tts", ttsHandler],
  ["delay", delayHandler],
  ["custom-js", customJSHandler],
]);

/**
 * Get a node handler by action type
 */
export function getNodeHandler(actionType: string): WorkflowNodeHandler | undefined {
  return workflowNodeRegistry.get(actionType);
}

/**
 * Get all registered action types
 */
export function getRegisteredActionTypes(): string[] {
  return Array.from(workflowNodeRegistry.keys());
}
