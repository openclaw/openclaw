/**
 * Training Export (trajectory-first, trigger-driven)
 *
 * Minimal responsibilities on the new base:
 * 1. when enabled and a trigger fires, collect training-required fields from trajectory runtime
 * 2. format them via provider-owned OpenAI conversion helpers and append to episodes.jsonl
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Api, Context, Model } from "@mariozechner/pi-ai";
import { convertMessages } from "@mariozechner/pi-ai/openai-completions";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { detectOpenAICompletionsCompat } from "./agents/openai-completions-compat.js";
import {
  buildOpenAICompletionsParams,
  convertResponsesMessages,
} from "./agents/openai-transport-stream.js";
import { createSessionManagerRuntimeRegistry } from "./agents/pi-hooks/session-manager-runtime-registry.js";
import type { AnyAgentTool } from "./agents/tools/common.js";
import { resolveStateDir } from "./config/paths.js";
import type { ModelCompatConfig } from "./config/types.models.js";
import type { OpenClawConfig } from "./config/types.openclaw.js";
import { formatErrorMessage } from "./infra/errors.js";
import { createSubsystemLogger } from "./logging/subsystem.js";
import type { PluginLogger } from "./plugins/types.js";
import { resolveTrajectoryFilePath } from "./trajectory/runtime.js";
import type { TrajectoryEvent } from "./trajectory/types.js";

type OpenAIStyleMessage = {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content?: unknown;
  reasoning_content?: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: unknown[];
};

function getExportMessageRole(message: OpenAIStyleMessage): string | undefined {
  return "role" in message && typeof message.role === "string" ? message.role : undefined;
}

type ChatCompletionsToolDefinition = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    strict?: boolean;
  };
};

type ResponsesToolDefinition = {
  type: "function";
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
};

type ExportedToolDefinition = ChatCompletionsToolDefinition | ResponsesToolDefinition;
export type TrainingExportConfig = {
  enabled?: boolean;
  compat?: ModelCompatConfig;
};

type CompactSummaryModelInfo = {
  provider?: string;
  id?: string;
};

type CompactSummaryPayload = {
  systemPrompt?: string;
  promptText: string;
  responseText: string;
  model?: CompactSummaryModelInfo;
  sessionId?: string;
  compaction?: {
    tokensBefore: number;
    firstKeptEntryId: string;
    fromExtension: boolean;
  };
};

export type TrainingExportTrigger =
  | {
      kind: "before_reset";
      sessionId?: string;
      sessionFile?: string;
      reason?: string;
    }
  | {
      kind: "trajectory_export";
      sessionId?: string;
      sessionFile?: string;
      command?: string;
    }
  | {
      kind: "on_compaction";
      sessionId?: string;
      sessionFile?: string;
      compactionEntry?: {
        summary: string;
        tokensBefore: number;
        firstKeptEntryId: string;
        fromExtension: boolean;
        systemPrompt?: string;
        promptText?: string;
      };
    };

type RuntimeToolObject = {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
};

export type RuntimeSnapshot = {
  sessionId?: string;
  runId?: string;
  traceId?: string;
  transcriptLeafId?: string;
  systemPrompt?: string;
  runtimeMessages: AgentMessage[];
  runtimeTools: RuntimeToolObject[];
  model?: string;
  lastContextSeq?: number;
  lastCompletedSeq?: number;
};

type TrainExampleMeta = {
  episodeId: string;
  sessionId?: string;
  exportedAt: string;
  openclawVersion?: string;
  model?: string;
  messageCount: number;
  turnCount?: number;
  trigger: TrainingExportTrigger["kind"];
  trajectory?: {
    traceId?: string;
    runId?: string;
    transcriptLeafId?: string;
    lastContextSeq?: number;
    lastCompletedSeq?: number;
  };
};

type TrainExample = {
  messages: OpenAIStyleMessage[];
  tools: ExportedToolDefinition[];
  meta: TrainExampleMeta;
};

type TrainingExportRunResult = {
  status: "exported" | "skipped" | "error";
  exportedCount?: number;
  outputJsonlPath?: string;
  reason?: string;
  error?: string;
};

const DEFAULT_EXPORT_OUTPUT_FILENAME = "episodes.jsonl";

export function getTrainingExportConfig(config?: OpenClawConfig): TrainingExportConfig | undefined {
  return (config as OpenClawConfig & { trainingExport?: TrainingExportConfig })?.trainingExport;
}

export function resolveTrainingExportPaths(): { outputJsonlPath: string } {
  const exportDir = path.join(resolveStateDir(), "training-export");
  fs.mkdirSync(exportDir, { recursive: true, mode: 0o700 });
  return { outputJsonlPath: path.join(exportDir, DEFAULT_EXPORT_OUTPUT_FILENAME) };
}

export function appendJsonl(filePath: string, rows: unknown[]): void {
  if (rows.length === 0) {
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    fs.accessSync(filePath);
  } catch {
    fs.writeFileSync(filePath, "", { mode: 0o600 });
  }
  const payload = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  fs.appendFileSync(filePath, payload, "utf8");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).toSorted(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function readJsonl(filePath: string): unknown[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function shouldKeepRuntimeMessageForTrainingExport(message: Context["messages"][number]): boolean {
  return !(
    message &&
    typeof message === "object" &&
    "provider" in message &&
    message.provider === "openclaw"
  );
}

function normalizeRuntimeMessages(value: unknown): Context["messages"] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (message): message is Context["messages"][number] =>
      Boolean(message) &&
      typeof message === "object" &&
      shouldKeepRuntimeMessageForTrainingExport(message as Context["messages"][number]),
  );
}

function normalizeRuntimeTools(value: unknown): RuntimeToolObject[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const record = item as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (!name) {
      return [];
    }
    return [
      {
        name,
        ...(typeof record.description === "string" ? { description: record.description } : {}),
        ...(record.parameters && typeof record.parameters === "object"
          ? { parameters: record.parameters as Record<string, unknown> }
          : {}),
      },
    ];
  });
}

export function readTrajectoryEvents(params: {
  sessionFile?: string;
  sessionId?: string;
}): TrajectoryEvent[] {
  const sessionId = params.sessionId?.trim();
  if (!sessionId) {
    return [];
  }
  const filePath = resolveTrajectoryFilePath({
    sessionFile: params.sessionFile,
    sessionId,
  });
  return readJsonl(filePath).flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }
    return [item as TrajectoryEvent];
  });
}

function resolveLastAssistantModel(runtimeMessages: Context["messages"]): string | undefined {
  for (let i = runtimeMessages.length - 1; i >= 0; i--) {
    const message = runtimeMessages[i];
    if (!message || typeof message !== "object") {
      continue;
    }
    if (message.role !== "assistant") {
      continue;
    }
    return typeof message.model === "string" && message.model.trim().length > 0
      ? message.model
      : undefined;
  }
  return undefined;
}

export function collectLatestRuntimeSnapshot(
  events: TrajectoryEvent[],
  fallbackSessionId?: string,
): RuntimeSnapshot | undefined {
  const compiled = [...events]
    .toReversed()
    .find(
      (event) => event.type === "context.compiled" && event.data && typeof event.data === "object",
    );
  const completed = [...events]
    .toReversed()
    .find(
      (event) => event.type === "model.completed" && event.data && typeof event.data === "object",
    );

  if (!compiled && !completed) {
    return undefined;
  }

  const compiledData = compiled?.data ?? {};
  const completedData = completed?.data ?? {};
  const runtimeMessages = normalizeRuntimeMessages(
    completedData.messagesSnapshot ?? compiledData.messages,
  );
  const runtimeTools = normalizeRuntimeTools(compiledData.tools);
  const sessionId =
    compiled?.sessionId ?? completed?.sessionId ?? (fallbackSessionId?.trim() || undefined);

  return {
    sessionId,
    runId: compiled?.runId ?? completed?.runId,
    traceId: compiled?.traceId ?? completed?.traceId,
    transcriptLeafId:
      typeof compiledData.transcriptLeafId === "string" ? compiledData.transcriptLeafId : undefined,
    systemPrompt:
      typeof compiledData.systemPrompt === "string" ? compiledData.systemPrompt : undefined,
    runtimeMessages,
    runtimeTools,
    model: resolveLastAssistantModel(runtimeMessages) ?? compiled?.modelId ?? completed?.modelId,
    lastContextSeq: typeof compiled?.seq === "number" ? compiled.seq : undefined,
    lastCompletedSeq: typeof completed?.seq === "number" ? completed.seq : undefined,
  };
}

function buildRuntimeContext(params: {
  runtimeMessages: Context["messages"];
  systemPrompt?: string;
  runtimeTools: RuntimeToolObject[];
}): Context {
  return {
    messages: params.runtimeMessages,
    ...(params.systemPrompt ? { systemPrompt: params.systemPrompt } : {}),
    ...(params.runtimeTools.length > 0
      ? { tools: params.runtimeTools as unknown as AnyAgentTool[] }
      : {}),
  } as Context;
}

function compactConversationTextIsNonEmpty(promptText: string): boolean {
  return /<conversation>\s*[\s\S]*\S[\s\S]*<\/conversation>/.test(promptText);
}

function resolveCompactSummaryModel(model?: CompactSummaryModelInfo): string | undefined {
  if (!model) {
    return undefined;
  }
  const provider = typeof model.provider === "string" ? model.provider.trim() : "";
  const id = typeof model.id === "string" ? model.id.trim() : "";
  if (provider && id) {
    return `${provider}/${id}`;
  }
  return provider || id || undefined;
}

function buildCompactSummaryEpisodeId(payload: CompactSummaryPayload): string {
  return createHash("sha256")
    .update(
      stableStringify({
        sessionId: payload.sessionId,
        systemPrompt: payload.systemPrompt,
        promptText: payload.promptText,
        responseText: payload.responseText,
        model: payload.model,
      }),
    )
    .digest("hex");
}

function buildCompactSummaryTrainExample(params: {
  payload: CompactSummaryPayload;
  openclawVersion?: string;
}): TrainExample | undefined {
  const promptText = params.payload.promptText.trim();
  const responseText = params.payload.responseText.trim();
  if (!promptText || !responseText) {
    return undefined;
  }
  if (!compactConversationTextIsNonEmpty(promptText)) {
    return undefined;
  }
  if (/\(No conversation(?: content)? to summarize\)/.test(responseText)) {
    return undefined;
  }
  const messages: OpenAIStyleMessage[] = [];
  if (params.payload.systemPrompt) {
    messages.push({ role: "system", content: params.payload.systemPrompt });
  }
  messages.push({ role: "user", content: promptText });
  messages.push({ role: "assistant", content: responseText });
  const model = resolveCompactSummaryModel(params.payload.model);
  return {
    messages,
    tools: [],
    meta: {
      episodeId: buildCompactSummaryEpisodeId(params.payload),
      ...(params.payload.sessionId ? { sessionId: params.payload.sessionId } : {}),
      exportedAt: new Date().toISOString(),
      ...(params.openclawVersion ? { openclawVersion: params.openclawVersion } : {}),
      ...(model ? { model } : {}),
      ...(params.payload.compaction ? { compaction: params.payload.compaction } : {}),
      messageCount: messages.length,
      turnCount: 1,
      trigger: "on_compaction",
    },
  };
}

function resolveTrainingExportToolModel(config?: OpenClawConfig): Model<Api> & {
  compat?: Record<string, unknown>;
} {
  const defaultModel = config?.agents?.defaults?.model;
  const provider = "openai";
  const baseUrl = "https://api.openai.com/v1";
  const modelId = typeof defaultModel === "string" ? defaultModel : "gpt-5";
  const compat = {
    ...detectOpenAICompletionsCompat({ provider, baseUrl, id: modelId, compat: undefined })
      .defaults,
    // Training export handles thinking blocks itself as reasoning_content;
    // tell upstream convertMessages not to merge thinking into text content.
    requiresThinkingAsText: false,
    ...getTrainingExportConfig(config)?.compat,
  };

  return {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider,
    baseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 8192,
    compat,
  } as Model<Api> & { compat?: Record<string, unknown> };
}

function normalizeTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((item) => {
      if (!item || typeof item !== "object") {
        return [];
      }
      const record = item as Record<string, unknown>;
      if (typeof record.text === "string") {
        return [record.text];
      }
      return [];
    })
    .join("\n");
}

function adaptChatCompletionsMessagesToExportMessages(items: unknown[]): OpenAIStyleMessage[] {
  const messages: OpenAIStyleMessage[] = [];
  for (const item of items as Array<Record<string, unknown>>) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const role = typeof item.role === "string" ? item.role : undefined;
    if (!role) {
      continue;
    }
    if (role === "system" || role === "developer" || role === "user") {
      messages.push({ role, content: normalizeTextContent(item.content) });
      continue;
    }
    if (role === "assistant") {
      messages.push({
        role: "assistant",
        content: normalizeTextContent(item.content),
        ...(Array.isArray(item.tool_calls) ? { tool_calls: item.tool_calls } : {}),
      });
      continue;
    }
    if (role === "tool") {
      messages.push({
        role: "tool",
        content: normalizeTextContent(item.content),
        name: typeof item.name === "string" ? item.name : undefined,
        tool_call_id: typeof item.tool_call_id === "string" ? item.tool_call_id : undefined,
      });
    }
  }
  return messages;
}

function convertRuntimeToolsToExportTools(
  tools: RuntimeToolObject[],
  config?: OpenClawConfig,
): ExportedToolDefinition[] {
  if (tools.length === 0) {
    return [];
  }
  const model = resolveTrainingExportToolModel(config);
  const params = buildOpenAICompletionsParams(
    model as never,
    { systemPrompt: "", messages: [], tools: tools as unknown as AnyAgentTool[] } as never,
    undefined,
  ) as { tools?: ExportedToolDefinition[] };
  return Array.isArray(params.tools) ? params.tools : [];
}

function trainExampleMessagesAreUsable(messages: OpenAIStyleMessage[]): boolean {
  return (
    messages.some((message) => getExportMessageRole(message) === "user") &&
    messages.some((message) => getExportMessageRole(message) === "assistant")
  );
}

function appendReasoningContent(
  message: OpenAIStyleMessage,
  reasoningContent: string | undefined,
): void {
  const trimmed = reasoningContent?.trim();
  if (!trimmed) {
    return;
  }
  message.reasoning_content = message.reasoning_content
    ? `${message.reasoning_content}\n${trimmed}`
    : trimmed;
}

/**
 * Convert runtime messages to export messages by reusing upstream
 * `convertMessages` from `@mariozechner/pi-ai/openai-completions`, then
 * post-processing to add `reasoning_content` from thinking blocks.
 *
 * Upstream handles: system/developer role, user content (text + image),
 * assistant text/toolCalls, toolResult, id normalization, sanitization,
 * compat quirks (requiresAssistantAfterToolResult, etc.).
 *
 * We strip thinking blocks *before* calling upstream to avoid
 * requiresThinkingAsText / thinkingFormat merging thinking text into
 * content. Then we add `reasoning_content` as a post-processing step by
 * matching original assistant messages to exported ones by position.
 *
 * Reference: node_modules/@mariozechner/pi-ai/dist/providers/openai-completions.js
 *   → export function convertMessages(model, context, compat)
 */
function convertRuntimeMessagesToExportMessages(params: {
  runtimeMessages: AgentMessage[];
  systemPrompt?: string;
  runtimeTools: RuntimeToolObject[];
  config?: OpenClawConfig;
}): OpenAIStyleMessage[] {
  const model = resolveTrainingExportToolModel(params.config);

  // Pre-process messages: strip thinking blocks, convert compactionSummary → user.
  // CompactionSummary → user mirrors Pi SDK's convertToLlm (messages.js:7-13, 103-108);
  // needed because the upstream convertMessages from @mariozechner/pi-ai/openai-completions
  // does not handle compactionSummary role.
  const processedMessages = params.runtimeMessages.map((msg) => {
    // Strip thinking blocks from assistant messages
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      const filtered = msg.content.filter((block: { type: string }) => block.type !== "thinking");
      if (filtered.length !== msg.content.length) {
        return { ...msg, content: filtered } as typeof msg;
      }
    }
    // Convert compactionSummary to user message
    if (
      msg.role === "compactionSummary" &&
      typeof msg.summary === "string" &&
      msg.summary.trim().length > 0
    ) {
      return {
        role: "user" as const,
        content: `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${msg.summary}\n</summary>`,
      };
    }
    return msg;
  });

  const runtimeContext = buildRuntimeContext({
    runtimeMessages: processedMessages as Context["messages"],
    systemPrompt: params.systemPrompt,
    runtimeTools: params.runtimeTools,
  });

  // Step 1: Use upstream convertMessages to get ChatCompletionMessageParam[]
  const upstreamMessages = convertMessages(
    model as never,
    runtimeContext,
    (model as unknown as { compat: unknown }).compat as never,
  );

  // Step 2: Convert upstream format to our export format
  const messages = adaptChatCompletionsMessagesToExportMessages(upstreamMessages as unknown[]);

  // Step 3: Append reasoning_content by scanning original runtime messages
  // for thinking blocks and matching them to exported assistant messages
  // by position.
  let msgIdx = 0;
  for (const message of params.runtimeMessages) {
    if (message.role !== "assistant") {
      continue;
    }
    while (msgIdx < messages.length && messages[msgIdx].role !== "assistant") {
      msgIdx++;
    }
    if (msgIdx >= messages.length) {
      break;
    }
    const exported = messages[msgIdx];
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === "thinking" && typeof block.thinking === "string") {
          appendReasoningContent(exported, block.thinking);
        }
      }
    }
    msgIdx++;
  }

  // Step 4: Convert developer role to system for training format compatibility.
  // OpenAI uses "developer" for system messages with developer privileges,
  // but training pipelines expect "system".
  for (const message of messages) {
    if (message.role === "developer") {
      message.role = "system";
    }
  }

  return messages;
}

function buildEpisodeId(params: {
  trigger: TrainingExportTrigger;
  snapshot: RuntimeSnapshot;
}): string {
  return createHash("sha256")
    .update(
      stableStringify({
        trigger: params.trigger,
        sessionId: params.snapshot.sessionId,
        traceId: params.snapshot.traceId,
        runId: params.snapshot.runId,
        transcriptLeafId: params.snapshot.transcriptLeafId,
        lastContextSeq: params.snapshot.lastContextSeq,
        lastCompletedSeq: params.snapshot.lastCompletedSeq,
        systemPrompt: params.snapshot.systemPrompt,
        runtimeMessages: params.snapshot.runtimeMessages,
        runtimeTools: params.snapshot.runtimeTools,
      }),
    )
    .digest("hex");
}

function buildTrainExample(params: {
  snapshot: RuntimeSnapshot;
  trigger: TrainingExportTrigger;
  config?: OpenClawConfig;
  openclawVersion?: string;
}): TrainExample | undefined {
  if (params.snapshot.runtimeMessages.length === 0) {
    return undefined;
  }

  const messages = convertRuntimeMessagesToExportMessages({
    runtimeMessages: params.snapshot.runtimeMessages,
    systemPrompt: params.snapshot.systemPrompt,
    runtimeTools: params.snapshot.runtimeTools,
    config: params.config,
  });
  // Trim trailing non-assistant messages. Training episodes must end with an
  // assistant message regardless of trigger type — mid-turn snapshots from any
  // source are incomplete turns, not meaningful training data.
  while (
    messages.length > 0 &&
    getExportMessageRole(messages.at(-1) as OpenAIStyleMessage) !== "assistant"
  ) {
    messages.pop();
  }
  if (messages.length === 0 || !trainExampleMessagesAreUsable(messages)) {
    return undefined;
  }

  const tools = convertRuntimeToolsToExportTools(params.snapshot.runtimeTools, params.config);

  return {
    messages,
    tools,
    meta: {
      episodeId: buildEpisodeId({
        trigger: params.trigger,
        snapshot: params.snapshot,
      }),
      sessionId: params.snapshot.sessionId,
      exportedAt: new Date().toISOString(),
      ...(params.openclawVersion ? { openclawVersion: params.openclawVersion } : {}),
      ...(params.snapshot.model ? { model: params.snapshot.model } : {}),
      messageCount: messages.length,
      turnCount: messages.filter((message) => getExportMessageRole(message) === "user").length,
      trigger: params.trigger.kind,
      trajectory: {
        ...(params.snapshot.traceId ? { traceId: params.snapshot.traceId } : {}),
        ...(params.snapshot.runId ? { runId: params.snapshot.runId } : {}),
        ...(params.snapshot.transcriptLeafId
          ? { transcriptLeafId: params.snapshot.transcriptLeafId }
          : {}),
        ...(typeof params.snapshot.lastContextSeq === "number"
          ? { lastContextSeq: params.snapshot.lastContextSeq }
          : {}),
        ...(typeof params.snapshot.lastCompletedSeq === "number"
          ? { lastCompletedSeq: params.snapshot.lastCompletedSeq }
          : {}),
      },
    },
  };
}

export function buildTrainExamplesForTrigger(params: {
  snapshot: RuntimeSnapshot;
  trigger: TrainingExportTrigger;
  config?: OpenClawConfig;
  openclawVersion?: string;
}): TrainExample[] {
  const taskEpisode =
    (params.trigger.kind === "on_compaction" && !params.trigger.compactionEntry) ||
    params.trigger.kind === "before_reset" ||
    params.trigger.kind === "trajectory_export"
      ? buildTrainExample({
          snapshot: params.snapshot,
          trigger: params.trigger,
          config: params.config,
          openclawVersion: params.openclawVersion,
        })
      : undefined;
  const compactSummaryEpisode =
    params.trigger.kind === "on_compaction" &&
    params.trigger.compactionEntry &&
    params.trigger.compactionEntry.summary
      ? buildCompactSummaryTrainExample({
          payload: {
            systemPrompt: params.trigger.compactionEntry.systemPrompt ?? "",
            promptText: params.trigger.compactionEntry.promptText ?? "",
            responseText: params.trigger.compactionEntry.summary,
            sessionId: params.trigger.sessionId,
            compaction: {
              tokensBefore: params.trigger.compactionEntry.tokensBefore,
              firstKeptEntryId: params.trigger.compactionEntry.firstKeptEntryId,
              fromExtension: params.trigger.compactionEntry.fromExtension,
            },
          },
          openclawVersion: params.openclawVersion,
        })
      : undefined;
  return [taskEpisode, compactSummaryEpisode].filter((item): item is TrainExample => Boolean(item));
}

export function runTrainingExport(params: {
  trigger: TrainingExportTrigger;
  config?: OpenClawConfig;
  logger?: PluginLogger;
  openclawVersion?: string;
}): TrainingExportRunResult {
  if (!params.trigger.sessionFile || !params.trigger.sessionId) {
    return { status: "skipped", reason: "trainingExport.missing_session_target" };
  }

  try {
    const paths = resolveTrainingExportPaths();
    const events = readTrajectoryEvents({
      sessionFile: params.trigger.sessionFile,
      sessionId: params.trigger.sessionId,
    });
    const snapshot = collectLatestRuntimeSnapshot(events, params.trigger.sessionId);

    if (!snapshot) {
      return {
        status: "skipped",
        reason: "trainingExport.no_trajectory_snapshot",
        outputJsonlPath: paths.outputJsonlPath,
      };
    }

    const examples = buildTrainExamplesForTrigger({
      snapshot,
      trigger: params.trigger,
      config: params.config,
      openclawVersion: params.openclawVersion,
    });

    if (examples.length === 0) {
      return {
        status: "skipped",
        reason: "trainingExport.empty_snapshot",
        outputJsonlPath: paths.outputJsonlPath,
      };
    }

    appendJsonl(paths.outputJsonlPath, examples);
    params.logger?.info?.(
      `[training-export] exported ${examples.length} episode(s) -> ${paths.outputJsonlPath}`,
    );
    return {
      status: "exported",
      exportedCount: examples.length,
      outputJsonlPath: paths.outputJsonlPath,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    params.logger?.warn?.(`[training-export] export failed: ${message}`);
    return { status: "error", error: message };
  }
}

export const COMPACT_SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

export const COMPACT_SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

export const COMPACT_UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (!part || typeof part !== "object") {
        return "";
      }
      const block = part as Record<string, unknown>;
      if (block.type === "text") {
        return typeof block.text === "string" ? block.text : "";
      }
      if (block.type === "thinking") {
        return typeof block.thinking === "string" ? block.thinking : "";
      }
      return "";
    })
    .filter((part) => part.length > 0)
    .join("\n");
}

function serializeCompactSummaryConversation(messages: AgentMessage[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object" || !("role" in msg)) {
      continue;
    }
    const role = msg.role;
    if (role === "user") {
      const text = extractTextContent((msg as { content?: unknown }).content);
      if (text) {
        lines.push(`[User]: ${text}`);
      }
      continue;
    }
    if (role === "assistant") {
      const content = (msg as { content?: unknown }).content;
      const text = extractTextContent(content);
      if (text) {
        lines.push(`[Assistant]: ${text}`);
      }
      if (Array.isArray(content)) {
        const toolCalls = content
          .filter(
            (part): part is Record<string, unknown> => Boolean(part) && typeof part === "object",
          )
          .filter((part) => part.type === "toolCall")
          .map((part) => {
            const name = typeof part.name === "string" ? part.name : "unknown_tool";
            const args =
              part.arguments && typeof part.arguments === "object"
                ? JSON.stringify(part.arguments)
                : "{}";
            return `${name}(${args})`;
          });
        if (toolCalls.length > 0) {
          lines.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
        }
      }
      continue;
    }
    if (role === "toolResult") {
      const toolMsg = msg as { toolName?: unknown; content?: unknown };
      const name = typeof toolMsg.toolName === "string" ? toolMsg.toolName : "tool";
      const text = extractTextContent(toolMsg.content);
      if (text) {
        lines.push(`[Tool result ${name}]: ${text}`);
      }
      continue;
    }
    if (role === "compactionSummary") {
      const summary =
        typeof (msg as { summary?: unknown }).summary === "string"
          ? (msg as { summary: string }).summary
          : "";
      if (summary) {
        lines.push(`[Previous compaction summary]: ${summary}`);
      }
      continue;
    }
    if (role === "branchSummary") {
      const summary =
        typeof (msg as { summary?: unknown }).summary === "string"
          ? (msg as { summary: string }).summary
          : "";
      if (summary) {
        lines.push(`[Branch summary]: ${summary}`);
      }
      continue;
    }
    if (role === "custom") {
      const text = extractTextContent((msg as { content?: unknown }).content);
      if (text) {
        lines.push(`[Custom]: ${text}`);
      }
    }
  }
  return lines.join("\n\n");
}

export function buildCompactSummaryPrompt(params: {
  messagesToSummarize: AgentMessage[];
  previousSummary?: string;
  customInstructions?: string;
}): string {
  let basePrompt = params.previousSummary
    ? COMPACT_UPDATE_SUMMARIZATION_PROMPT
    : COMPACT_SUMMARIZATION_PROMPT;
  if (params.customInstructions) {
    basePrompt = `${basePrompt}

Additional focus: ${params.customInstructions}`;
  }
  const conversationText = serializeCompactSummaryConversation(params.messagesToSummarize);
  let promptText = `<conversation>
${conversationText}
</conversation>

`;
  if (params.previousSummary) {
    promptText += `<previous-summary>
${params.previousSummary}
</previous-summary>

`;
  }
  promptText += basePrompt;
  return promptText;
}

const log = createSubsystemLogger("compaction-training-export");

const registry = createSessionManagerRuntimeRegistry<OpenClawConfig>();

export const setCompactionTrainingExportRuntime = registry.set;

type CompactionPreparation = {
  firstKeptEntryId: string;
  messagesToSummarize: AgentMessage[];
  previousSummary?: string;
  tokensBefore: number;
};

type PreCompactStash = {
  trigger: TrainingExportTrigger;
  snapshot: RuntimeSnapshot;
  preparation: CompactionPreparation;
  customInstructions?: string;
};

const preCompactStash = new WeakMap<object, PreCompactStash>();

/**
 * Extension that triggers training export for all compaction events.
 *
 * Strategy: task episode + summary episode must appear as a complete pair.
 * If either is filtered by quality checks, both are discarded.
 */
export function compactionTrainingExportExtension(api: ExtensionAPI): void {
  api.on("session_before_compact", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const sessionFile = ctx.sessionManager.getSessionFile();
    const config = registry.get(ctx.sessionManager) ?? undefined;

    if (!sessionId || !sessionFile) return;

    try {
      const events = readTrajectoryEvents({ sessionFile, sessionId });
      const snapshot = collectLatestRuntimeSnapshot(events, sessionId);
      if (snapshot) {
        const trigger: TrainingExportTrigger = { kind: "on_compaction", sessionId, sessionFile };
        preCompactStash.set(ctx.sessionManager, {
          trigger,
          snapshot,
          preparation: event.preparation as CompactionPreparation,
          customInstructions: event.customInstructions,
        });
        log.info("[training-export] stashed pre-compaction snapshot + preparation", {
          sessionId: sessionId.slice(0, 8),
        });
      }
    } catch (err) {
      log.warn("[training-export] failed to stash pre-compaction snapshot", {
        errorMessage: formatErrorMessage(err),
      });
    }
  });

  api.on("session_compact", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const sessionFile = ctx.sessionManager.getSessionFile();
    const config = registry.get(ctx.sessionManager) ?? undefined;
    const summary = event.compactionEntry.summary;

    if (!sessionId || !sessionFile) return;

    const discardStash = () => {
      preCompactStash.delete(ctx.sessionManager);
    };

    if (!summary || typeof summary !== "string" || summary.trim().length === 0) {
      discardStash();
      log.info("[training-export] no valid summary, discarding stash", {
        sessionId: sessionId.slice(0, 8),
      });
      return;
    }

    try {
      const stashed = preCompactStash.get(ctx.sessionManager);

      // Build task episode
      const taskExamples = stashed
        ? buildTrainExamplesForTrigger({
            snapshot: stashed.snapshot,
            trigger: stashed.trigger,
            config,
          })
        : [];

      // Build summary episode
      const promptText = stashed
        ? buildCompactSummaryPrompt({
            messagesToSummarize: stashed.preparation.messagesToSummarize,
            previousSummary: stashed.preparation.previousSummary,
            customInstructions: stashed.customInstructions,
          })
        : "";

      const summaryTrigger: TrainingExportTrigger = {
        kind: "on_compaction",
        sessionId,
        sessionFile,
        compactionEntry: {
          summary,
          tokensBefore: event.compactionEntry.tokensBefore,
          firstKeptEntryId: event.compactionEntry.firstKeptEntryId,
          fromExtension: event.compactionEntry.fromHook ?? false,
          systemPrompt: COMPACT_SUMMARIZATION_SYSTEM_PROMPT,
          promptText,
        },
      };

      const fallbackSnapshot: RuntimeSnapshot = {
        runtimeMessages: [],
        runtimeTools: [],
      };
      const summaryExamples = buildTrainExamplesForTrigger({
        snapshot: stashed?.snapshot ?? fallbackSnapshot,
        trigger: summaryTrigger,
        config,
      });

      discardStash();

      // Both must be present — if either is filtered, discard the whole batch.
      if (taskExamples.length === 0 || summaryExamples.length === 0) {
        log.info("[training-export] incomplete pair, discarding batch", {
          sessionId: sessionId.slice(0, 8),
          taskCount: taskExamples.length,
          summaryCount: summaryExamples.length,
        });
        return;
      }

      const examples = [...taskExamples, ...summaryExamples];
      const paths = resolveTrainingExportPaths();
      appendJsonl(paths.outputJsonlPath, examples);
      log.info(
        `[training-export] exported ${examples.length} episode(s) -> ${paths.outputJsonlPath}`,
        { sessionId: sessionId.slice(0, 8) },
      );
    } catch (err) {
      log.warn("[training-export] failed to export on_compaction episodes", {
        errorMessage: formatErrorMessage(err),
      });
    }
  });
}

export const __testing = {
  stableStringify,
  readTrajectoryEvents,
  collectLatestRuntimeSnapshot,
  buildRuntimeContext,
  compactConversationTextIsNonEmpty,
  resolveCompactSummaryModel,
  buildCompactSummaryTrainExample,
  resolveTrainingExportToolModel,
  adaptChatCompletionsMessagesToExportMessages,
  trainExampleMessagesAreUsable,
  appendReasoningContent,
  convertRuntimeMessagesToExportMessages,
  convertRuntimeToolsToExportTools,
  buildEpisodeId,
  buildTrainExample,
  buildTrainExamplesForTrigger,
  buildOpenAICompletionsParams,
  convertMessages,
  convertResponsesMessages,
};
