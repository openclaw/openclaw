/**
 * Codex-parity plan-mode lifecycle tools.
 *
 * `enter_plan_mode` puts the session into read-only planning mode; `exit_plan_mode`
 * persists the plan document, requests approval through PR-A's question infra, and returns
 * approved / revise to the model. The read-only mutation gate lives in ../plan-mode/gate.ts.
 */
import { Type } from "typebox";
import { resolveStorePath } from "../../config/sessions/paths.js";
import {
  clearPlanState,
  enterPlanMode,
  revisePlanMode,
  setPlanPendingApproval,
} from "../../config/sessions/plan-state.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getGlobalQuestionManager } from "../../gateway/question-manager.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import {
  buildPlanApprovalQuestion,
  classifyPlanApprovalAnswer,
  PLAN_APPROVAL_QUESTION_ID_PREFIX,
} from "../plan-mode/approval.js";
import { persistPlanFile } from "../plan-mode/plan-file.js";
import { type AnyAgentTool, ToolInputError, jsonResult, readStringParam } from "./common.js";

export type PlanModeToolOptions = {
  agentSessionKey?: string;
  runSessionKey?: string;
  sessionAgentId?: string;
  config?: OpenClawConfig;
  /** Originating channel so the approval question can route back to the asking surface. */
  agentChannel?: GatewayMessageChannel;
  agentTo?: string;
  agentAccountId?: string;
  agentThreadId?: string | number;
};

type PlanSessionScope = {
  sessionKey: string;
  agentId: string;
  storePath: string;
};

function resolvePlanSessionScope(options: PlanModeToolOptions): PlanSessionScope {
  const sessionKey = options.runSessionKey?.trim() || options.agentSessionKey?.trim();
  if (!sessionKey) {
    throw new ToolInputError("session key required");
  }
  const parsedSessionAgentId = parseAgentSessionKey(sessionKey)?.agentId;
  const parsedAgentSessionAgentId = parseAgentSessionKey(options.agentSessionKey)?.agentId;
  const agentId = normalizeAgentId(
    parsedSessionAgentId ?? parsedAgentSessionAgentId ?? options.sessionAgentId,
  );
  return {
    sessionKey,
    agentId,
    storePath: resolveStorePath(options.config?.session?.store, { agentId }),
  };
}

const ExitPlanModeToolSchema = Type.Object(
  {
    plan_summary: Type.String({
      description:
        "The full plan to present for approval: ordered steps and the intended approach, in Markdown.",
    }),
  },
  { additionalProperties: false },
);

const ENTER_PLAN_MODE_DESCRIPTION = [
  "Enter read-only plan mode: research and compose a plan without making any changes.",
  "While in plan mode, write/edit/exec/browser-mutation and other mutating tools are blocked;",
  "maintain the checklist with update_plan and present the plan via exit_plan_mode when ready.",
].join(" ");

const EXIT_PLAN_MODE_DESCRIPTION = [
  "Present the finished plan for user approval and leave plan mode.",
  "Blocks until the user approves (execution then proceeds) or asks you to keep planning.",
  "On approval the tool returns status 'approved'; if the user wants changes it returns their",
  "feedback so you can revise the plan and call exit_plan_mode again.",
].join(" ");

/** Creates the enter_plan_mode tool that flips the session into read-only planning. */
export function createEnterPlanModeTool(options: PlanModeToolOptions): AnyAgentTool {
  return {
    label: "Enter Plan Mode",
    name: "enter_plan_mode",
    displaySummary: "Enter read-only plan mode",
    description: ENTER_PLAN_MODE_DESCRIPTION,
    parameters: Type.Object({}),
    execute: async () => {
      const scope = resolvePlanSessionScope(options);
      const plan = await enterPlanMode({
        sessionKey: scope.sessionKey,
        storePath: scope.storePath,
      });
      return jsonResult({ status: "planning", plan });
    },
  };
}

/** Creates the exit_plan_mode tool that requests approval via PR-A's question infra. */
export function createExitPlanModeTool(options: PlanModeToolOptions): AnyAgentTool {
  return {
    label: "Exit Plan Mode",
    name: "exit_plan_mode",
    displaySummary: "Present the plan for approval",
    description: EXIT_PLAN_MODE_DESCRIPTION,
    parameters: ExitPlanModeToolSchema,
    execute: async (_toolCallId, args) => {
      const params = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
      for (const key of Object.keys(params)) {
        if (key !== "plan_summary") {
          throw new ToolInputError(`unknown field '${key}'`);
        }
      }
      const summary = readStringParam(params, "plan_summary", { required: true });
      const scope = resolvePlanSessionScope(options);

      const planFilePath = await persistPlanFile({
        config: options.config,
        agentId: scope.agentId,
        summary,
      });

      const questionId = `${PLAN_APPROVAL_QUESTION_ID_PREFIX}-${scope.agentId}-${Date.now()}`;
      const { wait } = getGlobalQuestionManager().register({
        id: questionId,
        sessionKey: scope.sessionKey,
        agentId: scope.agentId,
        turnSourceChannel: options.agentChannel ?? null,
        turnSourceTo: options.agentTo ?? null,
        turnSourceAccountId: options.agentAccountId ?? null,
        turnSourceThreadId: options.agentThreadId ?? null,
        questions: [buildPlanApprovalQuestion(summary)],
      });

      await setPlanPendingApproval({
        sessionKey: scope.sessionKey,
        storePath: scope.storePath,
        planFilePath,
        pendingQuestionId: questionId,
        summary,
      });

      const answers = await wait;
      if (!answers) {
        // Expired (gateway shutdown/restart). Fall back to planning so the gate stays active.
        await revisePlanMode({ sessionKey: scope.sessionKey, storePath: scope.storePath });
        return jsonResult({ status: "expired", planFilePath });
      }

      const decision = classifyPlanApprovalAnswer(answers);
      if (decision.kind === "approved") {
        await clearPlanState({ sessionKey: scope.sessionKey, storePath: scope.storePath });
        return jsonResult({ status: "approved", planFilePath });
      }
      await revisePlanMode({
        sessionKey: scope.sessionKey,
        storePath: scope.storePath,
        ...(decision.feedback ? { feedback: decision.feedback } : {}),
      });
      return jsonResult({
        status: "revise",
        planFilePath,
        ...(decision.feedback ? { feedback: decision.feedback } : {}),
      });
    },
  };
}
