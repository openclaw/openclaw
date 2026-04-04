import crypto from "node:crypto";
import { callGateway } from "../../gateway/call.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { AGENT_LANE_NESTED } from "../lanes.js";
import { extractAssistantText, stripToolMessages } from "./chat-history-text.js";

type GatewayCaller = typeof callGateway;

const defaultAgentStepDeps = {
  callGateway,
};

let agentStepDeps: {
  callGateway: GatewayCaller;
} = defaultAgentStepDeps;

export type AssistantReplySnapshot = {
  text?: string;
  fingerprint?: string;
};

export type AgentWaitResult = {
  status: "ok" | "timeout" | "error";
  error?: string;
  startedAt?: number;
  endedAt?: number;
};

type RawAgentWaitResponse = {
  status?: string;
  error?: string;
  startedAt?: unknown;
  endedAt?: unknown;
};

function normalizeAgentWaitResult(
  status: AgentWaitResult["status"],
  wait?: RawAgentWaitResponse,
): AgentWaitResult {
  return {
    status,
    error: typeof wait?.error === "string" ? wait.error : undefined,
    startedAt: typeof wait?.startedAt === "number" ? wait.startedAt : undefined,
    endedAt: typeof wait?.endedAt === "number" ? wait.endedAt : undefined,
  };
}

function resolveLatestAssistantReplySnapshot(messages: unknown[]): AssistantReplySnapshot {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const candidate = messages[i];
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    if ((candidate as { role?: unknown }).role !== "assistant") {
      continue;
    }
    const text = extractAssistantText(candidate);
    if (!text?.trim()) {
      continue;
    }
    let fingerprint: string | undefined;
    try {
      fingerprint = JSON.stringify(candidate);
    } catch {
      fingerprint = text;
    }
    return { text, fingerprint };
  }
  return {};
}

export async function readLatestAssistantReplySnapshot(params: {
  sessionKey: string;
  limit?: number;
  callGateway?: GatewayCaller;
}): Promise<AssistantReplySnapshot> {
  const history = await (params.callGateway ?? agentStepDeps.callGateway)<{
    messages: Array<unknown>;
  }>({
    method: "chat.history",
    params: { sessionKey: params.sessionKey, limit: params.limit ?? 50 },
  });
  return resolveLatestAssistantReplySnapshot(
    stripToolMessages(Array.isArray(history?.messages) ? history.messages : []),
  );
}

export async function readLatestAssistantReply(params: {
  sessionKey: string;
  limit?: number;
}): Promise<string | undefined> {
  return (
    await readLatestAssistantReplySnapshot({
      sessionKey: params.sessionKey,
      limit: params.limit,
    })
  ).text;
}

export async function waitForAgentRun(params: {
  runId: string;
  timeoutMs: number;
  callGateway?: GatewayCaller;
}): Promise<AgentWaitResult> {
  const timeoutMs = Math.max(1, Math.floor(params.timeoutMs));
  try {
    const wait = await (params.callGateway ?? agentStepDeps.callGateway)<RawAgentWaitResponse>({
      method: "agent.wait",
      params: {
        runId: params.runId,
        timeoutMs,
      },
      timeoutMs: timeoutMs + 2000,
    });
    if (wait?.status === "timeout") {
      return normalizeAgentWaitResult("timeout", wait);
    }
    if (wait?.status === "error") {
      return normalizeAgentWaitResult("error", wait);
    }
    return normalizeAgentWaitResult("ok", wait);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      status: error.includes("gateway timeout") ? "timeout" : "error",
      error,
    };
  }
}

export async function waitForAgentRunAndReadUpdatedAssistantReply(params: {
  runId: string;
  sessionKey: string;
  timeoutMs: number;
  limit?: number;
  baseline?: AssistantReplySnapshot;
  callGateway?: GatewayCaller;
}): Promise<AgentWaitResult & { replyText?: string }> {
  const wait = await waitForAgentRun({
    runId: params.runId,
    timeoutMs: params.timeoutMs,
    callGateway: params.callGateway,
  });
  if (wait.status !== "ok") {
    return wait;
  }

  const latestReply = await readLatestAssistantReplySnapshot({
    sessionKey: params.sessionKey,
    limit: params.limit,
    callGateway: params.callGateway,
  });
  const baselineFingerprint = params.baseline?.fingerprint;
  const replyText =
    latestReply.text && (!baselineFingerprint || latestReply.fingerprint !== baselineFingerprint)
      ? latestReply.text
      : undefined;
  return {
    status: "ok",
    replyText,
  };
}

export async function runAgentStep(params: {
  sessionKey: string;
  message: string;
  extraSystemPrompt: string;
  timeoutMs: number;
  channel?: string;
  lane?: string;
  sourceSessionKey?: string;
  sourceChannel?: string;
  sourceTool?: string;
}): Promise<string | undefined> {
  const stepIdem = crypto.randomUUID();
  const response = await agentStepDeps.callGateway<{ runId?: string }>({
    method: "agent",
    params: {
      message: params.message,
      sessionKey: params.sessionKey,
      idempotencyKey: stepIdem,
      deliver: false,
      channel: params.channel ?? INTERNAL_MESSAGE_CHANNEL,
      lane: params.lane ?? AGENT_LANE_NESTED,
      extraSystemPrompt: params.extraSystemPrompt,
      inputProvenance: {
        kind: "inter_session",
        sourceSessionKey: params.sourceSessionKey,
        sourceChannel: params.sourceChannel,
        sourceTool: params.sourceTool ?? "sessions_send",
      },
    },
    timeoutMs: 10_000,
  });

  const stepRunId = typeof response?.runId === "string" && response.runId ? response.runId : "";
  const resolvedRunId = stepRunId || stepIdem;
  const result = await waitForAgentRunAndReadUpdatedAssistantReply({
    runId: resolvedRunId,
    sessionKey: params.sessionKey,
    timeoutMs: Math.min(params.timeoutMs, 60_000),
  });
  if (result.status !== "ok") {
    return undefined;
  }
  return result.replyText;
}

export const __testing = {
  setDepsForTest(overrides?: Partial<{ callGateway: GatewayCaller }>) {
    agentStepDeps = overrides
      ? {
          ...defaultAgentStepDeps,
          ...overrides,
        }
      : defaultAgentStepDeps;
  },
};
