import fs from "node:fs/promises";
import path from "node:path";
import type { EventFrame } from "../../packages/gateway-protocol/src/index.js";
import { buildCodexHarnessAppServerArgs } from "../../src/gateway/gateway-codex-harness.live-helpers.js";
import type { AgentEventPayload } from "../../src/infra/agent-events.js";
import { listKnownProviderAuthEnvVarNamesCore } from "../../src/secrets/provider-env-vars.js";
import { extractFirstTextBlock } from "../../src/shared/chat-message-content.js";
// Native live fixture setup and capture shared with its offline boundary regressions.
import { createOpenClawTestInstance } from "./openclaw-test-instance.js";

export function createCodexHarnessLiveInstance(
  token: string,
  authMode: "codex-auth" | "api-key" = "codex-auth",
) {
  return createOpenClawTestInstance({
    name: "live-codex-harness",
    // test-env already staged native Codex auth/config in the caller home.
    state: { layout: "state-only" },
    gatewayToken: token,
    env: {
      ...Object.fromEntries(
        listKnownProviderAuthEnvVarNamesCore().map((name) => [name, undefined]),
      ),
      OPENCLAW_AGENT_RUNTIME: "codex",
      OPENCLAW_GATEWAY_TOKEN: token,
      OPENCLAW_ALLOW_SLOW_REPLY_TESTS: "1",
      // Admission and completion must share the normal, built Gateway lifecycle.
      OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
      OPENCLAW_SKIP_PROVIDERS: undefined,
      OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
      OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: undefined,
      OPENAI_API_KEY: authMode === "api-key" ? process.env.OPENAI_API_KEY : undefined,
      OPENAI_BASE_URL:
        authMode === "api-key" && process.env.OPENAI_BASE_URL?.trim()
          ? process.env.OPENAI_BASE_URL
          : undefined,
    },
  });
}

// Full-context assertions consume native usage separately from lifecycle/compaction.
export const CODEX_HARNESS_CONTEXT_EVENT_PREFIXES = [
  "codex_app_server.",
  "compaction",
  "usage",
] as const;

export function createCodexHarnessEventCapture(params: {
  eventPrefix?: string;
  eventPrefixes?: readonly string[];
  includeAllSessions?: boolean;
  sessionKey: string;
}) {
  const events: CapturedAgentEvent[] = [];
  const eventPrefixes = params.eventPrefixes ?? [params.eventPrefix ?? "codex_app_server.guardian"];
  let requestStartedAt = 0;
  let firstAssistantMs: number | undefined;
  return {
    events,
    start(startedAt: number) {
      requestStartedAt = startedAt;
    },
    get firstAssistantMs() {
      return firstAssistantMs;
    },
    onAgentEvent(this: void, event: AgentEventPayload) {
      if (
        !params.includeAllSessions &&
        event.sessionKey &&
        event.sessionKey !== params.sessionKey
      ) {
        return;
      }
      if (event.stream === "assistant" && requestStartedAt > 0 && firstAssistantMs === undefined) {
        firstAssistantMs = Math.max(0, event.ts - requestStartedAt);
      }
      if (!eventPrefixes.some((prefix) => event.stream.startsWith(prefix))) {
        return;
      }
      events.push({
        runId: event.runId,
        stream: event.stream,
        sessionKey: event.sessionKey,
        data: event.data,
        ts: event.ts,
      });
    },
  };
}

export type CapturedAgentEvent = {
  runId?: string;
  stream: string;
  data?: Record<string, unknown>;
  sessionKey?: string;
  ts?: number;
};

export type CodexNativeUsageSnapshot = {
  activeContextTokens: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  inputTokens?: number;
  modelContextWindow: number;
  outputTokens?: number;
  promptTokens: number;
};

export function readCodexNativeUsageSnapshots(
  events: readonly CapturedAgentEvent[],
): CodexNativeUsageSnapshot[] {
  return events.flatMap((event) => {
    if (event.stream !== "usage") {
      return [];
    }
    const activeContextTokens = event.data?.activeContextTokens;
    const modelContextWindow = event.data?.modelContextWindow;
    const promptTokens = event.data?.promptTokens;
    if (
      typeof activeContextTokens !== "number" ||
      typeof modelContextWindow !== "number" ||
      typeof promptTokens !== "number"
    ) {
      return [];
    }
    const optionalNumber = (key: string): number | undefined => {
      const value = event.data?.[key];
      return typeof value === "number" ? value : undefined;
    };
    const cachedInputTokens = optionalNumber("cachedInputTokens");
    const cacheWriteInputTokens = optionalNumber("cacheWriteInputTokens");
    const inputTokens = optionalNumber("inputTokens");
    const outputTokens = optionalNumber("outputTokens");
    return [
      {
        activeContextTokens,
        modelContextWindow,
        promptTokens,
        ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
        ...(cacheWriteInputTokens !== undefined ? { cacheWriteInputTokens } : {}),
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
      },
    ];
  });
}

export function readCompletedCodexCompactionStats(events: readonly CapturedAgentEvent[]): {
  count: number;
  durationMs?: number;
  startedCount: number;
} {
  const startedItemIds = new Set<string>();
  const startedAtByItemId = new Map<string, number>();
  let count = 0;
  let durationMs = 0;
  let measuredCount = 0;
  for (const event of events) {
    if (event.stream !== "compaction") {
      continue;
    }
    const itemId = event.data?.itemId;
    if (event.data?.phase === "start" && typeof itemId === "string") {
      startedItemIds.add(itemId);
      if (event.ts !== undefined) {
        startedAtByItemId.set(itemId, event.ts);
      }
      continue;
    }
    if (event.data?.phase !== "end" || event.data?.completed !== true) {
      continue;
    }
    count += 1;
    const startedAt = typeof itemId === "string" ? startedAtByItemId.get(itemId) : undefined;
    if (startedAt !== undefined && event.ts !== undefined) {
      durationMs += Math.max(0, event.ts - startedAt);
      measuredCount += 1;
    }
  }
  return { count, startedCount: startedItemIds.size, ...(measuredCount > 0 ? { durationMs } : {}) };
}

export function extractChatFinalText(event: EventFrame, runId: string): string | undefined {
  if (event.event !== "chat") {
    return undefined;
  }
  const payload = event.payload;
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  if (record.runId !== runId || record.state !== "final") {
    return undefined;
  }
  const message = record.message;
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const messageRecord = message as Record<string, unknown>;
  if (typeof messageRecord.text === "string" && messageRecord.text.trim()) {
    return messageRecord.text;
  }
  const content = Array.isArray(messageRecord.content) ? messageRecord.content : [];
  return content
    .map((entry) =>
      entry && typeof entry === "object" ? (entry as Record<string, unknown>).text : undefined,
    )
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .join("\n")
    .trim();
}

export function readCodexAppServerPluginApprovalId(event: EventFrame): string | undefined {
  if (event.event !== "plugin.approval.requested") {
    return undefined;
  }
  const payload = event.payload;
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  const request = record.request;
  if (!request || typeof request !== "object") {
    return undefined;
  }
  const requestRecord = request as Record<string, unknown>;
  if (requestRecord.pluginId !== "codex") {
    return undefined;
  }
  return typeof record.id === "string" && record.id ? record.id : undefined;
}

export function extractAssistantTexts(messages: unknown[]): string[] {
  const texts: string[] = [];
  for (const entry of messages) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    if ((entry as { role?: unknown }).role !== "assistant") {
      continue;
    }
    const text = extractFirstTextBlock(entry);
    if (typeof text === "string" && text.trim().length > 0) {
      texts.push(text);
    }
  }
  return texts;
}

export function formatAssistantTextPreview(texts: string[], maxChars = 800): string {
  const combined = texts.join("\n\n").trim();
  if (!combined) {
    return "<none>";
  }
  if (combined.length <= maxChars) {
    return combined;
  }
  const half = Math.floor(maxChars / 2);
  return `${combined.slice(0, half)}\n...\n${combined.slice(-half)}`;
}

export type CodexCompactionStressMode =
  | { kind: "off" }
  | { kind: "reduced" }
  | { kind: "full"; modelCatalogPath: string };

export const CODEX_REDUCED_CONTEXT_AUTO_COMPACT_LIMIT = 4_000;

export async function createCodexHarnessWorkspace(workspace: string): Promise<void> {
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(
    path.join(workspace, "AGENTS.md"),
    [
      "# AGENTS.md",
      "",
      "Follow exact reply instructions from the user.",
      "Do not add commentary when asked for an exact response.",
    ].join("\n"),
  );
}

export function parseCodexHarnessModelKey(modelKey: string): { provider: string; modelId: string } {
  const [provider, ...modelParts] = modelKey.split("/");
  const modelId = modelParts.join("/");
  if (!provider?.trim() || !modelId.trim()) {
    throw new Error(`invalid model key: ${modelKey}`);
  }
  return { provider: provider.trim(), modelId: modelId.trim() };
}

export function buildCodexHarnessDenseContext(params: { marker: string; chars: number }): string {
  const lines: string[] = [];
  let length = 0;
  for (let index = 0; length < params.chars; index += 1) {
    const line =
      `${params.marker}|Context stress record ${index}: the copper lighthouse tracks violet weather ` +
      `while patient engineers preserve durable state across each compacted conversation.\n`;
    lines.push(line);
    length += line.length;
  }
  return lines.join("").slice(0, params.chars);
}

export function buildCodexCompactionAppServerArgs(
  mode: CodexCompactionStressMode,
): string[] | undefined {
  const overrides =
    mode.kind === "full"
      ? [
          `model_catalog_json=${JSON.stringify(mode.modelCatalogPath)}`,
          "model_context_window=922000",
          "model_auto_compact_token_limit=700000",
          "model_auto_compact_token_limit_scope=total",
          "tool_output_token_limit=200000",
        ]
      : mode.kind === "reduced"
        ? [
            "model_auto_compact_token_limit_scope=body_after_prefix",
            // Raw nested CodeMode output is not necessarily emitted to model context.
            `model_auto_compact_token_limit=${CODEX_REDUCED_CONTEXT_AUTO_COMPACT_LIMIT}`,
            "tool_output_token_limit=10000",
          ]
        : undefined;
  return overrides ? buildCodexHarnessAppServerArgs(overrides) : undefined;
}
