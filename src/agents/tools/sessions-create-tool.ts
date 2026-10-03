import { createHash } from "node:crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { SessionsCreateParams } from "../../../packages/gateway-protocol/src/schema/sessions-create.js";
import { operatorScopeSatisfied } from "../../shared/operator-scope-compat.js";
import {
  assertAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../admitted-run-context.js";
import {
  jsonResult,
  readToolStringParam,
  ToolAuthorizationError,
  ToolInputError,
  type AnyAgentTool,
} from "./common.js";
import {
  captureGatewayToolCallerAssertion,
  getGatewayToolCallerIdentity,
  resolveGatewayToolOperatorSelection,
  withGatewayPersonalToolUser,
} from "./gateway-caller-context.js";
import {
  bindAgentToolGatewayRequest,
  getInProcessGatewayToolContext,
  type AgentToolGatewayRequestCaller,
} from "./in-process-gateway.js";
import { SessionsCreateToolSchema } from "./sessions-create-tool-schema.js";
import { hasSessionWriteAuthority } from "./sessions-operator-authority.js";

/** The existing creation owner grants access; model input only selects destination settings. */
async function createSessionFromTool(
  params: Record<string, unknown>,
  toolCallId: string,
  signal?: AbortSignal,
  callGateway?: AgentToolGatewayRequestCaller,
) {
  const caller = getGatewayToolCallerIdentity();
  const assertCallerCurrent = captureGatewayToolCallerAssertion();
  const selection = resolveGatewayToolOperatorSelection();
  const authority = selection.operatorAuthority;
  if (
    !caller?.operationalRunInstance ||
    !assertCallerCurrent ||
    !authority ||
    !getInProcessGatewayToolContext()
  ) {
    throw new ToolAuthorizationError(
      "Session creation requires its live admitted operator and in-process Gateway",
    );
  }
  signal?.throwIfAborted();
  assertAdmittedRunOperatorAuthority(authority);
  selection.assertCurrent();
  assertCallerCurrent("sessions.create");
  if (!operatorScopeSatisfied("operator.sessions.write", authority.scopes)) {
    throw new ToolAuthorizationError("Session creation requires current session write authority");
  }
  const unknown = Object.keys(params).filter(
    (key) => !Object.hasOwn(SessionsCreateToolSchema.properties, key),
  );
  if (unknown.length) {
    throw new ToolInputError("sessions_create does not accept: " + unknown.join(", "));
  }
  const readOption = (key: string) =>
    params[key] === undefined ? undefined : readToolStringParam(params, key, { required: true });
  const message =
    params.message === undefined
      ? undefined
      : readToolStringParam(params, "message", { required: true, trim: false });
  if (message !== undefined && !message.trim()) {
    throw new ToolInputError("message must not be blank");
  }
  const permissionMode = readOption("permissionMode");
  if (
    permissionMode !== undefined &&
    permissionMode !== "read-only" &&
    permissionMode !== "guarded" &&
    permissionMode !== "workspace" &&
    permissionMode !== "full"
  ) {
    throw new ToolInputError("Invalid permissionMode");
  }
  const request: SessionsCreateParams = {
    agentId: readOption("agentId") ?? caller.agentId,
    ...(message !== undefined ? { message } : {}),
    label: readOption("label"),
    cwd: readOption("cwd"),
    category: readOption("group"),
    model: readOption("model"),
    permissionMode,
    // Same admitted run/tool call reconciles against the backend's bounded retry cache.
    idempotencyKey:
      "sessions-create:" +
      createHash("sha256")
        .update(JSON.stringify([caller.operationalRunInstance.instanceId, toolCallId]))
        .digest("hex"),
  };
  const gatewayRequest =
    callGateway ?? bindAgentToolGatewayRequest({ revalidateOnCompletion: false });
  const result = await gatewayRequest<{
    key: string;
    sessionId: string;
    runStarted: boolean;
    runId?: string;
    runError?: { code: string; message: string };
  }>({
    method: "sessions.create",
    params: request,
    sessionCreation: {
      via: "operator",
      actor: { type: "human", source: "profile", id: authority.profileId },
      requesterSessionKey: caller.sessionKey,
    },
    agentToolCaller: {
      agentId: caller.agentId,
      sessionKey: caller.sessionKey,
      assertCurrent: () => {
        signal?.throwIfAborted();
        selection.assertCurrent();
        assertCallerCurrent("sessions.create");
      },
    },
  });
  return jsonResult({
    sessionKey: result.key,
    sessionId: result.sessionId,
    runStarted: result.runStarted,
    ...(result.runId ? { runId: result.runId } : {}),
    ...(result.runError
      ? { runError: { code: result.runError.code, message: result.runError.message } }
      : {}),
  });
}

export function createSessionsCreateTool(
  opts: {
    sessionControlAuthority?: AdmittedRunOperatorAuthority;
    callGateway?: AgentToolGatewayRequestCaller;
  } = {},
): AnyAgentTool | null {
  if (!hasSessionWriteAuthority(opts.sessionControlAuthority)) {
    return null;
  }
  return {
    label: "Create Session",
    name: "sessions_create",
    description:
      "Create a normal independent persistent visible session, optionally starting work with message. Omit message for an idle session. Uses destination defaults, not a supervised child or transcript fork. Returns sessionKey, sessionId, and runStarted, plus runId or runError when available. Creation and initial-run acceptance are separate; a startup failure leaves the session available. No child completion event or yield expectation.",
    parameters: SessionsCreateToolSchema,
    execute: async (toolCallId, rawArgs, signal) => {
      const params = asOptionalRecord(rawArgs);
      if (!params) {
        throw new ToolInputError("sessions_create requires an object");
      }
      // The creation owner fences selection through COMMIT/input acceptance. Its
      // receipt remains valid if that turn ends or gains a participant afterward.
      return await withGatewayPersonalToolUser(readToolStringParam(params, "user"), () =>
        createSessionFromTool(params, toolCallId, signal, opts.callGateway),
      );
    },
  };
}
