import {
  applyA2ATaskProtocolCancel,
  applyA2ATaskProtocolUpdate,
  loadA2ATaskProtocolStatusById,
  runA2ATaskRequest,
} from "../../agents/a2a/broker.js";
import { createOpenClawA2ABrokerRuntime } from "../../agents/a2a/openclaw-runtime.js";
import type { A2ABrokerRuntime } from "../../agents/a2a/types.js";
import {
  ErrorCodes,
  errorShape,
  validateA2ATaskCancelParams,
  validateA2ATaskRequestParams,
  validateA2ATaskStatusParams,
  validateA2ATaskUpdateParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

// ── Reply/announce context builders (mirrors sessions-send-tool.a2a.ts) ──

function defaultBuildReplyContext(params: {
  requesterSessionKey?: string;
  requesterChannel?: string;
  targetSessionKey: string;
  targetChannel?: string;
  currentRole: "requester" | "target";
  turn: number;
  maxTurns: number;
}): string {
  return `You are in an agent-to-agent task (turn ${params.turn}/${params.maxTurns}, role: ${params.currentRole}). Continue working on the delegated task. Keep responses concise.`;
}

function defaultBuildAnnounceContext(params: {
  requesterSessionKey?: string;
  requesterChannel?: string;
  targetSessionKey: string;
  targetChannel?: string;
  originalMessage: string;
  roundOneReply?: string;
  latestReply?: string;
}): string {
  return `An agent-to-agent task has completed. The original request was: "${params.originalMessage}". Compose a concise announcement of the result for the requesting agent.`;
}

function defaultIsReplySkip(_text: string): boolean {
  return false;
}

function defaultIsAnnounceSkip(text: string): boolean {
  return !text?.trim();
}

type CreateA2AHandlersOptions = {
  runtime?: A2ABrokerRuntime;
  createRuntime?: () => A2ABrokerRuntime;
  buildReplyContext?: typeof defaultBuildReplyContext;
  buildAnnounceContext?: typeof defaultBuildAnnounceContext;
  isReplySkip?: typeof defaultIsReplySkip;
  isAnnounceSkip?: typeof defaultIsAnnounceSkip;
};

function formatGatewayErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatA2AActionScope(params: {
  taskId?: string;
  sessionKey?: string;
  targetSessionKey?: string;
}): string {
  const scopeParts: string[] = [];
  if (typeof params.taskId === "string" && params.taskId.trim()) {
    scopeParts.push(`task ${params.taskId.trim()}`);
  }
  if (typeof params.sessionKey === "string" && params.sessionKey.trim()) {
    scopeParts.push(`session ${params.sessionKey.trim()}`);
  } else if (typeof params.targetSessionKey === "string" && params.targetSessionKey.trim()) {
    scopeParts.push(`target session ${params.targetSessionKey.trim()}`);
  }
  return scopeParts.length > 0 ? ` for ${scopeParts.join(" in ")}` : "";
}

function formatA2AActionFailureMessage(
  action: string,
  err: unknown,
  scope: Parameters<typeof formatA2AActionScope>[0] = {},
): string {
  return `A2A ${action} failed${formatA2AActionScope(scope)}: ${formatGatewayErrorMessage(err)}`;
}

function formatA2ATaskNotFoundMessage(params: { taskId: string; sessionKey: string }): string {
  return `A2A task ${params.taskId} was not found in session ${params.sessionKey}`;
}

// ── Handlers ──

export function createA2AHandlers(options: CreateA2AHandlersOptions = {}): GatewayRequestHandlers {
  let sharedRuntime = options.runtime;
  const resolveRuntime = () => {
    if (sharedRuntime) {
      return sharedRuntime;
    }
    sharedRuntime = (options.createRuntime ?? createOpenClawA2ABrokerRuntime)();
    return sharedRuntime;
  };

  const buildReplyContext = options.buildReplyContext ?? defaultBuildReplyContext;
  const buildAnnounceContext = options.buildAnnounceContext ?? defaultBuildAnnounceContext;
  const isReplySkip = options.isReplySkip ?? defaultIsReplySkip;
  const isAnnounceSkip = options.isAnnounceSkip ?? defaultIsAnnounceSkip;

  return {
    "a2a.task.request": async ({ params, respond, context }) => {
      if (!assertValidParams(params, validateA2ATaskRequestParams, "a2a.task.request", respond)) {
        return;
      }
      try {
        const result = await runA2ATaskRequest({
          request: params.request,
          runtime: resolveRuntime(),
          buildReplyContext,
          buildAnnounceContext,
          isReplySkip,
          isAnnounceSkip,
        });
        respond(true, result.response);
      } catch (err) {
        const failureMessage = formatA2AActionFailureMessage("request", err, {
          targetSessionKey: params.request.target.sessionKey,
        });
        context.logGateway.error(failureMessage);
        respond(false, undefined, errorShape(ErrorCodes.INTERNAL, failureMessage));
      }
    },

    "a2a.task.update": async ({ params, respond, context }) => {
      if (!assertValidParams(params, validateA2ATaskUpdateParams, "a2a.task.update", respond)) {
        return;
      }
      try {
        const result = await applyA2ATaskProtocolUpdate({
          sessionKey: params.sessionKey,
          update: params.update,
        });
        if (!result) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.NOT_FOUND,
              formatA2ATaskNotFoundMessage({
                taskId: params.update.taskId,
                sessionKey: params.sessionKey,
              }),
            ),
          );
          return;
        }
        respond(true, result);
      } catch (err) {
        const failureMessage = formatA2AActionFailureMessage("update", err, {
          taskId: params.update.taskId,
          sessionKey: params.sessionKey,
        });
        context.logGateway.error(failureMessage);
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, failureMessage));
      }
    },

    "a2a.task.cancel": async ({ params, respond, context }) => {
      if (!assertValidParams(params, validateA2ATaskCancelParams, "a2a.task.cancel", respond)) {
        return;
      }
      try {
        const result = await applyA2ATaskProtocolCancel({
          sessionKey: params.sessionKey,
          cancel: params.cancel,
          runtime: resolveRuntime(),
        });
        if (!result) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.NOT_FOUND,
              formatA2ATaskNotFoundMessage({
                taskId: params.cancel.taskId,
                sessionKey: params.sessionKey,
              }),
            ),
          );
          return;
        }
        respond(true, result);
      } catch (err) {
        const failureMessage = formatA2AActionFailureMessage("cancel", err, {
          taskId: params.cancel.taskId,
          sessionKey: params.sessionKey,
        });
        context.logGateway.error(failureMessage);
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, failureMessage));
      }
    },

    "a2a.task.status": async ({ params, respond, context }) => {
      if (!assertValidParams(params, validateA2ATaskStatusParams, "a2a.task.status", respond)) {
        return;
      }
      try {
        const result = await loadA2ATaskProtocolStatusById({
          sessionKey: params.sessionKey,
          taskId: params.taskId,
        });
        if (!result) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.NOT_FOUND,
              formatA2ATaskNotFoundMessage({
                taskId: params.taskId,
                sessionKey: params.sessionKey,
              }),
            ),
          );
          return;
        }
        respond(true, result);
      } catch (err) {
        const failureMessage = formatA2AActionFailureMessage("status lookup", err, {
          taskId: params.taskId,
          sessionKey: params.sessionKey,
        });
        context.logGateway.error(failureMessage);
        respond(false, undefined, errorShape(ErrorCodes.INTERNAL, failureMessage));
      }
    },
  };
}

export const a2aHandlers = createA2AHandlers();
