/**
 * UserPromptSubmit hook execution for reply pipeline.
 *
 * Executes configured shell hooks before the agent processes user messages.
 * Hook stdout is collected and can be appended to agent context.
 * If a hook denies (exit code 2), returns a deny result.
 */

import type { OpenClawConfig } from "../../config/config.js";
import { logVerbose } from "../../globals.js";
import { getConfiguredHooks } from "../../hooks/agent-hooks-config.js";
import { executeShellHooksSequential } from "../../hooks/shell-hooks.js";

/**
 * Result of executing UserPromptSubmit hooks.
 */
export type UserPromptSubmitHooksResult = {
  /** Whether hooks denied the message (exit code 2) */
  denied: boolean;
  /** Deny reason if denied */
  denyReason?: string;
  /** Combined stdout from all hooks (to inject into agent context) */
  hookOutput?: string;
  /** Any errors from hook execution */
  errors: string[];
};

/**
 * Parameters for executing UserPromptSubmit hooks.
 */
export type UserPromptSubmitHooksParams = {
  /** OpenClaw configuration */
  cfg: OpenClawConfig;
  /** User's prompt text */
  prompt: string;
  /** Session identifier */
  sessionId: string;
  /** Agent identifier */
  agentId?: string;
  /** Session key */
  sessionKey?: string;
  /** Working directory */
  workspaceDir?: string;
  /** Provider being used */
  provider?: string;
  /** Model being used */
  model?: string;
};

/**
 * Execute UserPromptSubmit hooks before agent processes the message.
 *
 * Each hook receives JSON input via stdin:
 * {
 *   prompt: 'user message',
 *   sessionId: '...',
 *   agentId: '...',
 *   sessionKey: '...',
 *   workspaceDir: '...',
 *   provider: '...',
 *   model: '...'
 * }
 *
 * Hook stdout is collected and returned for injection into agent context.
 * If any hook exits with code 2, the message is denied.
 *
 * @param params - Hook execution parameters
 * @returns Result with hook output, deny status, and errors
 *
 * @example
 * ```ts
 * const result = await executeUserPromptSubmitHooks({
 *   cfg,
 *   prompt: 'Hello!',
 *   sessionId: 'abc123',
 *   agentId: 'default',
 *   workspaceDir: '/path/to/workspace',
 * });
 *
 * if (result.denied) {
 *   return { text: result.denyReason || 'Message blocked by hook' };
 * }
 *
 * // Inject hook output into agent context
 * if (result.hookOutput) {
 *   commandInjectContent = result.hookOutput;
 * }
 * ```
 */
export async function executeUserPromptSubmitHooks(
  params: UserPromptSubmitHooksParams,
): Promise<UserPromptSubmitHooksResult> {
  const { cfg, prompt, sessionId, agentId, sessionKey, workspaceDir, provider, model } = params;

  // Get configured hooks for UserPromptSubmit event
  const hooks = getConfiguredHooks(cfg, "UserPromptSubmit");

  if (hooks.length === 0) {
    return {
      denied: false,
      errors: [],
    };
  }

  logVerbose(`[user-prompt-hooks] Executing ${hooks.length} UserPromptSubmit hooks`);

  // Build input JSON for hooks
  const hookInput = {
    prompt,
    sessionId,
    agentId,
    sessionKey,
    workspaceDir,
    provider,
    model,
  };

  // Extract commands from resolved hooks
  const commands = hooks.map((h) => h.command);

  // Use the first hook's timeout and cwd (all should be similar from same event config)
  const firstHook = hooks[0];
  const options = {
    timeoutMs: firstHook.timeoutMs,
    cwd: firstHook.cwd ?? workspaceDir,
  };

  // Execute hooks sequentially
  const result = await executeShellHooksSequential(commands, hookInput, options);

  // Log result
  if (result.denied) {
    logVerbose(`[user-prompt-hooks] Hook denied message: ${result.denyReason}`);
  } else if (result.outputs.length > 0) {
    logVerbose(`[user-prompt-hooks] Collected ${result.outputs.length} hook outputs`);
  }
  if (result.errors.length > 0) {
    for (const err of result.errors) {
      logVerbose(`[user-prompt-hooks] Hook error: ${err}`);
    }
  }

  // Combine all outputs into a single string for injection
  const hookOutput = result.outputs.length > 0 ? result.outputs.join("\n\n") : undefined;

  return {
    denied: result.denied,
    denyReason: result.denyReason,
    hookOutput,
    errors: result.errors,
  };
}
