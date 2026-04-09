import crypto from "node:crypto";
import { resolveSessionAgentId } from "../agents/agent-scope.js";
import { spawnSubagentDirect } from "../agents/subagent-spawn.js";
import { isControlCommandMessage } from "../auto-reply/command-detection.js";
import type { ReplyDispatcher } from "../auto-reply/reply/reply-dispatcher.js";
import type { FinalizedMsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/config.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";
import { isTaskOsRolloutLaneEnabled } from "./task-os-rollout.js";
import { updateTask, upsertCanonicalTask } from "./task-os-store.js";

type IngressStageAgent = "research" | "spec" | "builder";

type IngressStage = {
  id: string;
  agentId: IngressStageAgent;
  label: string;
  prompt: string;
};

export type ChatIngressOrchestratorResult = {
  handled: boolean;
  taskId?: string;
  stageIds?: string[];
  ackText?: string;
};

function trimToUndefined(value: string | undefined | null): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : undefined;
}

function extractChatBody(ctx: FinalizedMsgContext): string {
  return trimToUndefined(ctx.BodyForCommands ?? ctx.CommandBody ?? ctx.RawBody ?? ctx.Body) ?? "";
}

function normalizeSourceKind(ctx: FinalizedMsgContext): "slack" | "telegram" | undefined {
  const channel = normalizeMessageChannel(ctx.OriginatingChannel ?? ctx.Surface ?? ctx.Provider);
  if (channel === "slack" || channel === "telegram") {
    return channel;
  }
  return undefined;
}

function shouldPromote(ctx: FinalizedMsgContext, cfg: OpenClawConfig): boolean {
  if (!isTaskOsRolloutLaneEnabled("approval_inbox")) {
    return false;
  }
  const sourceKind = normalizeSourceKind(ctx);
  if (!sourceKind) {
    return false;
  }
  const body = extractChatBody(ctx);
  if (!body || body.length < 12) {
    return false;
  }
  if (isControlCommandMessage(body, cfg)) {
    return false;
  }
  const lowered = body.toLowerCase();
  return [
    "implement",
    "fix",
    "build",
    "research",
    "analyze",
    "plan",
    "spec",
    "조사",
    "분석",
    "계획",
    "설계",
    "구현",
    "개발",
    "보완",
    "수정",
    "테스트",
  ].some((token) => lowered.includes(token));
}

function classifyStages(body: string): IngressStage[] {
  const lowered = body.toLowerCase();
  const includeResearch = ["research", "analyze", "조사", "분석", "리서치", "문서", "논문"].some(
    (token) => lowered.includes(token),
  );
  const includeBuild = [
    "implement",
    "fix",
    "build",
    "code",
    "구현",
    "개발",
    "수정",
    "보완",
    "테스트",
  ].some((token) => lowered.includes(token));
  const includeSpec =
    includeBuild ||
    ["plan", "spec", "설계", "기획", "계획"].some((token) => lowered.includes(token));
  const stages: IngressStage[] = [];
  if (includeResearch) {
    stages.push({
      id: "research",
      agentId: "research",
      label: "Research",
      prompt: `Analyze the user's request and gather the minimum facts needed before implementation.\n\nUser request:\n${body}`,
    });
  }
  if (includeSpec) {
    stages.push({
      id: includeBuild ? "spec-plan" : "spec-only",
      agentId: "spec",
      label: includeBuild ? "Spec/Plan" : "Spec",
      prompt: `Turn the user's request into an executable implementation plan.\n\nUser request:\n${body}`,
    });
  }
  if (includeBuild) {
    stages.push({
      id: "builder",
      agentId: "builder",
      label: "Builder",
      prompt: `Implement the user's request once the required context is available. Keep verification in scope and report concrete outputs only.\n\nUser request:\n${body}`,
    });
    stages.push({
      id: "verifier",
      agentId: "spec",
      label: "Verifier",
      prompt: `Review whether the implemented result actually satisfies the user's request and identify concrete gaps before approval/execution.\n\nUser request:\n${body}`,
    });
  }
  return stages;
}

async function spawnStageSessions(params: {
  ctx: FinalizedMsgContext;
  requesterAgentId: string;
  stages: IngressStage[];
}): Promise<Array<{ id: string; status: string; childSessionKey?: string }>> {
  const results = [] as Array<{ id: string; status: string; childSessionKey?: string }>;
  for (const stage of params.stages) {
    const result = await spawnSubagentDirect(
      {
        task: stage.prompt,
        label: stage.label,
        agentId: stage.agentId,
        thread: true,
        mode: "run",
      },
      {
        agentSessionKey: params.ctx.SessionKey,
        agentChannel: String(
          params.ctx.OriginatingChannel ?? params.ctx.Surface ?? params.ctx.Provider ?? "",
        ),
        agentAccountId: params.ctx.AccountId,
        agentTo: params.ctx.OriginatingTo ?? params.ctx.To,
        agentThreadId: params.ctx.MessageThreadId,
        requesterAgentIdOverride: params.requesterAgentId,
      },
    );
    results.push({
      id: stage.id,
      status: result.status,
      childSessionKey: result.childSessionKey,
    });
  }
  return results;
}

export async function maybeHandleChatIngressOrchestration(params: {
  ctx: FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcher: ReplyDispatcher;
}): Promise<ChatIngressOrchestratorResult> {
  const { ctx, cfg, dispatcher } = params;
  const requesterAgentId = resolveSessionAgentId({ sessionKey: ctx.SessionKey, config: cfg });
  if (requesterAgentId !== "quick") {
    return { handled: false };
  }
  if (!shouldPromote(ctx, cfg)) {
    return { handled: false };
  }
  const sourceKind = normalizeSourceKind(ctx);
  if (!sourceKind) {
    return { handled: false };
  }
  const body = extractChatBody(ctx);
  const stages = classifyStages(body);
  if (stages.length === 0) {
    return { handled: false };
  }
  const observedAt = new Date().toISOString();
  const messageId =
    trimToUndefined(
      ctx.MessageSidFull ??
        ctx.MessageSid ??
        (ctx.MessageThreadId != null ? String(ctx.MessageThreadId) : undefined),
    ) ?? crypto.randomUUID();
  const sourceSurface = `${sourceKind}:chat_ingress`;
  const upserted = await upsertCanonicalTask({
    title: body.length > 90 ? `${body.slice(0, 89)}…` : body,
    canonicalWork: {
      source: {
        sourceKind,
        signalKind: "chat_request",
        sourceId: messageId,
        requestId: messageId,
        idempotencyKey: `${sourceKind}:${messageId}`,
        sourceSurface,
        title: body.length > 90 ? `${body.slice(0, 89)}…` : body,
        summary: body,
        observedAt,
        confidence: { score: 0.86, reason: "live chat ingress escalation" },
        externalLinks: ctx.OriginatingTo
          ? [
              {
                system: sourceKind,
                externalId: String(ctx.OriginatingTo),
                title: "chat ingress",
              },
            ]
          : undefined,
      },
    },
    evidence: [
      {
        summary: `ingress orchestrator staged ${stages.map((stage) => stage.id).join(" -> ")}`,
        kind: "ingress_orchestrator",
        source: sourceSurface,
        provenanceTier: "runtime_evidence",
      },
    ],
  });

  const spawnResults = await spawnStageSessions({
    ctx,
    requesterAgentId,
    stages,
  });
  await updateTask(upserted.task.id, {
    evidence: spawnResults.map((stage) => ({
      summary: `${stage.id}: ${stage.status}${stage.childSessionKey ? ` (${stage.childSessionKey})` : ""}`,
      kind: "ingress_stage_spawn",
      source: sourceSurface,
      provenanceTier: "runtime_evidence",
    })),
  });

  const ackText = [
    `작업을 OpenClaw work queue에 등록했어요.`,
    `task=${upserted.task.id}`,
    `stages=${stages.map((stage) => stage.id).join(" -> ")}`,
  ].join("\n");
  dispatcher.sendFinalReply({ text: ackText });
  return {
    handled: true,
    taskId: upserted.task.id,
    stageIds: stages.map((stage) => stage.id),
    ackText,
  };
}
