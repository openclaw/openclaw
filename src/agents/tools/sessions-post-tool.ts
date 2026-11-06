import { formatErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createRuntimeConfigReader } from "../../config/runtime-snapshot.js";
import { createSessionVisibilityDecisionChecker } from "../../plugin-sdk/session-visibility-internal.js";
import { resolveSessionAgentIds } from "../agent-scope.js";
import { ToolInputError } from "../tool-input-error.js";
import { jsonResult, readToolStringParam } from "./common.js";
import {
  captureGatewayToolCallerAssertion,
  getGatewayToolCallerIdentity,
} from "./gateway-caller-context.js";
import { callAgentToolGatewayRequest } from "./in-process-gateway.js";
import { resolveSessionToolTargetAgentId } from "./scoped-session-access.js";
import {
  createAgentToAgentPolicy,
  formatSessionToolAccessDenial,
  isSessionToolRequesterCreator,
  readDescribedSessionVisibilityRow,
  resolveEffectiveSessionToolsVisibility,
  resolveSessionToolAccess,
  resolveSessionToolCreatorReadAccess,
} from "./sessions-access.js";
import { resolveSessionToolContext } from "./sessions-helpers.js";
import { readSessionCommunicationEndpoint } from "./sessions-send-communication-endpoint.js";
import { prepareSessionsSendCommunication } from "./sessions-send-communication.js";
import { sendFailure } from "./sessions-send-helpers.js";
import type { SessionsSendToolOptions } from "./sessions-send-tool.types.js";

/** Posting is a transcript mutation, deliberately separate from send/steer preparation. */
export async function executeSessionPost(
  opts: SessionsSendToolOptions | undefined,
  toolCallId: string,
  params: Record<string, unknown>,
  message: string,
) {
  const key = readToolStringParam(params, "sessionKey", { required: true });
  if (
    params.label !== undefined ||
    params.attachments !== undefined ||
    params.media !== undefined
  ) {
    throw new ToolInputError("post requires an explicit sessionKey and text only");
  }
  const callGateway = opts?.callGateway ?? callAgentToolGatewayRequest;
  const described = await callGateway<{ session?: unknown }>({
    method: "sessions.describe",
    params: { key, agentId: readToolStringParam(params, "agentId") },
  });
  const session = described?.session;
  if (!isRecord(session) || !isSessionToolRequesterCreator(session.createdActor)) {
    return sendFailure(
      "forbidden",
      "Posts require a session created by the authenticated requesting human.",
    );
  }
  const targetRow = readDescribedSessionVisibilityRow(session);
  if (!targetRow || typeof session.sessionId !== "string") {
    throw new ToolInputError("Target session is not available. Resolve it again and retry.");
  }
  const context = resolveSessionToolContext(opts);
  const requesterSessionKey =
    context.effectiveRequesterKey ?? getGatewayToolCallerIdentity()?.sessionKey;
  if (!requesterSessionKey) {
    throw new ToolInputError("Source session context is unavailable for posting.");
  }
  const requesterAgentId = resolveSessionAgentIds({
    config: context.cfg,
    sessionKey: requesterSessionKey,
  }).sessionAgentId;
  const targetAgentId = resolveSessionToolTargetAgentId({
    cfg: context.cfg,
    targetSessionKey: targetRow.key,
    resolvedAgentId: targetRow.agentId,
    requesterAgentId,
  });
  const access = await resolveSessionToolAccess({
    action: "history",
    allowCreatorRead: true,
    requesterAgentId,
    requesterSessionKey,
    mainSessionKey: context.mainSessionKey,
    targetAgentId,
    targetSessionKey: targetRow.key,
    requesterOwned: false,
    visibility: context.sessionVisibility,
    a2aPolicy: context.a2aPolicy,
    sandboxed: opts?.sandboxed,
    callGateway,
  });
  if (!access.allowed) {
    return sendFailure(
      "forbidden",
      formatSessionToolAccessDenial(access, {
        action: "send",
        targetSessionKey: targetRow.key,
      }),
    );
  }
  // Reuse the send decision so explicit outbound denials and native-child exceptions agree.
  // Preserve only the authenticated creator's tree exception; this never admits a turn.
  const readConfig = createRuntimeConfigReader(context.cfg);
  const assertOutbound = () => {
    const cfg = readConfig();
    const decision = resolveSessionToolCreatorReadAccess(
      createSessionVisibilityDecisionChecker({
        action: "send",
        defaultAgentId: targetAgentId,
        requesterAgentId,
        requesterSessionKey,
        mainSessionKey: context.mainSessionKey,
        visibility: resolveEffectiveSessionToolsVisibility({
          cfg,
          sandboxed: opts?.sandboxed === true,
        }),
        a2aPolicy: createAgentToAgentPolicy(cfg, { sandboxed: opts?.sandboxed }),
      }).check(targetRow),
      session.createdActor,
    );
    if (!decision.allowed) {
      throw new Error(
        formatSessionToolAccessDenial(decision, {
          action: "send",
          targetSessionKey: targetRow.key,
        }),
      );
    }
  };
  let communication: Awaited<ReturnType<typeof prepareSessionsSendCommunication>>;
  try {
    assertOutbound();
    const assertCaller = captureGatewayToolCallerAssertion();
    const [source, target] = await Promise.all([
      readSessionCommunicationEndpoint({
        config: context.cfg,
        endpoint: { agentId: requesterAgentId, sessionKey: requesterSessionKey, storePath: "" },
        assertCurrent: () => assertCaller?.(),
      }),
      readSessionCommunicationEndpoint({
        config: context.cfg,
        endpoint: { agentId: targetAgentId, sessionKey: targetRow.key, storePath: "" },
        assertCurrent: () => assertCaller?.(),
      }),
    ]);
    communication = await prepareSessionsSendCommunication({
      config: context.cfg,
      intent: "passive-post",
      source,
      target,
      message,
      access: { sandboxed: opts?.sandboxed, expectedSessionId: session.sessionId },
      assertAccessCurrent: assertOutbound,
      callGateway,
    });
  } catch (error) {
    return sendFailure("forbidden", formatErrorMessage(error));
  }
  try {
    const receipt = await callGateway({
      method: "sessions.post",
      sessionMutationCommitGuard: communication.assertCurrent,
      params: {
        sessionKey: targetRow.key,
        agentId: targetAgentId,
        expectedSessionId: session.sessionId,
        message,
        idempotencyKey: readToolStringParam(params, "idempotencyKey") ?? toolCallId,
      },
    });
    return jsonResult(receipt);
  } finally {
    communication.close();
  }
}
