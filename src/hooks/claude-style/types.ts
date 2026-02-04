/**
 * Claude Code-style hook system types.
 *
 * Provides a rich hook system that mirrors Claude Code's hook architecture,
 * enabling users to intercept, modify, and block agent actions via shell scripts,
 * LLM prompts, or subagents.
 *
 * @see https://code.claude.com/docs/en/hooks
 */

// =============================================================================
// Hook Events
// =============================================================================

/**
 * All supported hook events.
 * - PreToolUse: Before a tool is executed (can block/modify)
 * - PostToolUse: After a tool completes successfully (observe-only)
 * - PostToolUseFailure: After a tool fails (observe-only)
 * - UserPromptSubmit: When user submits a prompt (can modify)
 * - Stop: When agent is about to stop (can continue)
 * - SubagentStart: When a subagent starts (can inject context)
 * - SubagentStop: When a subagent stops (observe-only)
 * - PreCompact: Before compaction (fire-and-forget)
 */
export type ClaudeHookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "UserPromptSubmit"
  | "Stop"
  | "SubagentStart"
  | "SubagentStop"
  | "PreCompact";

// =============================================================================
// Hook Handlers (discriminated union)
// =============================================================================

/**
 * Base handler properties shared by all handler types.
 */
export type ClaudeHookHandlerBase = {
  /** Optional timeout in seconds for the handler execution. */
  timeout?: number;
};

/**
 * Command handler - executes a shell command.
 * Command receives JSON via stdin, returns JSON via stdout.
 * Exit codes: 0 = allow, 2 = deny.
 */
export type ClaudeHookCommandHandler = ClaudeHookHandlerBase & {
  type: "command";
  /**
   * Command to execute.
   * - string: parsed via shell-quote, tokens validated as strings
   * - string[]: used directly as argv
   */
  command: string | string[];
};

/**
 * Prompt handler - evaluates with an LLM.
 * The prompt is sent to the model with hook context.
 */
export type ClaudeHookPromptHandler = ClaudeHookHandlerBase & {
  type: "prompt";
  /** Prompt template to evaluate. */
  prompt: string;
  /** Optional model override. */
  model?: string;
};

/**
 * Agent handler - runs a subagent.
 * The subagent processes the hook input and returns a decision.
 */
export type ClaudeHookAgentHandler = ClaudeHookHandlerBase & {
  type: "agent";
  /** Agent configuration or ID. */
  agent: string;
  /** Optional instructions for the agent. */
  instructions?: string;
};

/**
 * Discriminated union of all handler types.
 */
export type ClaudeHookHandler =
  | ClaudeHookCommandHandler
  | ClaudeHookPromptHandler
  | ClaudeHookAgentHandler;

// =============================================================================
// Hook Matchers
// =============================================================================

/**
 * Matcher for tool-based hooks (PreToolUse, PostToolUse, PostToolUseFailure).
 * Uses glob patterns via picomatch.
 */
export type ClaudeHookMatcher = string;

/**
 * A hook rule that matches certain conditions and runs handlers.
 */
export type ClaudeHookRule = {
  /** Glob pattern to match tool names (for tool hooks) or other identifiers. */
  matcher: ClaudeHookMatcher;
  /** Handlers to run when the matcher matches. */
  hooks: ClaudeHookHandler[];
};

// =============================================================================
// Hook Input/Output Protocol
// =============================================================================

/**
 * Base input passed to all hooks via stdin (JSON).
 * Field names match the Claude Code hook protocol.
 */
export type ClaudeHookInputBase = {
  /** The event type that triggered this hook. */
  hook_event_name: ClaudeHookEvent;
  /** Session identifier. */
  session_id?: string;
  /** Working directory. */
  cwd?: string;
  /**
   * Permission mode for the tool/action.
   * OPTIONAL - no current source in codebase, reserved for future use.
   */
  permission_mode?: "default" | "auto-approve" | "ask";
};

/**
 * Input for PreToolUse hooks.
 */
export type ClaudeHookPreToolUseInput = ClaudeHookInputBase & {
  hook_event_name: "PreToolUse";
  /** Name of the tool about to be called. */
  tool_name: string;
  /** Tool input parameters. */
  tool_input: Record<string, unknown>;
};

/**
 * Input for PostToolUse hooks.
 */
export type ClaudeHookPostToolUseInput = ClaudeHookInputBase & {
  hook_event_name: "PostToolUse";
  /** Name of the tool that was called. */
  tool_name: string;
  /** Tool input parameters. */
  tool_input: Record<string, unknown>;
  /** Sanitized tool result (truncated, no binary). */
  tool_result: unknown;
};

/**
 * Input for PostToolUseFailure hooks.
 */
export type ClaudeHookPostToolUseFailureInput = ClaudeHookInputBase & {
  hook_event_name: "PostToolUseFailure";
  /** Name of the tool that failed. */
  tool_name: string;
  /** Tool input parameters. */
  tool_input: Record<string, unknown>;
  /** Error message or details. */
  tool_error: string;
};

/**
 * Input for UserPromptSubmit hooks.
 */
export type ClaudeHookUserPromptSubmitInput = ClaudeHookInputBase & {
  hook_event_name: "UserPromptSubmit";
  /** The user's prompt text. */
  prompt: string;
  /** Channel the prompt came from. */
  channel?: string;
};

/**
 * Input for Stop hooks.
 */
export type ClaudeHookStopInput = ClaudeHookInputBase & {
  hook_event_name: "Stop";
  /** Reason for stopping. */
  reason?: string;
  /** Last response from the agent. */
  last_response?: string;
};

/**
 * Input for SubagentStart hooks.
 */
export type ClaudeHookSubagentStartInput = ClaudeHookInputBase & {
  hook_event_name: "SubagentStart";
  /** Subagent identifier. */
  subagent_id: string;
  /** Type of subagent. */
  subagent_type?: string;
};

/**
 * Input for SubagentStop hooks.
 */
export type ClaudeHookSubagentStopInput = ClaudeHookInputBase & {
  hook_event_name: "SubagentStop";
  /** Subagent identifier. */
  subagent_id: string;
  /** Subagent result or status. */
  subagent_outcome?: unknown;
};

/**
 * Input for PreCompact hooks.
 */
export type ClaudeHookPreCompactInput = ClaudeHookInputBase & {
  hook_event_name: "PreCompact";
  /** Number of messages before compaction. */
  message_count: number;
  /** Estimated token count. */
  token_count?: number;
};

/**
 * Union of all hook input types.
 */
export type ClaudeHookInput =
  | ClaudeHookPreToolUseInput
  | ClaudeHookPostToolUseInput
  | ClaudeHookPostToolUseFailureInput
  | ClaudeHookUserPromptSubmitInput
  | ClaudeHookStopInput
  | ClaudeHookSubagentStartInput
  | ClaudeHookSubagentStopInput
  | ClaudeHookPreCompactInput;

// =============================================================================
// Hook Output Protocol
// =============================================================================

/**
 * Decision output from a hook.
 * - allow: Proceed with the action
 * - deny: Block the action
 * - ask: Prompt for confirmation (for interactive contexts)
 */
export type ClaudeHookDecision = "allow" | "deny" | "ask";

/**
 * Output from a hook handler (JSON via stdout).
 * Field names match the Claude Code hook protocol.
 */
export type ClaudeHookOutput = {
  /** Decision: allow, deny, or ask. */
  decision?: ClaudeHookDecision;
  /** Reason for the decision (for logging/debugging). */
  reason?: string;
  /** Modified tool input (for PreToolUse with updated parameters). */
  updatedInput?: Record<string, unknown>;
  /** Modified prompt (for UserPromptSubmit). */
  prompt?: string;
  /** Additional context to inject (for SubagentStart). */
  additionalContext?: string;
  /** Continuation message (for Stop with decision=allow). */
  continuation_message?: string;
};

// =============================================================================
// Configuration Types
// =============================================================================

/**
 * Configuration for a single hook event.
 */
export type ClaudeHookEventConfig = ClaudeHookRule[];

/**
 * Full Claude hooks configuration.
 */
export type ClaudeHooksConfig = {
  /** PreToolUse hook rules. */
  PreToolUse?: ClaudeHookEventConfig;
  /** PostToolUse hook rules. */
  PostToolUse?: ClaudeHookEventConfig;
  /** PostToolUseFailure hook rules. */
  PostToolUseFailure?: ClaudeHookEventConfig;
  /** UserPromptSubmit hook rules (matcher typically "*"). */
  UserPromptSubmit?: ClaudeHookEventConfig;
  /** Stop hook rules. */
  Stop?: ClaudeHookEventConfig;
  /** SubagentStart hook rules. */
  SubagentStart?: ClaudeHookEventConfig;
  /** SubagentStop hook rules. */
  SubagentStop?: ClaudeHookEventConfig;
  /** PreCompact hook rules. */
  PreCompact?: ClaudeHookEventConfig;
};
