/** Handles /plan channel commands: show state, accept/reject the pending plan, enter/exit. */
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  PLAN_APPROVAL_QUESTION_ID_PREFIX,
  PLAN_APPROVAL_QUESTION_KEY,
  PLAN_APPROVE_LABEL,
  PLAN_KEEP_PLANNING_LABEL,
} from "../../agents/plan-mode/approval.js";
import {
  clearPlanState,
  enterPlanMode,
  getSessionPlanState,
  type SessionPlanSnapshot,
} from "../../config/sessions.js";
import { getGlobalQuestionManager } from "../../gateway/question-manager.js";
import { rejectUnauthorizedCommand } from "./command-gates.js";
import { markCommandSessionMetadataChanged } from "./command-session-metadata.js";
import type {
  CommandHandler,
  CommandHandlerResult,
  HandleCommandsParams,
} from "./commands-types.js";

const PLAN_COMMAND_PREFIX = "/plan";
const PLAN_ACTIONS = new Set([
  "status",
  "show",
  "accept",
  "approve",
  "reject",
  "revise",
  "enter",
  "start",
  "exit",
]);

/** Parses `/plan <action> [text]`, defaulting to status. */
export function parsePlanCommand(raw: string): { action: string; text: string } | null {
  const trimmed = raw.trim();
  const commandEnd = trimmed.search(/\s/);
  const commandToken = commandEnd === -1 ? trimmed : trimmed.slice(0, commandEnd);
  if (normalizeOptionalLowercaseString(commandToken) !== PLAN_COMMAND_PREFIX) {
    return null;
  }
  const argText = commandEnd === -1 ? "" : trimmed.slice(commandEnd).trim();
  if (!argText) {
    return { action: "status", text: "" };
  }
  const [actionRaw = "", ...rest] = argText.split(/\s+/);
  const action = normalizeOptionalLowercaseString(actionRaw) ?? "status";
  if (!PLAN_ACTIONS.has(action)) {
    return { action: "status", text: "" };
  }
  return { action, text: rest.join(" ").trim() };
}

function planReply(text: string): CommandHandlerResult {
  return { shouldContinue: false, reply: { text } };
}

function formatPlanStatus(snapshot: SessionPlanSnapshot): string {
  if (snapshot.status === "inactive" || !snapshot.plan) {
    return "Not in plan mode.\nStart with /plan enter, then research and present a plan.";
  }
  const label = snapshot.status === "pending_approval" ? "Awaiting approval" : "Planning";
  const summary = snapshot.plan.lastSummary ? `\n\n${snapshot.plan.lastSummary}` : "";
  const commands =
    snapshot.status === "pending_approval"
      ? "\n\nCommands: /plan accept, /plan reject <feedback>"
      : "\n\nCommands: /plan show, /plan exit";
  return `Plan mode: ${label}${summary}${commands}`;
}

/** Resolves the pending plan-approval question for this session, if any. */
function resolvePendingPlanQuestion(sessionKey: string, answerText: string): boolean {
  const manager = getGlobalQuestionManager();
  const [record] = manager.list(
    (candidate) =>
      candidate.sessionKey === sessionKey &&
      candidate.id.startsWith(PLAN_APPROVAL_QUESTION_ID_PREFIX),
  );
  if (!record) {
    return false;
  }
  // Resolving lets the parked exit_plan_mode tool make the state transition (approve clears,
  // reject revises). We never mutate plan state here, avoiding the dup-approval bug class.
  return manager.resolve(
    record.id,
    { [PLAN_APPROVAL_QUESTION_KEY]: { text: answerText } },
    "channel",
  );
}

/** Command handler for /plan lifecycle commands. */
export const handlePlanCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const parsed = parsePlanCommand(params.command.commandBodyNormalized);
  if (!parsed) {
    return null;
  }
  const unauthorized = rejectUnauthorizedCommand(params, "/plan");
  if (unauthorized) {
    return unauthorized;
  }

  try {
    return await runPlanAction(params, parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return planReply(`Plan error: ${message}`);
  }
};

async function runPlanAction(
  params: HandleCommandsParams,
  parsed: { action: string; text: string },
): Promise<CommandHandlerResult> {
  const scope = { sessionKey: params.sessionKey, storePath: params.storePath };
  switch (parsed.action) {
    case "status":
    case "show": {
      const snapshot = await getSessionPlanState({ ...scope, fallbackEntry: params.sessionEntry });
      return planReply(formatPlanStatus(snapshot));
    }
    case "accept":
    case "approve": {
      const resolved = resolvePendingPlanQuestion(params.sessionKey, PLAN_APPROVE_LABEL);
      return planReply(resolved ? "Plan approved — executing." : "No plan is awaiting approval.");
    }
    case "reject":
    case "revise": {
      const feedback = normalizeOptionalString(parsed.text);
      const resolved = resolvePendingPlanQuestion(
        params.sessionKey,
        feedback ?? PLAN_KEEP_PLANNING_LABEL,
      );
      return planReply(
        resolved
          ? feedback
            ? "Sent back for revision with your feedback."
            : "Kept in planning."
          : "No plan is awaiting approval.",
      );
    }
    case "enter":
    case "start": {
      await enterPlanMode(scope);
      markCommandSessionMetadataChanged(params);
      return planReply("Entered plan mode. Mutating tools are blocked until the plan is approved.");
    }
    case "exit": {
      const snapshot = await getSessionPlanState({ ...scope, fallbackEntry: params.sessionEntry });
      if (snapshot.status === "pending_approval") {
        const resolved = resolvePendingPlanQuestion(params.sessionKey, PLAN_APPROVE_LABEL);
        return planReply(resolved ? "Plan approved — executing." : "No plan is awaiting approval.");
      }
      const cleared = await clearPlanState(scope);
      if (cleared) {
        markCommandSessionMetadataChanged(params);
      }
      return planReply(cleared ? "Left plan mode." : "Not in plan mode.");
    }
    default:
      return planReply(
        "Usage: /plan [show] | /plan enter | /plan accept | /plan reject <feedback> | /plan exit",
      );
  }
}
