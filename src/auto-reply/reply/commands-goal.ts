/** Handles /goal session objective commands and continuation prompt formatting. */
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { isGoalDriverContinuationPrompt } from "../../agents/goal-driver/continuation-prompt.js";
import {
  clearSessionGoal,
  createSessionGoal,
  formatSessionGoalStatus,
  getSessionEntry,
  getSessionGoal,
  updateSessionGoalObjective,
  updateSessionGoalStatus,
} from "../../config/sessions.js";
import { rejectUnauthorizedCommand } from "./command-gates.js";
import { markCommandSessionMetadataChanged } from "./command-session-metadata.js";
import type {
  CommandHandler,
  CommandHandlerResult,
  HandleCommandsParams,
} from "./commands-types.js";

const GOAL_COMMAND_PREFIX = "/goal";
const GOAL_CONTINUATION_PROMPT_PREFIX =
  "Pursue this goal exactly as written from this JSON string:";
const GOAL_RESUME_NOTE_PROMPT_PREFIX =
  "Continue pursuing the current goal. Interpret this JSON string as the resume note:";
const GOAL_ACTIONS = new Set([
  "block",
  "blocked",
  "clear",
  "complete",
  "create",
  "done",
  "edit",
  "pause",
  "resume",
  "set",
  "start",
  "status",
  "stop",
]);

/**
 * Splits a trailing `--budget N` (or `--budget=N`) flag off an objective string.
 *
 * Mirrors the codex `/goal set <objective> [--budget N]` surface: a positive
 * integer token budget can be attached inline when starting a goal. The flag is
 * stripped from the objective text so it never leaks into the pursued goal.
 */
export function extractGoalBudgetFlag(text: string): {
  objective: string;
  tokenBudget?: number;
} {
  const match = text.match(/(?:^|\s)--budget(?:=|\s+)(\d+)(?=\s|$)/);
  if (!match) {
    return { objective: text.trim() };
  }
  const parsed = Number.parseInt(match[1] ?? "", 10);
  const objective = (
    text.slice(0, match.index) + text.slice(match.index! + match[0].length)
  ).trim();
  return {
    objective,
    ...(Number.isFinite(parsed) && parsed > 0 ? { tokenBudget: parsed } : {}),
  };
}

/** Parses /goal action text, defaulting unknown actions to goal creation. */
export function parseGoalCommand(raw: string): { action: string; text: string } | null {
  const trimmed = raw.trim();
  const commandEnd = trimmed.search(/\s/);
  const commandToken = commandEnd === -1 ? trimmed : trimmed.slice(0, commandEnd);
  if (normalizeOptionalLowercaseString(commandToken) !== GOAL_COMMAND_PREFIX) {
    return null;
  }
  const argText = commandEnd === -1 ? "" : trimmed.slice(commandEnd).trim();
  if (!argText) {
    return { action: "status", text: "" };
  }
  const [actionRaw = "", ...rest] = argText.split(/\s+/);
  const action = normalizeOptionalLowercaseString(actionRaw) ?? "status";
  if (!GOAL_ACTIONS.has(action)) {
    return { action: "start", text: argText };
  }
  return {
    action,
    text: rest.join(" ").trim(),
  };
}

function syncGoalSessionEntry(params: HandleCommandsParams): void {
  if (!params.sessionStore || !params.sessionKey) {
    return;
  }
  const entry = getSessionEntry({ sessionKey: params.sessionKey, storePath: params.storePath });
  if (!entry) {
    return;
  }
  params.sessionStore[params.sessionKey] = entry;
  params.sessionEntry = entry;
}

function goalReply(text: string): CommandHandlerResult {
  return {
    shouldContinue: false,
    reply: { text },
  };
}

function hasCommandLikeGoalText(trimmed: string): boolean {
  return /(?:^|\s)\//.test(trimmed) || trimmed.startsWith("!");
}

function encodeGoalJsonString(trimmed: string): string {
  return JSON.stringify(trimmed).replaceAll("/", "\\/");
}

/** Formats the model prompt used to continue a newly started goal. */
export function formatGoalContinuationPrompt(objective: string): string {
  const trimmed = objective.trim();
  return hasCommandLikeGoalText(trimmed)
    ? `${GOAL_CONTINUATION_PROMPT_PREFIX} ${encodeGoalJsonString(trimmed)}`
    : trimmed;
}

/** Formats the model prompt used when resuming a paused goal. */
export function formatGoalResumeContinuationPrompt(note: string): string {
  const trimmed = note.trim();
  if (!trimmed) {
    return "Continue pursuing the current goal.";
  }
  return hasCommandLikeGoalText(trimmed)
    ? `${GOAL_RESUME_NOTE_PROMPT_PREFIX} ${encodeGoalJsonString(trimmed)}`
    : `Continue pursuing the current goal. Note: ${trimmed}`;
}

/**
 * Returns true for internally generated goal continuation prompts.
 *
 * Recognizes both the manual `/goal start|resume` prompts and the autonomous
 * goal-driver continuation marker so the gateway classifies every driver-fired
 * turn as a goal continuation. Without folding the driver marker in here the
 * no-progress ceiling counter would reset on the driver's own turns and the
 * auto-pause safety valve could never trip.
 */
export function isFormattedGoalContinuationPrompt(message: string): boolean {
  const trimmed = message.trim();
  return (
    trimmed.startsWith(GOAL_CONTINUATION_PROMPT_PREFIX) ||
    trimmed.startsWith(GOAL_RESUME_NOTE_PROMPT_PREFIX) ||
    isGoalDriverContinuationPrompt(trimmed)
  );
}

function applyGoalPromptToContext(ctx: HandleCommandsParams["ctx"], message: string): void {
  const mutableCtx = ctx as HandleCommandsParams["ctx"] & {
    Body?: string;
    RawBody?: string;
    CommandBody?: string;
    BodyForCommands?: string;
    BodyForAgent?: string;
    BodyStripped?: string;
  };
  mutableCtx.Body = message;
  mutableCtx.RawBody = message;
  mutableCtx.CommandBody = message;
  mutableCtx.BodyForCommands = message;
  mutableCtx.BodyForAgent = message;
  mutableCtx.BodyStripped = message;
}

function applyGoalContinuationPrompt(params: HandleCommandsParams, message: string): void {
  applyGoalPromptToContext(params.ctx, message);
  if (params.rootCtx && params.rootCtx !== params.ctx) {
    applyGoalPromptToContext(params.rootCtx, message);
  }
  params.command.rawBodyNormalized = message;
  params.command.commandBodyNormalized = message;
}

function goalContinuation(): CommandHandlerResult {
  return { shouldContinue: true };
}

function goalErrorReply(error: unknown): CommandHandlerResult {
  const message = error instanceof Error ? error.message : String(error);
  return goalReply(`Goal error: ${message}`);
}

/** Command handler for /goal lifecycle commands. */
export const handleGoalCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const parsed = parseGoalCommand(params.command.commandBodyNormalized);
  if (!parsed) {
    return null;
  }
  const unauthorized = rejectUnauthorizedCommand(params, "/goal");
  if (unauthorized) {
    return unauthorized;
  }

  try {
    switch (parsed.action) {
      case "status": {
        const snapshot = await getSessionGoal({
          sessionKey: params.sessionKey,
          storePath: params.storePath,
          fallbackEntry: params.sessionEntry,
          persist: false,
        });
        syncGoalSessionEntry(params);
        return goalReply(formatSessionGoalStatus(snapshot.goal));
      }
      case "start":
      case "set":
      case "create": {
        const { objective: rawObjective, tokenBudget } = extractGoalBudgetFlag(parsed.text);
        const objective = normalizeOptionalString(rawObjective);
        if (!objective) {
          return goalReply("Usage: /goal set <objective> [--budget N]");
        }
        const goal = await createSessionGoal({
          sessionKey: params.sessionKey,
          storePath: params.storePath,
          objective,
          ...(tokenBudget !== undefined ? { tokenBudget } : {}),
          fallbackEntry: params.sessionEntry,
        });
        syncGoalSessionEntry(params);
        markCommandSessionMetadataChanged(params);
        applyGoalContinuationPrompt(params, formatGoalContinuationPrompt(goal.objective));
        return goalContinuation();
      }
      case "edit": {
        const objective = normalizeOptionalString(parsed.text);
        if (!objective) {
          return goalReply("Usage: /goal edit <objective>");
        }
        const goal = await updateSessionGoalObjective({
          sessionKey: params.sessionKey,
          storePath: params.storePath,
          objective,
        });
        syncGoalSessionEntry(params);
        markCommandSessionMetadataChanged(params);
        return goalReply(`Goal updated: ${goal.objective}`);
      }
      case "pause": {
        const goal = await updateSessionGoalStatus({
          sessionKey: params.sessionKey,
          storePath: params.storePath,
          status: "paused",
          ...(parsed.text ? { note: parsed.text } : {}),
        });
        syncGoalSessionEntry(params);
        markCommandSessionMetadataChanged(params);
        return goalReply(`Goal paused: ${goal.objective}`);
      }
      case "resume": {
        await updateSessionGoalStatus({
          sessionKey: params.sessionKey,
          storePath: params.storePath,
          status: "active",
          ...(parsed.text ? { note: parsed.text } : {}),
        });
        syncGoalSessionEntry(params);
        markCommandSessionMetadataChanged(params);
        const message = formatGoalResumeContinuationPrompt(parsed.text);
        applyGoalContinuationPrompt(params, message);
        return goalContinuation();
      }
      case "complete":
      case "done": {
        const goal = await updateSessionGoalStatus({
          sessionKey: params.sessionKey,
          storePath: params.storePath,
          status: "complete",
          ...(parsed.text ? { note: parsed.text } : {}),
        });
        syncGoalSessionEntry(params);
        markCommandSessionMetadataChanged(params);
        return goalReply(`Goal complete: ${goal.objective}\nTokens used: ${goal.tokensUsed}`);
      }
      case "block":
      case "blocked": {
        const goal = await updateSessionGoalStatus({
          sessionKey: params.sessionKey,
          storePath: params.storePath,
          status: "blocked",
          ...(parsed.text ? { note: parsed.text } : {}),
        });
        syncGoalSessionEntry(params);
        markCommandSessionMetadataChanged(params);
        return goalReply(`Goal blocked: ${goal.objective}`);
      }
      case "clear":
      case "stop": {
        // `stop` is the host-facing verb for ending goal pursuit (codex parity);
        // it clears the goal entirely, disarming the driver on its next wake.
        const removed = await clearSessionGoal({
          sessionKey: params.sessionKey,
          storePath: params.storePath,
        });
        syncGoalSessionEntry(params);
        if (removed) {
          markCommandSessionMetadataChanged(params);
        }
        const verb = parsed.action === "stop" ? "stopped" : "cleared";
        return goalReply(removed ? `Goal ${verb}.` : "No goal to clear.");
      }
      default:
        return goalReply(
          "Usage: /goal <objective> | /goal [status] | /goal set <objective> [--budget N] | /goal edit <objective> | /goal pause|resume|complete|block|stop|clear",
        );
    }
  } catch (error) {
    return goalErrorReply(error);
  }
};
