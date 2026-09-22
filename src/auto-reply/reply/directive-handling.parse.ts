// Parses inline reply directives into typed execution and routing options.
import { extractModelDirective } from "../model.js";
import { isSessionDefaultDirectiveValue } from "../thinking.shared.js";
import {
  extractElevatedDirective,
  extractExecDirective,
  extractFastDirective,
  extractReasoningDirective,
  extractStatusDirective,
  extractTraceDirective,
  extractThinkDirective,
  extractVerboseDirective,
} from "./directives.js";
import { extractQueueDirective } from "./queue/directive.js";

const REPLY_DIRECTIVE_COMMANDS = {
  think: true,
  verbose: true,
  trace: true,
  fast: true,
  reasoning: true,
  elevated: true,
  exec: true,
  model: true,
  queue: true,
} as const;

/** Canonical command-registry keys that share the session-directive execution pipeline. */
type ReplyDirectiveCommand = keyof typeof REPLY_DIRECTIVE_COMMANDS;

/** Resolves a registered command key without inferring directive ownership from slash text. */
export function resolveReplyDirectiveCommand(
  commandKey: string | undefined,
): ReplyDirectiveCommand | undefined {
  return commandKey && Object.hasOwn(REPLY_DIRECTIVE_COMMANDS, commandKey)
    ? (commandKey as ReplyDirectiveCommand)
    : undefined;
}

/** Shares the server's directive/prose boundary with browser command admission. */
export function isModelIndependentDirectiveCommand(
  name: ReplyDirectiveCommand,
  args: string,
): boolean {
  const directives = parseInlineSessionDirectives(`/${name} ${args}`, {
    command: { kind: "text", name },
  });
  return directives.command !== undefined || directives.cleaned.trim() === "";
}

/** Parses supported inline directives in the same order they are stripped from text. */
export function parseInlineSessionDirectives(
  body: string,
  options?: {
    modelAliases?: string[];
    disableElevated?: boolean;
    allowStatusDirective?: boolean;
    command?: { kind: "native" | "text"; name: ReplyDirectiveCommand };
  },
) {
  const invocation = options?.command;
  // Inspect raw exec arguments before sibling directives can remove tokens and
  // turn an invalid positional argument into a recognized option or state change.
  const textExec =
    invocation?.kind === "text" && invocation.name === "exec"
      ? extractExecDirective(body)
      : undefined;
  const command =
    invocation?.kind === "native"
      ? invocation.name
      : textExec?.hasDirective && !textExec.hasExecOptions && textExec.cleaned
        ? "exec"
        : undefined;
  let cleaned = body;
  let hasAnyDirective = false;
  const parseScopedDirective = <T extends { cleaned: string; hasDirective: boolean }>(
    commandName: ReplyDirectiveCommand,
    extract: (value: string) => T,
    enabled = true,
  ): T => {
    const parsed =
      enabled && (!command || command === commandName)
        ? extract(cleaned)
        : ({ cleaned, hasDirective: false } as T);
    cleaned = parsed.cleaned;
    hasAnyDirective ||= parsed.hasDirective;
    return parsed;
  };
  const think = parseScopedDirective("think", (value) =>
    extractThinkDirective(value, { strict: command === "think" }),
  );
  const verbose = parseScopedDirective("verbose", (value) =>
    extractVerboseDirective(value, { strict: command === "verbose" }),
  );
  const trace = parseScopedDirective("trace", (value) =>
    extractTraceDirective(value, { strict: command === "trace" }),
  );
  const fast = parseScopedDirective("fast", (value) =>
    extractFastDirective(value, { strict: command === "fast" }),
  );
  const reasoning = parseScopedDirective("reasoning", (value) =>
    extractReasoningDirective(value, { strict: command === "reasoning" }),
  );
  const elevated = parseScopedDirective(
    "elevated",
    (value) => extractElevatedDirective(value, { strict: command === "elevated" }),
    !options?.disableElevated,
  );
  const exec = parseScopedDirective("exec", extractExecDirective);
  const allowStatusDirective = options?.allowStatusDirective !== false && !command;
  const { cleaned: statusCleaned, hasDirective: hasStatusDirective } = allowStatusDirective
    ? extractStatusDirective(cleaned)
    : { cleaned, hasDirective: false };
  cleaned = statusCleaned;
  hasAnyDirective ||= hasStatusDirective;
  const model = parseScopedDirective("model", (value) =>
    extractModelDirective(value, {
      aliases: options?.modelAliases,
    }),
  );
  const queue = parseScopedDirective("queue", extractQueueDirective);
  // Later directives see text cleaned by earlier directives; preserve that ordering.
  return {
    cleaned,
    ...(command && hasAnyDirective
      ? {
          command: {
            name: command,
            ...(cleaned ? { unconsumedArguments: cleaned } : {}),
          },
        }
      : {}),
    hasThinkDirective: think.hasDirective,
    thinkLevel: think.thinkLevel,
    rawThinkLevel: think.rawLevel,
    clearThinkLevel: think.hasDirective && isSessionDefaultDirectiveValue(think.rawLevel),
    hasVerboseDirective: verbose.hasDirective,
    verboseLevel: verbose.verboseLevel,
    rawVerboseLevel: verbose.rawLevel,
    hasTraceDirective: trace.hasDirective,
    traceLevel: trace.traceLevel,
    rawTraceLevel: trace.rawLevel,
    hasFastDirective: fast.hasDirective,
    fastMode: fast.fastMode,
    rawFastMode: fast.rawLevel,
    clearFastMode: fast.hasDirective && isSessionDefaultDirectiveValue(fast.rawLevel),
    hasReasoningDirective: reasoning.hasDirective,
    reasoningLevel: reasoning.reasoningLevel,
    rawReasoningLevel: reasoning.rawLevel,
    hasElevatedDirective: elevated.hasDirective,
    elevatedLevel: elevated.elevatedLevel,
    rawElevatedLevel: elevated.rawLevel,
    hasExecDirective: exec.hasDirective,
    execHost: exec.execHost,
    execSecurity: exec.execSecurity,
    execAsk: exec.execAsk,
    execNode: exec.execNode,
    rawExecHost: exec.rawExecHost,
    rawExecSecurity: exec.rawExecSecurity,
    rawExecAsk: exec.rawExecAsk,
    rawExecNode: exec.rawExecNode,
    hasExecOptions: exec.hasExecOptions,
    invalidExecHost: exec.invalidHost,
    invalidExecSecurity: exec.invalidSecurity,
    invalidExecAsk: exec.invalidAsk,
    invalidExecNode: exec.invalidNode,
    hasStatusDirective,
    hasModelDirective: model.hasDirective,
    rawModelDirective: model.rawModel,
    rawModelProfile: model.rawProfile,
    rawModelRuntime: model.rawRuntime,
    modelDirectiveSource: model.source,
    modelScope: model.scope,
    modelScopeConflict: model.scopeConflict,
    hasQueueDirective: queue.hasDirective,
    queueMode: queue.queueMode,
    queueReset: queue.queueReset,
    rawQueueMode: queue.rawMode,
    debounceMs: queue.debounceMs,
    cap: queue.cap,
    dropPolicy: queue.dropPolicy,
    rawDebounce: queue.rawDebounce,
    rawCap: queue.rawCap,
    rawDrop: queue.rawDrop,
    hasQueueOptions: queue.hasOptions,
  };
}

/** Parsed inline directives removed from a user message before agent execution. */
export type InlineDirectives = ReturnType<typeof parseInlineSessionDirectives>;
