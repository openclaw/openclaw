/**
 * Nested agent-step executor.
 *
 * Sends annotated inter-session messages through Gateway admission and reads the assistant reply.
 */
import crypto from "node:crypto";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { mintAgentRuntimeIdentityToken } from "../../gateway/agent-runtime-identity-token.js";
import { callGateway } from "../../gateway/call.js";
import type { TurnAuthoritySnapshot } from "../../plugins/authorization-policy.types.js";
import { isIssuedTurnAuthoritySnapshot } from "../../plugins/turn-authority.js";
import {
  normalizeAgentId,
  normalizeOptionalAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import { annotateInterSessionPromptText } from "../../sessions/input-provenance.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { retireSessionMcpRuntimeForAgentSessionKey } from "../agent-bundle-mcp-tools.js";
import { waitForAgentRunAndReadUpdatedAssistantReply } from "../run-wait.js";
import { resolveSessionsSendNestedLane } from "./sessions-send-helpers.js";

type GatewayCaller = typeof callGateway;

const defaultAgentStepDeps = {
  callGateway,
};

let agentStepDeps: {
  callGateway: GatewayCaller;
} = defaultAgentStepDeps;

function extractAgentCommandReply(result: unknown): string | undefined {
  const candidate = result as { meta?: { error?: unknown }; payloads?: unknown } | null | undefined;
  const error =
    candidate?.meta?.error &&
    typeof candidate.meta.error === "object" &&
    !Array.isArray(candidate.meta.error)
      ? (candidate.meta.error as { kind?: unknown; terminalPresentation?: unknown })
      : undefined;
  // Plain incomplete-turn output is a control failure; trusted terminal tool presentations remain deliverable.
  if (error?.kind === "incomplete_turn" && error.terminalPresentation !== true) {
    return undefined;
  }
  const payloads = candidate?.payloads;
  if (!Array.isArray(payloads)) {
    return undefined;
  }
  const texts = payloads
    .map((payload) =>
      payload &&
      typeof payload === "object" &&
      typeof (payload as { text?: unknown }).text === "string"
        ? (payload as { text: string }).text
        : "",
    )
    .filter((text) => text.trim().length > 0);
  return texts.length > 0 ? texts.join("\n\n") : undefined;
}

/** Sends one annotated message to a target session and returns the resulting assistant text. */
export async function runAgentStep(params: {
  sessionKey: string;
  targetAgentId?: string;
  message: string;
  extraSystemPrompt: string;
  timeoutMs: number;
  channel?: string;
  lane?: string;
  transcriptMessage?: string;
  sourceSessionKey?: string;
  sourceChannel?: string;
  sourceTool?: string;
  turnAuthority?: TurnAuthoritySnapshot;
}): Promise<string | undefined> {
  if (!isIssuedTurnAuthoritySnapshot(params.turnAuthority)) {
    throw new Error("nested sessions_send agent step requires trusted turn authority");
  }
  const sourceAgentId = params.turnAuthority.authorization.agentId;
  const sourceSessionKey = params.turnAuthority.authorization.sessionKey;
  if (!sourceAgentId || !sourceSessionKey) {
    throw new Error("nested sessions_send agent step requires bound source authority");
  }
  const targetSessionAgentId = parseAgentSessionKey(params.sessionKey)?.agentId;
  const explicitTargetAgentId = normalizeOptionalAgentId(params.targetAgentId);
  const targetNeedsAgentBinding = !targetSessionAgentId;
  if (targetNeedsAgentBinding && !explicitTargetAgentId) {
    throw new Error("nested sessions_send unscoped target requires an explicit agent id");
  }
  const targetAgentId = explicitTargetAgentId ?? normalizeAgentId(targetSessionAgentId);
  if (
    targetSessionAgentId &&
    explicitTargetAgentId &&
    targetAgentId !== normalizeAgentId(targetSessionAgentId)
  ) {
    throw new Error("nested sessions_send target agent does not match its session key");
  }
  const stepIdem = crypto.randomUUID();
  const inputProvenance = {
    kind: "inter_session" as const,
    sourceSessionKey: params.sourceSessionKey,
    sourceChannel: params.sourceChannel,
    sourceTool: params.sourceTool ?? "sessions_send",
  };
  // Mark inter-session prompts so downstream transcripts can distinguish tool-routed text.
  const message = annotateInterSessionPromptText(params.message, inputProvenance);
  const lane = params.lane ?? resolveSessionsSendNestedLane(params.sessionKey, targetAgentId);
  const channel = params.channel ?? INTERNAL_MESSAGE_CHANNEL;
  const transcriptMessage = params.transcriptMessage;
  const request = {
    message,
    sessionKey: params.sessionKey,
    idempotencyKey: stepIdem,
    deliver: false,
    sourceReplyDeliveryMode: "message_tool_only" as const,
    channel,
    lane,
    extraSystemPrompt: params.extraSystemPrompt,
    inputProvenance,
    ...(targetNeedsAgentBinding ? { agentId: targetAgentId } : {}),
    ...(transcriptMessage === "" ? { suppressPromptPersistence: true } : {}),
  };
  const agentRuntimeIdentityToken = await mintAgentRuntimeIdentityToken({
    agentId: sourceAgentId,
    sessionKey: sourceSessionKey,
    gatewayMethods: ["agent"],
    sessionsSendDelegation: {
      targetAgentId,
      targetSessionKey: params.sessionKey,
      request,
      turnAuthority: params.turnAuthority,
      ...(transcriptMessage !== undefined && transcriptMessage !== "" ? { transcriptMessage } : {}),
    },
  });
  const response = await agentStepDeps.callGateway({
    method: "agent",
    params: request,
    timeoutMs: transcriptMessage !== undefined ? params.timeoutMs : 10_000,
    clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
    clientDisplayName: "agent",
    mode: GATEWAY_CLIENT_MODES.BACKEND,
    scopes: ["operator.write"],
    requireLocalBackendSharedAuth: true,
    agentRuntimeIdentityToken,
    ...(transcriptMessage !== undefined ? { expectFinal: true } : {}),
  });

  if (transcriptMessage !== undefined) {
    await retireSessionMcpRuntimeForAgentSessionKey({
      agentId: targetAgentId,
      sessionKey: params.sessionKey,
      reason: "nested-agent-step-complete",
    });
    return extractAgentCommandReply(response?.result);
  }

  const stepRunId = typeof response?.runId === "string" && response.runId ? response.runId : "";
  const resolvedRunId = stepRunId || stepIdem;
  // Gateway agent calls can return before the assistant reply is persisted.
  const result = await waitForAgentRunAndReadUpdatedAssistantReply({
    runId: resolvedRunId,
    sessionKey: params.sessionKey,
    agentId: targetAgentId,
    timeoutMs: Math.min(params.timeoutMs, 60_000),
  });
  if (result.status === "ok" || result.status === "error") {
    await retireSessionMcpRuntimeForAgentSessionKey({
      agentId: targetAgentId,
      sessionKey: params.sessionKey,
      reason: "nested-agent-step-complete",
    });
  }
  if (result.status !== "ok") {
    return undefined;
  }
  return result.replyText;
}

/** Test-only dependency overrides for gateway and in-process command execution. */
const testing = {
  setDepsForTest(
    overrides?: Partial<{
      callGateway: GatewayCaller;
    }>,
  ) {
    agentStepDeps = overrides
      ? {
          ...defaultAgentStepDeps,
          ...overrides,
        }
      : defaultAgentStepDeps;
  },
};

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.agentStepTestApi")] = {
    testing,
  };
}
