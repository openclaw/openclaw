import type { SubagentRunRecord } from "../../agents/subagent-registry.types.js";
import {
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "../../agents/tools/sessions-helpers.js";
import type { CommandHandlerResult, HandleCommandsParams } from "./commands-types.js";

export const COMMAND = "/subagents";
export const COMMAND_KILL = "/kill";
export const COMMAND_STEER = "/steer";
export const COMMAND_TELL = "/tell";
export const COMMAND_FOCUS = "/focus";
export const COMMAND_UNFOCUS = "/unfocus";
export const COMMAND_AGENTS = "/agents";

const ACTIONS = new Set([
  "list",
  "kill",
  "log",
  "send",
  "steer",
  "info",
  "spawn",
  "focus",
  "unfocus",
  "agents",
  "help",
]);

export type SubagentsAction =
  | "list"
  | "kill"
  | "log"
  | "send"
  | "steer"
  | "info"
  | "spawn"
  | "focus"
  | "unfocus"
  | "agents"
  | "help";

export type SubagentsCommandContext = {
  params: HandleCommandsParams;
  handledPrefix: string;
  requesterKey: string;
  runs: SubagentRunRecord[];
  restTokens: string[];
};

export function stopWithText(text: string): CommandHandlerResult {
  return { shouldContinue: false, reply: { text } };
}

export function resolveRequesterSessionKey(
  params: HandleCommandsParams,
  opts?: { preferCommandTarget?: boolean },
): string | undefined {
  const commandTarget = params.ctx.CommandTargetSessionKey?.trim();
  const commandSession = params.sessionKey?.trim();
  const shouldPreferCommandTarget =
    opts?.preferCommandTarget ?? params.ctx.CommandSource === "native";
  const raw = shouldPreferCommandTarget
    ? commandTarget || commandSession
    : commandSession || commandTarget;
  if (!raw) {
    return undefined;
  }
  const { mainKey, alias } = resolveMainSessionAlias(params.cfg);
  return resolveInternalSessionKey({ key: raw, alias, mainKey });
}

export function resolveHandledPrefix(normalized: string): string | null {
  return normalized.startsWith(COMMAND)
    ? COMMAND
    : normalized.startsWith(COMMAND_KILL)
      ? COMMAND_KILL
      : normalized.startsWith(COMMAND_STEER)
        ? COMMAND_STEER
        : normalized.startsWith(COMMAND_TELL)
          ? COMMAND_TELL
          : normalized.startsWith(COMMAND_FOCUS)
            ? COMMAND_FOCUS
            : normalized.startsWith(COMMAND_UNFOCUS)
              ? COMMAND_UNFOCUS
              : normalized.startsWith(COMMAND_AGENTS)
                ? COMMAND_AGENTS
                : null;
}

export function resolveSubagentsAction(params: {
  handledPrefix: string;
  restTokens: string[];
}): SubagentsAction | null {
  if (params.handledPrefix === COMMAND) {
    const [actionRaw] = params.restTokens;
    const action = (actionRaw?.toLowerCase() || "list") as SubagentsAction;
    if (!ACTIONS.has(action)) {
      return null;
    }
    params.restTokens.splice(0, 1);
    return action;
  }
  if (params.handledPrefix === COMMAND_KILL) {
    return "kill";
  }
  if (params.handledPrefix === COMMAND_FOCUS) {
    return "focus";
  }
  if (params.handledPrefix === COMMAND_UNFOCUS) {
    return "unfocus";
  }
  if (params.handledPrefix === COMMAND_AGENTS) {
    return "agents";
  }
  return "steer";
}
