import crypto from "node:crypto";
import { Type } from "@sinclair/typebox";
import { stringEnum } from "../schema/typebox.js";
import { AtlasHttpError, atlasJsonRequest } from "./atlas-client.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

const ATLAS_EXECUTION_ACTIONS = [
  "agent_card",
  "submit",
  "get",
  "list",
  "events",
  "artifacts",
] as const;

const AtlasExecutionToolSchema = Type.Object({
  action: stringEnum(ATLAS_EXECUTION_ACTIONS),
  taskId: Type.Optional(Type.String()),
  atlasTaskId: Type.Optional(Type.String()),
  title: Type.Optional(Type.String()),
  summary: Type.Optional(Type.String()),
  repo: Type.Optional(Type.String()),
  intent: Type.Optional(Type.String()),
  branch: Type.Optional(Type.String()),
  envName: Type.Optional(Type.String()),
  targetTaskId: Type.Optional(Type.String()),
  sourceTransport: Type.Optional(Type.String()),
  sourceChatId: Type.Optional(Type.String()),
  sourceThreadId: Type.Optional(Type.String()),
  sourceMessageId: Type.Optional(Type.String()),
  sessionId: Type.Optional(Type.String()),
  workThreadId: Type.Optional(Type.String()),
  bitrixTaskId: Type.Optional(Type.String()),
  brief: Type.Optional(Type.String()),
  acceptanceCriteria: Type.Optional(Type.String()),
  nonGoals: Type.Optional(Type.String()),
  verifyPlan: Type.Optional(Type.String()),
  stagePlan: Type.Optional(Type.String()),
  status: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Number({ minimum: 1 })),
});

type AtlasExecutionToolContext = {
  agentChannel?: string;
  agentTo?: string;
  agentThreadId?: string | number;
};

function asNullableText(value: string | number | undefined | null): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized || undefined;
}

function parseTelegramTarget(raw?: string): { chatId?: string; threadId?: string } {
  const value = asNullableText(raw);
  if (!value) {
    return {};
  }
  const directMatch = value.match(/^(?:telegram:)?(?:group|channel):([^:]+):topic:(\d+)$/i);
  if (directMatch) {
    return { chatId: directMatch[1], threadId: directMatch[2] };
  }
  const groupOnlyMatch = value.match(/^(?:telegram:)?(?:group|channel):([^:]+)$/i);
  if (groupOnlyMatch) {
    return { chatId: groupOnlyMatch[1] };
  }
  const prefixedPeerMatch = value.match(/^telegram:([^:]+)$/i);
  if (prefixedPeerMatch) {
    return { chatId: prefixedPeerMatch[1] };
  }
  const suffixMatch = value.match(/^([^:]+):topic:(\d+)$/i);
  if (suffixMatch) {
    return { chatId: suffixMatch[1], threadId: suffixMatch[2] };
  }
  return {};
}

function parseBitrixTarget(raw?: string): { chatId?: string } {
  const value = asNullableText(raw);
  if (!value) {
    return {};
  }
  const prefixedMatch = value.match(/^bitrix:(.+)$/i);
  if (prefixedMatch) {
    return { chatId: asNullableText(prefixedMatch[1]) };
  }
  if (!value.includes(":")) {
    return { chatId: value };
  }
  return {};
}

function inferAtlasSourceContext(params: {
  explicitTransport?: string;
  explicitChatId?: string;
  explicitThreadId?: string;
  bitrixTaskId?: string;
  context?: AtlasExecutionToolContext;
}) {
  const channel = asNullableText(params.context?.agentChannel)?.toLowerCase();
  const parsedTelegramTarget = parseTelegramTarget(params.context?.agentTo);
  const parsedBitrixTarget = parseBitrixTarget(params.context?.agentTo);
  const chatId =
    params.explicitChatId ||
    (channel === "bitrix" ? parsedBitrixTarget.chatId : undefined) ||
    parsedTelegramTarget.chatId;
  const threadId =
    params.explicitThreadId ||
    asNullableText(params.context?.agentThreadId) ||
    parsedTelegramTarget.threadId;
  const explicitTransport = asNullableText(params.explicitTransport);

  if (explicitTransport) {
    return {
      sourceTransport: explicitTransport,
      sourceChatId: chatId,
      sourceThreadId: threadId,
    };
  }

  if (channel === "telegram" && (chatId || threadId)) {
    return {
      sourceTransport: "telegram-topic",
      sourceChatId: chatId,
      sourceThreadId: threadId,
    };
  }

  if (channel === "bitrix" || params.bitrixTaskId) {
    return {
      sourceTransport: "bitrix",
      sourceChatId: chatId,
      sourceThreadId: threadId,
    };
  }

  return {
    sourceTransport: "openclaw",
    sourceChatId: chatId,
    sourceThreadId: threadId,
  };
}

async function resolveAtlasWorkThreadId(params: {
  repo: string;
  branch?: string;
  envName?: string;
  atlasTaskId?: string;
  title?: string;
  summary?: string;
  sourceTransport?: string;
  sourceChatId?: string;
  sourceThreadId?: string;
  bitrixTaskId?: string;
  workThreadId?: string;
}) {
  const explicitWorkThreadId = asNullableText(params.workThreadId);
  if (explicitWorkThreadId) {
    return explicitWorkThreadId;
  }

  const sourceTransport = asNullableText(params.sourceTransport)?.toLowerCase();
  const sourceChatId = asNullableText(params.sourceChatId);
  const sourceThreadId = asNullableText(params.sourceThreadId);
  const bitrixTaskId = asNullableText(params.bitrixTaskId);
  const atlasTaskId = asNullableText(params.atlasTaskId);

  if (
    /^(telegram-topic|telegram_topic|telegram)$/i.test(String(sourceTransport || "")) &&
    sourceChatId &&
    sourceThreadId
  ) {
    const lookup = await atlasJsonRequest<{ workThread?: { id?: string | null } | null }>(
      "/api/runtime/work-threads/by-topic",
      {
        query: {
          chat_id: sourceChatId,
          thread_id: sourceThreadId,
        },
      },
    );
    const existingId = asNullableText(lookup?.workThread?.id);
    if (existingId) {
      return existingId;
    }
    const ensured = await atlasJsonRequest<{ workThread?: { id?: string | null } | null }>(
      "/api/runtime/work-threads/ensure",
      {
        method: "POST",
        body: {
          repo: params.repo,
          status: "active",
          ownerTransport: "telegram",
          telegramChatId: sourceChatId,
          telegramTopicId: sourceThreadId,
          atlasTaskId: atlasTaskId || null,
          branch: asNullableText(params.branch) || null,
          envName: asNullableText(params.envName) || null,
          bitrixTaskId: bitrixTaskId || null,
          title: asNullableText(params.title) || null,
          summary: asNullableText(params.summary) || asNullableText(params.title) || null,
          metadata: {
            sourceAgent: "openclaw",
          },
        },
      },
    );
    return asNullableText(ensured?.workThread?.id);
  }

  if (bitrixTaskId) {
    const payload = await atlasJsonRequest<{ workThreads?: Array<{ id?: string | null }> }>(
      "/api/runtime/work-threads",
      {
        query: {
          bitrix_task_id: bitrixTaskId,
          limit: 1,
        },
      },
    );
    const existingId = asNullableText(payload?.workThreads?.[0]?.id);
    if (existingId) {
      return existingId;
    }
    const ensured = await atlasJsonRequest<{ workThread?: { id?: string | null } | null }>(
      "/api/runtime/work-threads/ensure",
      {
        method: "POST",
        body: {
          repo: params.repo,
          status: "active",
          ownerTransport: "bitrix",
          atlasTaskId: atlasTaskId || null,
          branch: asNullableText(params.branch) || null,
          envName: asNullableText(params.envName) || null,
          bitrixTaskId: bitrixTaskId,
          bitrixChatId: sourceChatId || null,
          title: asNullableText(params.title) || null,
          summary: asNullableText(params.summary) || asNullableText(params.title) || null,
          metadata: {
            sourceAgent: "openclaw",
          },
        },
      },
    );
    return asNullableText(ensured?.workThread?.id);
  }

  return undefined;
}

async function resolveA2ATaskId(params: {
  taskId?: string;
  atlasTaskId?: string;
  repo?: string;
  sourceTransport?: string;
  sourceChatId?: string;
  sourceThreadId?: string;
}): Promise<string> {
  const explicitTaskId = asNullableText(params.taskId);
  if (explicitTaskId) {
    await assertA2ATaskIdentity(explicitTaskId, {
      atlasTaskId: params.atlasTaskId,
      sourceTransport: params.sourceTransport,
      sourceChatId: params.sourceChatId,
      sourceThreadId: params.sourceThreadId,
    });
    return explicitTaskId;
  }
  const atlasTaskId = asNullableText(params.atlasTaskId);
  const sourceTransport = asNullableText(params.sourceTransport);
  const sourceChatId = asNullableText(params.sourceChatId);
  const sourceThreadId = asNullableText(params.sourceThreadId);
  const isTopicScopedSource = /^(telegram-topic|telegram_topic|telegram)$/i.test(
    String(sourceTransport || ""),
  );
  if (!atlasTaskId && !isTopicScopedSource) {
    throw new Error("taskId required");
  }
  if (!atlasTaskId && (!sourceChatId || !sourceThreadId)) {
    throw new Error("sourceChatId and sourceThreadId required for source-based task recovery");
  }
  const payload = await atlasJsonRequest<{
    tasks?: Array<{ id?: string | null; status?: string | null; createdAt?: string | null }>;
  }>("/api/a2a/tasks", {
    query: {
      atlas_task_id: atlasTaskId,
      source_transport: sourceTransport,
      source_chat_id: sourceChatId,
      source_thread_id: sourceThreadId,
      repo: asNullableText(params.repo),
      limit: 20,
    },
  });
  const resolvedTaskId = selectPreferredA2ATaskId(payload?.tasks || []);
  if (!resolvedTaskId) {
    if (atlasTaskId) {
      throw new Error(`a2a task not found for atlasTaskId ${atlasTaskId}`);
    }
    throw new Error("a2a task not found for the provided source context");
  }
  return resolvedTaskId;
}

async function assertA2ATaskIdentity(
  taskId: string,
  expected: {
    atlasTaskId?: string;
    sourceTransport?: string;
    sourceChatId?: string;
    sourceThreadId?: string;
  },
): Promise<void> {
  const expectedAtlasTaskId = asNullableText(expected.atlasTaskId);
  const expectedSourceTransport = asNullableText(expected.sourceTransport);
  const expectedSourceChatId = asNullableText(expected.sourceChatId);
  const expectedSourceThreadId = asNullableText(expected.sourceThreadId);
  if (
    !expectedAtlasTaskId &&
    !expectedSourceTransport &&
    !expectedSourceChatId &&
    !expectedSourceThreadId
  ) {
    return;
  }
  const payload = await atlasJsonRequest<{
    task?: {
      id?: string | null;
      atlasTaskId?: string | null;
      sourceTransport?: string | null;
      sourceChatId?: string | null;
      sourceThreadId?: string | null;
    } | null;
  }>(`/api/a2a/tasks/${encodeURIComponent(taskId)}`);
  const task = payload?.task;
  if (!task?.id) {
    throw new Error(`a2a task not found for taskId ${taskId}`);
  }
  if (expectedAtlasTaskId && asNullableText(task.atlasTaskId) !== expectedAtlasTaskId) {
    throw new Error(`taskId ${taskId} does not match atlasTaskId ${expectedAtlasTaskId}`);
  }
  if (expectedSourceTransport && asNullableText(task.sourceTransport) !== expectedSourceTransport) {
    throw new Error(`taskId ${taskId} does not match sourceTransport ${expectedSourceTransport}`);
  }
  if (expectedSourceChatId && asNullableText(task.sourceChatId) !== expectedSourceChatId) {
    throw new Error(`taskId ${taskId} does not match sourceChatId ${expectedSourceChatId}`);
  }
  if (expectedSourceThreadId && asNullableText(task.sourceThreadId) !== expectedSourceThreadId) {
    throw new Error(`taskId ${taskId} does not match sourceThreadId ${expectedSourceThreadId}`);
  }
}

function getA2ATaskStatusPriority(status?: string | null): number {
  switch (
    String(status || "")
      .trim()
      .toLowerCase()
  ) {
    case "running":
      return 5;
    case "waiting_approval":
      return 4;
    case "claimed":
      return 3;
    case "queued":
      return 2;
    case "completed":
      return 1;
    case "failed":
    case "cancelled":
    default:
      return 0;
  }
}

function selectPreferredA2ATaskId(
  tasks: Array<{ id?: string | null; status?: string | null; createdAt?: string | null }>,
): string | undefined {
  const sorted = tasks.toSorted((left, right) => {
    const byStatus = getA2ATaskStatusPriority(right.status) - getA2ATaskStatusPriority(left.status);
    if (byStatus !== 0) {
      return byStatus;
    }
    const leftCreatedAt = Date.parse(String(left.createdAt || "")) || 0;
    const rightCreatedAt = Date.parse(String(right.createdAt || "")) || 0;
    return rightCreatedAt - leftCreatedAt;
  });
  for (const task of sorted) {
    const id = asNullableText(task.id);
    if (id) {
      return id;
    }
  }
  return undefined;
}

export function createAtlasExecutionTool(context?: AtlasExecutionToolContext): AnyAgentTool {
  return {
    label: "Atlas Execution",
    name: "atlas_execution",
    description:
      "Submit an execution brief to Atlas, then inspect Atlas task status, events, and artifacts. Use this after clarifying the goal and acceptance criteria; Atlas owns code changes, tests, preview, and MR evidence.",
    parameters: AtlasExecutionToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const taskId = readStringParam(params, "taskId");
      const atlasTaskIdParam = readStringParam(params, "atlasTaskId");
      const explicitRepo = readStringParam(params, "repo");
      const limit = readNumberParam(params, "limit", { integer: true });
      const recoverySource = inferAtlasSourceContext({
        explicitTransport: readStringParam(params, "sourceTransport"),
        explicitChatId: readStringParam(params, "sourceChatId"),
        explicitThreadId: readStringParam(params, "sourceThreadId"),
        bitrixTaskId: readStringParam(params, "bitrixTaskId"),
        context,
      });

      if (action === "agent_card") {
        const result = await atlasJsonRequest("/api/a2a/agent-card");
        return jsonResult({ ok: true, action, result });
      }

      if (action === "list") {
        const result = await atlasJsonRequest("/api/a2a/tasks", {
          query: {
            status: readStringParam(params, "status"),
            atlas_task_id: atlasTaskIdParam,
            source_transport: readStringParam(params, "sourceTransport"),
            source_chat_id: readStringParam(params, "sourceChatId"),
            source_thread_id: readStringParam(params, "sourceThreadId"),
            repo: explicitRepo,
            limit,
          },
        });
        return jsonResult({ ok: true, action, result });
      }

      if (action === "get") {
        const resolvedTaskId = await resolveA2ATaskId({
          taskId,
          atlasTaskId: atlasTaskIdParam,
          repo: explicitRepo,
          sourceTransport: recoverySource.sourceTransport,
          sourceChatId: recoverySource.sourceChatId,
          sourceThreadId: recoverySource.sourceThreadId,
        });
        const result = await atlasJsonRequest(
          `/api/a2a/tasks/${encodeURIComponent(resolvedTaskId)}`,
        );
        return jsonResult({ ok: true, action, result });
      }

      if (action === "events") {
        const resolvedTaskId = await resolveA2ATaskId({
          taskId,
          atlasTaskId: atlasTaskIdParam,
          repo: explicitRepo,
          sourceTransport: recoverySource.sourceTransport,
          sourceChatId: recoverySource.sourceChatId,
          sourceThreadId: recoverySource.sourceThreadId,
        });
        const result = await atlasJsonRequest(
          `/api/a2a/tasks/${encodeURIComponent(resolvedTaskId)}/events`,
          {
            query: {
              limit,
            },
          },
        );
        return jsonResult({ ok: true, action, result });
      }

      if (action === "artifacts") {
        const resolvedTaskId = await resolveA2ATaskId({
          taskId,
          atlasTaskId: atlasTaskIdParam,
          repo: explicitRepo,
          sourceTransport: recoverySource.sourceTransport,
          sourceChatId: recoverySource.sourceChatId,
          sourceThreadId: recoverySource.sourceThreadId,
        });
        const result = await atlasJsonRequest(
          `/api/a2a/tasks/${encodeURIComponent(resolvedTaskId)}/artifacts`,
          {
            query: {
              limit,
            },
          },
        );
        return jsonResult({ ok: true, action, result });
      }

      if (action === "submit") {
        const repo = explicitRepo || "homio/core";
        const requiredTaskId = taskId || crypto.randomUUID();
        const explicitAtlasTaskId = readStringParam(params, "atlasTaskId");
        const intent = readStringParam(params, "intent", { required: true });
        const title = readStringParam(params, "title");
        const summary = readStringParam(params, "summary");
        const branch = readStringParam(params, "branch");
        const envName = readStringParam(params, "envName");
        const linkedTargetTaskId = readStringParam(params, "targetTaskId");
        const inferredSource = inferAtlasSourceContext({
          explicitTransport: readStringParam(params, "sourceTransport"),
          explicitChatId: readStringParam(params, "sourceChatId"),
          explicitThreadId: readStringParam(params, "sourceThreadId"),
          bitrixTaskId: readStringParam(params, "bitrixTaskId"),
          context,
        });
        const sourceTransport = inferredSource.sourceTransport;
        const sourceChatId = inferredSource.sourceChatId;
        const sourceThreadId = inferredSource.sourceThreadId;
        const sourceMessageId = readStringParam(params, "sourceMessageId");
        const sessionId = readStringParam(params, "sessionId");
        const workThreadId = readStringParam(params, "workThreadId");
        const bitrixTaskId = readStringParam(params, "bitrixTaskId");
        const brief = readStringParam(params, "brief");
        const acceptanceCriteria = readStringParam(params, "acceptanceCriteria");
        const nonGoals = readStringParam(params, "nonGoals");
        const verifyPlan = readStringParam(params, "verifyPlan");
        const stagePlan = readStringParam(params, "stagePlan");
        const atlasTaskId = explicitAtlasTaskId || requiredTaskId;

        if (!brief) {
          throw new Error("brief required");
        }
        if (sourceTransport === "telegram-topic") {
          if (!sourceChatId) {
            throw new Error("sourceChatId required for telegram-topic submissions");
          }
          if (!sourceThreadId) {
            throw new Error("sourceThreadId required for telegram-topic submissions");
          }
        }

        const resolvedWorkThreadId = await resolveAtlasWorkThreadId({
          repo,
          branch,
          envName,
          atlasTaskId,
          title,
          summary,
          sourceTransport,
          sourceChatId,
          sourceThreadId,
          bitrixTaskId,
          workThreadId,
        });

        const body = {
          executionSpec: {
            kind: "ExecutionSpec",
            taskId: requiredTaskId,
            intent,
            repo,
            summary: summary || title || brief || null,
            target: {
              taskId: atlasTaskId || null,
              env: envName || null,
              branch: branch || null,
            },
            metadata: {
              title: title || null,
              brief: brief || null,
              acceptanceCriteria: acceptanceCriteria || null,
              nonGoals: nonGoals || null,
              verifyPlan: verifyPlan || null,
              stagePlan: stagePlan || null,
              workThreadId: resolvedWorkThreadId || null,
              bitrixTaskId: bitrixTaskId || null,
              linkedTargetTaskId: linkedTargetTaskId || null,
            },
          },
          atlasTaskId: atlasTaskId || null,
          source: {
            agent: "openclaw",
            transport: sourceTransport,
            chatId: sourceChatId || null,
            threadId: sourceThreadId || null,
            messageId: sourceMessageId || null,
          },
          sessionId: sessionId || null,
          branch: branch || null,
          envName: envName || null,
          metadata: {
            workThreadId: resolvedWorkThreadId || null,
            bitrixTaskId: bitrixTaskId || null,
            brief: brief || null,
            acceptanceCriteria: acceptanceCriteria || null,
            nonGoals: nonGoals || null,
            verifyPlan: verifyPlan || null,
            stagePlan: stagePlan || null,
            title: title || null,
            linkedTargetTaskId: linkedTargetTaskId || null,
          },
        };

        try {
          const result = await atlasJsonRequest("/api/a2a/tasks", {
            method: "POST",
            body,
          });
          return jsonResult({ ok: true, action, result });
        } catch (error) {
          if (error instanceof AtlasHttpError && error.status === 409) {
            return jsonResult({
              ok: false,
              conflict: true,
              action,
              result: error.payload,
            });
          }
          throw error;
        }
      }

      throw new Error(`Unsupported atlas_execution action: ${action}`);
    },
  };
}
