// ACP bind live gateway tests exercise real ACP runtime sessions, cron visibility, and image probe routing.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { EventFrame } from "../../packages/gateway-protocol/src/index.js";
import { renderCatFacePngBase64 } from "../../test/helpers/live-image-probe.js";
import { getAcpRuntimeBackend } from "../acp/runtime/registry.js";
import { isLiveTestEnabled } from "../agents/live-test-helpers.js";
import type { ChannelOutboundContext } from "../channels/plugins/types.public.js";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  getRuntimeConfig,
} from "../config/config.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { clearPluginLoaderCache } from "../plugins/loader.test-fixtures.js";
import {
  pinActivePluginChannelRegistry,
  releasePinnedPluginChannelRegistry,
  resetPluginRuntimeStateForTest,
} from "../plugins/runtime.js";
import { extractFirstTextBlock } from "../shared/chat-message-content.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { setTestEnvValue } from "../test-utils/env.js";
import { sleep } from "../utils.js";
import type { GatewayClient } from "./client.js";
import { connectTestGatewayClient } from "./gateway-cli-backend.live-helpers.js";
import {
  assertCronJobMatches,
  assertCronJobVisibleViaCli,
  assertLiveImageProbeReply,
  buildLiveCronProbeMessage,
  createLiveCronProbeSpec,
  runOpenClawCliJson,
  shouldRunLiveImageProbe,
} from "./live-agent-probes.js";
import { restoreLiveEnv, snapshotLiveEnv, type LiveEnvSnapshot } from "./live-env-test-helpers.js";
import { startGatewayServer } from "./server.js";

const LIVE = isLiveTestEnabled();
const ACP_BIND_LIVE = isTruthyEnvValue(process.env.OPENCLAW_LIVE_ACP_BIND);
const describeLive = LIVE && ACP_BIND_LIVE ? describe : describe.skip;

const CONNECT_TIMEOUT_MS = resolveLiveTimeoutMs(
  process.env.OPENCLAW_LIVE_ACP_BIND_REQUEST_TIMEOUT_MS,
  90_000,
);
const LIVE_TIMEOUT_MS = 240_000;
const ACP_CRON_MCP_PROBE_MAX_ATTEMPTS = 2;
const ACP_CRON_MCP_PROBE_VERIFY_POLLS = 5;
const ACP_CRON_MCP_PROBE_VERIFY_POLL_MS = 1_000;
const DEFAULT_LIVE_CODEX_MODEL = "gpt-5.6-luna";
const DEFAULT_LIVE_PARENT_MODEL = "openai/gpt-5.4";
type LiveAcpAgent = "claude" | "codex" | "droid" | "gemini" | "opencode";
type CapturedOutboundText = Pick<
  ChannelOutboundContext,
  "accountId" | "text" | "threadId" | "to"
> & { atMs: number };

function snapshotAcpBindLiveEnv(): LiveEnvSnapshot {
  return snapshotLiveEnv(["CODEX_HOME", "OPENCLAW_GATEWAY_PORT"]);
}

function resolveLiveTimeoutMs(raw: string | undefined, fallback: number): number {
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function createSlackCurrentConversationBindingRegistry(deliveries: CapturedOutboundText[]) {
  return createTestRegistry([
    {
      pluginId: "slack",
      source: "test",
      plugin: {
        id: "slack",
        meta: {
          id: "slack",
          label: "Slack",
          selectionLabel: "Slack",
          docsPath: "/channels/slack",
          blurb: "test stub.",
          aliases: [],
        },
        capabilities: { chatTypes: ["direct"] },
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({}),
        },
        conversationBindings: {
          supportsCurrentConversationBinding: true,
        },
        outbound: {
          deliveryMode: "direct" as const,
          shouldTreatDeliveredTextAsVisible: (params: {
            kind: "tool" | "block" | "final";
            text?: string;
          }) => params.kind === "block" && Boolean(params.text?.trim()),
          sendText: async ({ accountId, text, threadId, to }: ChannelOutboundContext) => {
            deliveries.push({ accountId, text, threadId, to, atMs: Date.now() });
            return { channel: "slack", messageId: `proof-${String(deliveries.length)}` };
          },
        },
      },
    },
  ]);
}

function normalizeAcpAgent(raw: string | undefined): LiveAcpAgent {
  const normalized = raw?.trim().toLowerCase();
  if (normalized === "gemini") {
    return "gemini";
  }
  if (normalized === "codex") {
    return "codex";
  }
  if (normalized === "droid") {
    return "droid";
  }
  if (normalized === "opencode") {
    return "opencode";
  }
  return "claude";
}

function extractAssistantTexts(messages: unknown[]): string[] {
  const texts: string[] = [];
  for (const entry of messages) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const role = (entry as { role?: unknown }).role;
    if (role !== "assistant") {
      continue;
    }
    const text = extractFirstTextBlock(entry);
    if (typeof text === "string" && text.trim().length > 0) {
      texts.push(text);
    }
  }
  return texts;
}

function createAcpProbePhrase(words: string, nonce: string): string {
  return `${words} ${nonce.toLowerCase()}`;
}

function createAcpSinglePhrasePrompt(phrase: string): string {
  return `This is a local conversation smoke test. Reply with only this harmless phrase: ${phrase}`;
}

function createAcpRecallPrompt(followupPhrase: string, recallPhrase: string): string {
  return `This is a local conversation memory test. Reply with only these two harmless phrases: ${followupPhrase}; ${recallPhrase}`;
}

function extractSpawnedAcpSessionKey(texts: string[]): string | null {
  for (const text of texts) {
    const match = text.match(/Spawned ACP session (\S+) \(/);
    if (match?.[1]) {
      return match[1];
    }
  }
  return null;
}

async function getFreeGatewayPort(): Promise<number> {
  const { getFreePortBlockWithPermissionFallback } = await import("../test-utils/ports.js");
  return await getFreePortBlockWithPermissionFallback({
    offsets: [0, 1, 2, 4],
    fallbackBase: 41_000,
  });
}

function logLiveStep(message: string): void {
  console.info(`[live-acp-bind] ${message}`);
}

function shouldRequireCronMcpProbe(): boolean {
  return isTruthyEnvValue(process.env.OPENCLAW_LIVE_ACP_BIND_REQUIRE_CRON);
}

function normalizeOpenAiModelRef(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return DEFAULT_LIVE_PARENT_MODEL;
  }
  return trimmed.includes("/") ? trimmed : `openai/${trimmed}`;
}

function resolveLiveParentModel(): string {
  return normalizeOpenAiModelRef(
    process.env.OPENCLAW_LIVE_ACP_BIND_PARENT_MODEL?.trim() ||
      process.env.OPENCLAW_LIVE_ACP_BIND_CODEX_MODEL?.trim() ||
      DEFAULT_LIVE_PARENT_MODEL,
  );
}

function resolveModelObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function prepareCodexHomeForLiveBindTest(tempRoot: string): Promise<void> {
  const home = process.env.HOME?.trim();
  const sourceCodexHome = process.env.CODEX_HOME?.trim() || (home ? path.join(home, ".codex") : "");
  const model = process.env.OPENCLAW_LIVE_ACP_BIND_CODEX_MODEL?.trim() || DEFAULT_LIVE_CODEX_MODEL;
  const codexHome = path.join(tempRoot, "codex-home");
  await fs.mkdir(codexHome, { recursive: true });
  const targetAuthPath = path.join(codexHome, "auth.json");
  let hasAuthFile = false;
  if (sourceCodexHome) {
    await fs.copyFile(path.join(sourceCodexHome, "auth.json"), targetAuthPath).then(
      () => {
        hasAuthFile = true;
      },
      (error: unknown) => {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
          throw error;
        }
      },
    );
  }
  const apiKey = process.env.CODEX_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim();
  if (apiKey && !hasAuthFile) {
    await fs.writeFile(
      targetAuthPath,
      `${JSON.stringify({
        OPENAI_API_KEY: apiKey,
        tokens: null,
        last_refresh: null,
      })}\n`,
      { mode: 0o600 },
    );
  }
  const configPath = path.join(codexHome, "config.toml");
  const sourceConfigPath = sourceCodexHome ? path.join(sourceCodexHome, "config.toml") : "";
  let rawConfig = "";
  try {
    rawConfig = sourceConfigPath ? await fs.readFile(sourceConfigPath, "utf8") : "";
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw error;
    }
  }
  const modelLine = `model = ${JSON.stringify(model)}`;
  let nextConfig = /^model\s*=.*$/m.test(rawConfig)
    ? rawConfig.replace(/^model\s*=.*$/m, modelLine)
    : `${modelLine}\n${rawConfig}`;
  const modelProvider = process.env.MODEL_PROVIDER?.trim();
  if (modelProvider) {
    // codex-acp calls account/read before it passes MODEL_PROVIDER to thread/start.
    // Persist the provider so that auth preflight evaluates the same session provider.
    const modelProviderLine = `model_provider = ${JSON.stringify(modelProvider)}`;
    nextConfig = /^model_provider\s*=.*$/m.test(nextConfig)
      ? nextConfig.replace(/^model_provider\s*=.*$/m, modelProviderLine)
      : `${modelProviderLine}\n${nextConfig}`;
  }
  await fs.writeFile(configPath, nextConfig, "utf8");
  process.env.CODEX_HOME = codexHome;
  logLiveStep(
    `using Codex ACP model ${model}${modelProvider ? ` via ${modelProvider}` : ""}`,
  );
}

async function waitForGatewayPort(params: {
  host: string;
  port: number;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = params.timeoutMs ?? CONNECT_TIMEOUT_MS;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({
        host: params.host,
        port: params.port,
      });
      const finish = (ok: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(ok);
      };
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
      socket.setTimeout(1_000, () => finish(false));
    });
    if (connected) {
      return;
    }
    await sleep(250);
  }

  throw new Error(`timed out waiting for gateway port ${params.host}:${String(params.port)}`);
}

async function connectClient(params: {
  url: string;
  token: string;
  timeoutMs?: number;
  onEvent?: (event: EventFrame) => void;
}) {
  const timeoutMs = params.timeoutMs ?? CONNECT_TIMEOUT_MS;
  return await connectTestGatewayClient({
    ...params,
    timeoutMs,
    maxAttemptTimeoutMs: 35_000,
    clientDisplayName: null,
    requestTimeoutMs: timeoutMs,
    onRetry: (attempt, error) => {
      logLiveStep(`gateway connect warmup retry ${attempt}: ${error.message}`);
    },
  });
}

function isRetryableAcpBindWarmupText(texts: string[]): boolean {
  const combined = texts.join("\n\n").toLowerCase();
  return (
    combined.includes("acp runtime backend is currently unavailable") ||
    combined.includes("try again in a moment") ||
    combined.includes("acp runtime backend is not configured") ||
    combined.includes("acp dispatch is disabled") ||
    combined.includes("startup timed out before initialize completed")
  );
}

describe("isRetryableAcpBindWarmupText", () => {
  it.each([
    {
      texts: ["ACP runtime backend is currently unavailable; try again in a moment."],
      expected: true,
    },
    {
      texts: [
        "ACP error (ACP_SESSION_INIT_FAILED): Gemini CLI ACP startup timed out before initialize completed.",
      ],
      expected: true,
    },
    { texts: ["ACP error (ACP_SESSION_INIT_FAILED): ACP metadata is missing."], expected: false },
  ])("returns $expected for $texts", ({ texts, expected }) => {
    expect(isRetryableAcpBindWarmupText(texts)).toBe(expected);
  });
});

describe("ACP bind live probe prompts", () => {
  it("uses harmless phrases instead of verification-token-shaped markers", () => {
    const followupPhrase = createAcpProbePhrase("violet lantern", "A1B2C3D4");
    const recallPhrase = createAcpProbePhrase("silver harbor", "E5F6A7B8");
    const singlePrompt = createAcpSinglePhrasePrompt(followupPhrase);
    const recallPrompt = createAcpRecallPrompt(followupPhrase, recallPhrase);

    expect(followupPhrase).toBe("violet lantern a1b2c3d4");
    expect(singlePrompt).toContain("harmless phrase");
    expect(recallPrompt).toContain("harmless phrases");
    expect(`${singlePrompt}\n${recallPrompt}`).not.toMatch(/ACP-BIND|verification token/i);
  });
});

function formatAssistantTextPreview(texts: string[], maxChars = 600): string {
  const combined = texts.join("\n\n").trim();
  if (!combined) {
    return "<empty>";
  }
  if (combined.length <= maxChars) {
    return combined;
  }
  return combined.slice(-maxChars);
}

async function bindConversationAndWait(params: {
  client: GatewayClient;
  sessionKey: string;
  liveAgent: LiveAcpAgent;
  originatingChannel: string;
  originatingTo: string;
  originatingAccountId: string;
  cwd?: string;
  timeoutMs?: number;
}): Promise<{ mainAssistantTexts: string[]; spawnedSessionKey: string }> {
  const timeoutMs = params.timeoutMs ?? LIVE_TIMEOUT_MS;
  if (params.cwd && /\s/.test(params.cwd)) {
    throw new Error("ACP live bind proof cwd must not contain whitespace");
  }
  const startedAt = Date.now();
  let attempt = 0;

  while (Date.now() - startedAt < timeoutMs) {
    attempt += 1;
    const backend = getAcpRuntimeBackend("acpx");
    const runtime = backend?.runtime as
      | {
          probeAvailability?: () => Promise<void>;
          doctor?: () => Promise<{ message?: string; details?: string[] }>;
        }
      | undefined;
    const backendUnavailable = !backend || (backend.healthy && !backend.healthy());
    if (backendUnavailable) {
      if (runtime?.probeAvailability) {
        await runtime.probeAvailability().catch(() => {});
      }
      const backendReadyAfterProbe = backend && (!backend.healthy || backend.healthy());
      if (backendReadyAfterProbe) {
        logLiveStep(`acpx backend became healthy before bind attempt ${attempt}`);
      } else {
        if (runtime?.doctor && (attempt === 1 || attempt % 6 === 0)) {
          const report = await runtime.doctor().catch((error: unknown) => ({
            message: error instanceof Error ? error.message : String(error),
            details: [],
          }));
          logLiveStep(
            `acpx doctor before bind attempt ${attempt}: ${report.message ?? "unknown"}${
              report.details?.length ? ` (${report.details.join("; ")})` : ""
            }`,
          );
        }
        logLiveStep(`acpx backend still unhealthy before bind attempt ${attempt}`);
        await sleep(5_000);
        continue;
      }
    }

    await sendChatAndWait({
      client: params.client,
      sessionKey: params.sessionKey,
      idempotencyKey: `idem-bind-${randomUUID()}`,
      message: `/acp spawn ${params.liveAgent} --bind here${params.cwd ? ` --cwd ${params.cwd}` : ""}`,
      originatingChannel: params.originatingChannel,
      originatingTo: params.originatingTo,
      originatingAccountId: params.originatingAccountId,
    });

    const mainHistory: { messages?: unknown[] } = await params.client.request("chat.history", {
      sessionKey: params.sessionKey,
      limit: 16,
    });
    const mainAssistantTexts = extractAssistantTexts(mainHistory.messages ?? []);
    const spawnedSessionKey = extractSpawnedAcpSessionKey(mainAssistantTexts);
    if (
      mainAssistantTexts.join("\n\n").includes("Bound this conversation to") &&
      spawnedSessionKey
    ) {
      return { mainAssistantTexts, spawnedSessionKey };
    }
    if (!isRetryableAcpBindWarmupText(mainAssistantTexts)) {
      throw new Error(
        `bind command did not produce an ACP session: ${formatAssistantTextPreview(mainAssistantTexts)}`,
      );
    }
    logLiveStep(`acpx backend still warming up; retrying bind (${attempt})`);
    await sleep(5_000);
  }

  throw new Error("timed out waiting for the ACP bind command to succeed");
}

async function waitForAgentRunOk(
  client: GatewayClient,
  runId: string,
  timeoutMs = LIVE_TIMEOUT_MS,
) {
  const result = await waitForAgentRun(client, runId, timeoutMs);
  if (result.status !== "ok") {
    throw new Error(`agent.wait failed for ${runId}: status=${String(result.status)}`);
  }
}

async function waitForAgentRun(
  client: GatewayClient,
  runId: string,
  timeoutMs = LIVE_TIMEOUT_MS,
): Promise<{ status?: string; stopReason?: string }> {
  return await client.request(
    "agent.wait",
    {
      runId,
      timeoutMs,
    },
    {
      timeoutMs: timeoutMs + 5_000,
    },
  );
}

type ChatSendParams = {
  client: GatewayClient;
  sessionKey: string;
  idempotencyKey: string;
  message: string;
  originatingChannel: string;
  originatingTo: string;
  originatingAccountId: string;
  attachments?: Array<{
    mimeType: string;
    fileName: string;
    content: string;
  }>;
};

async function startChat(params: ChatSendParams): Promise<string> {
  const started: { runId?: string; status?: string } = await params.client.request("chat.send", {
    sessionKey: params.sessionKey,
    message: params.message,
    idempotencyKey: params.idempotencyKey,
    originatingChannel: params.originatingChannel,
    originatingTo: params.originatingTo,
    originatingAccountId: params.originatingAccountId,
    attachments: params.attachments,
  });
  if (started?.status !== "started" || typeof started.runId !== "string") {
    throw new Error(`chat.send did not start correctly: ${JSON.stringify(started)}`);
  }
  return started.runId;
}

async function sendChatAndWait(params: ChatSendParams) {
  const runId = await startChat(params);
  await waitForAgentRunOk(params.client, runId);
}

function readChatEventPayload(event: EventFrame, runId: string): Record<string, unknown> | null {
  if (event.event !== "chat" || !event.payload || typeof event.payload !== "object") {
    return null;
  }
  const payload = event.payload as Record<string, unknown>;
  return payload.runId === runId ? payload : null;
}

function extractChatEventText(payload: Record<string, unknown>): string {
  return extractFirstTextBlock(payload.message) ??
    (typeof payload.deltaText === "string" ? payload.deltaText : "");
}

async function waitForStreamedPartial(params: {
  events: EventFrame[];
  runId: string;
  phrase: string;
  timeoutMs?: number;
}): Promise<string> {
  const timeoutMs = params.timeoutMs ?? LIVE_TIMEOUT_MS;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    for (const event of params.events) {
      const payload = readChatEventPayload(event, params.runId);
      if (payload?.state !== "delta") {
        continue;
      }
      const text = extractChatEventText(payload);
      if (text.includes(params.phrase)) {
        return text;
      }
    }
    await sleep(50);
  }
  throw new Error("timed out waiting for the ACP partial on the Gateway stream");
}

async function waitForCapturedOutboundText(params: {
  deliveries: CapturedOutboundText[];
  phrase: string;
  timeoutMs?: number;
}): Promise<CapturedOutboundText> {
  const timeoutMs = params.timeoutMs ?? LIVE_TIMEOUT_MS;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const delivery = params.deliveries.find((entry) => entry.text.includes(params.phrase));
    if (delivery) {
      return delivery;
    }
    await sleep(50);
  }
  throw new Error("timed out waiting for the ACP partial to reach the bound channel");
}

function countLiteralOccurrences(texts: string[], phrase: string): number {
  return texts.reduce((count, text) => count + text.split(phrase).length - 1, 0);
}

async function runCancelledPartialTranscriptProof(params: {
  client: GatewayClient;
  events: EventFrame[];
  originalSessionKey: string;
  spawnedSessionKey: string;
  originatingChannel: string;
  originatingTo: string;
  originatingAccountId: string;
  outboundDeliveries: CapturedOutboundText[];
}): Promise<void> {
  const partialPhrase = createAcpProbePhrase("amber current", randomBytes(4).toString("hex"));
  const followupPhrase = createAcpProbePhrase("green compass", randomBytes(4).toString("hex"));
  const authPaths = [
    process.env.CODEX_HOME ? path.join(process.env.CODEX_HOME, "auth.json") : "",
    process.env.OPENCLAW_STATE_DIR
      ? path.join(process.env.OPENCLAW_STATE_DIR, "acpx", "codex-home", "auth.json")
      : "",
  ].filter(Boolean);
  const authFilePresent = (
    await Promise.all(
      authPaths.map((authPath) => fs.access(authPath).then(() => true, () => false)),
    )
  ).some(Boolean);
  const authPresent =
    Boolean(process.env.OPENAI_API_KEY?.trim() || process.env.CODEX_API_KEY?.trim()) ||
    authFilePresent;
  expect(authPresent).toBe(false);

  const runId = await startChat({
    client: params.client,
    sessionKey: params.originalSessionKey,
    idempotencyKey: `idem-cancel-${randomUUID()}`,
    message:
      `Do not use tools. First output this harmless phrase exactly once: ${partialPhrase}. ` +
      "Then keep writing consecutive integers, one per line, until interrupted.",
    originatingChannel: params.originatingChannel,
    originatingTo: params.originatingTo,
    originatingAccountId: params.originatingAccountId,
  });
  const streamedPartial = await waitForStreamedPartial({
    events: params.events,
    runId,
    phrase: partialPhrase,
  });
  const deliveredPartial = await waitForCapturedOutboundText({
    deliveries: params.outboundDeliveries,
    phrase: partialPhrase,
  });
  expect(deliveredPartial.to).toBe(params.originatingTo);
  expect(deliveredPartial.accountId).toBe(params.originatingAccountId);
  // Abort only after both the Gateway stream and the bound-channel adapter saw
  // the partial; a fixed delay cannot prove user-visible delivery.
  const abortResult: { aborted?: boolean; runIds?: unknown[] } = await params.client.request(
    "chat.abort",
    { sessionKey: params.originalSessionKey, runId },
  );
  expect(abortResult.aborted).toBe(true);
  expect(abortResult.runIds).toContain(runId);
  // Explicit chat.abort suppresses later chat frames for this run. agent.wait is
  // the authoritative terminal outcome and retains the rpc stop reason.
  const terminal = await waitForAgentRun(params.client, runId);
  expect(terminal.status).toBe("error");
  expect(terminal.stopReason).toBe("rpc");

  const cancelledHistory = await waitForAssistantText({
    client: params.client,
    sessionKey: params.spawnedSessionKey,
    contains: partialPhrase,
    timeoutMs: 60_000,
  });
  const cancelledAssistantTexts = extractAssistantTexts(cancelledHistory.messages);
  expect(countLiteralOccurrences(cancelledAssistantTexts, partialPhrase)).toBe(1);

  await sendChatAndWait({
    client: params.client,
    sessionKey: params.originalSessionKey,
    idempotencyKey: `idem-after-cancel-${randomUUID()}`,
    message: createAcpSinglePhrasePrompt(followupPhrase),
    originatingChannel: params.originatingChannel,
    originatingTo: params.originatingTo,
    originatingAccountId: params.originatingAccountId,
  });
  const followupHistory = await waitForAssistantText({
    client: params.client,
    sessionKey: params.spawnedSessionKey,
    contains: followupPhrase,
    minAssistantCount: cancelledAssistantTexts.length + 1,
    timeoutMs: 90_000,
  });
  const followupAssistantTexts = extractAssistantTexts(followupHistory.messages);
  expect(countLiteralOccurrences(followupAssistantTexts, partialPhrase)).toBe(1);

  await sleep(2_000);
  const settledHistory: { messages?: unknown[] } = await params.client.request("chat.history", {
    sessionKey: params.spawnedSessionKey,
    limit: 32,
  });
  const settledAssistantTexts = extractAssistantTexts(settledHistory.messages ?? []);
  expect(countLiteralOccurrences(settledAssistantTexts, partialPhrase)).toBe(1);
  expect(settledAssistantTexts.join("\n\n")).toContain(followupPhrase);
  expect(
    countLiteralOccurrences(
      params.outboundDeliveries.map((entry) => entry.text),
      partialPhrase,
    ),
  ).toBe(1);
  expect(
    countLiteralOccurrences(
      params.outboundDeliveries.map((entry) => entry.text),
      followupPhrase,
    ),
  ).toBe(1);

  const preview = deliveredPartial.text.replace(/\s+/g, " ").slice(0, 96);
  const digest = createHash("sha256").update(deliveredPartial.text).digest("hex").slice(0, 16);
  console.info(
    "[acp-abort-proof] agent=codex provider=ollama model=qwen2.5-coder:1.5b auth_present=false",
  );
  console.info(
    `[acp-abort-proof] partial_delivered=true gateway_streamed=${String(streamedPartial.includes(partialPhrase))} target_matched=true chars=${String(deliveredPartial.text.length)} sha256=${digest} preview=${JSON.stringify(preview)}`,
  );
  console.info("[acp-abort-proof] abort_rpc=true run_matched=true");
  console.info("[acp-abort-proof] terminal=error stop_reason=rpc");
  console.info("[acp-abort-proof] followup_ok=true same_bound_session=true");
  console.info("[acp-abort-proof] outbound_partial_copies=1 outbound_followup_copies=1");
  console.info("[acp-abort-proof] assistant_partial_copies=1 stable_after_settle=true");
}

async function waitForAssistantText(params: {
  client: GatewayClient;
  sessionKey: string;
  contains: string;
  minAssistantCount?: number;
  timeoutMs?: number;
}): Promise<{ messages: unknown[]; lastAssistantText: string; matchedAssistantText: string }> {
  const timeoutMs = params.timeoutMs ?? 30_000;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const history: { messages?: unknown[] } = await params.client.request("chat.history", {
      sessionKey: params.sessionKey,
      limit: 16,
    });
    const messages = history.messages ?? [];
    const assistantTexts = extractAssistantTexts(messages);
    const lastAssistantText = assistantTexts.at(-1) ?? "";
    const minAssistantCount = params.minAssistantCount ?? 1;
    const matchedAssistantText = assistantTexts
      .slice(Math.max(0, minAssistantCount - 1))
      .find((text) => text.includes(params.contains));
    if (assistantTexts.length >= minAssistantCount && matchedAssistantText) {
      return { messages, lastAssistantText, matchedAssistantText };
    }
    await sleep(500);
  }

  const finalHistory: { messages?: unknown[] } = await params.client.request("chat.history", {
    sessionKey: params.sessionKey,
    limit: 16,
  });
  throw new Error(
    `timed out waiting for assistant text containing ${params.contains}: ${formatAssistantTextPreview(
      extractAssistantTexts(finalHistory.messages ?? []),
    )}`,
  );
}

async function waitForAssistantTurn(params: {
  client: GatewayClient;
  sessionKey: string;
  minAssistantCount: number;
  timeoutMs?: number;
}): Promise<{ messages: unknown[]; lastAssistantText: string }> {
  const timeoutMs = params.timeoutMs ?? 30_000;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const history: { messages?: unknown[] } = await params.client.request("chat.history", {
      sessionKey: params.sessionKey,
      limit: 16,
    });
    const messages = history.messages ?? [];
    const assistantTexts = extractAssistantTexts(messages);
    const lastAssistantText = assistantTexts.at(-1) ?? null;
    if (assistantTexts.length >= params.minAssistantCount && lastAssistantText) {
      return { messages, lastAssistantText };
    }
    await sleep(500);
  }

  const finalHistory: { messages?: unknown[] } = await params.client.request("chat.history", {
    sessionKey: params.sessionKey,
    limit: 16,
  });
  throw new Error(
    `timed out waiting for assistant turn ${String(params.minAssistantCount)}: ${formatAssistantTextPreview(
      extractAssistantTexts(finalHistory.messages ?? []),
    )}`,
  );
}

async function pollCronJobVisibleViaCli(params: {
  port: number;
  token: string;
  env: NodeJS.ProcessEnv;
  expectedName: string;
  expectedMessage: string;
}): Promise<{
  error?: string;
  job?: Awaited<ReturnType<typeof assertCronJobVisibleViaCli>>;
  pollsUsed: number;
}> {
  for (let verifyAttempt = 0; verifyAttempt < ACP_CRON_MCP_PROBE_VERIFY_POLLS; verifyAttempt += 1) {
    let job: Awaited<ReturnType<typeof assertCronJobVisibleViaCli>>;
    try {
      job = await assertCronJobVisibleViaCli(params);
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
        pollsUsed: verifyAttempt + 1,
      };
    }
    if (job) {
      return { job, pollsUsed: verifyAttempt + 1 };
    }
    if (verifyAttempt < ACP_CRON_MCP_PROBE_VERIFY_POLLS - 1) {
      await sleep(ACP_CRON_MCP_PROBE_VERIFY_POLL_MS);
    }
  }
  return { pollsUsed: ACP_CRON_MCP_PROBE_VERIFY_POLLS };
}

describeLive("gateway live (ACP bind)", () => {
  it(
    "binds a synthetic Slack DM conversation to a live ACP session and reroutes the next turn",
    async () => {
      const previousEnv = snapshotAcpBindLiveEnv();
      const liveAgent = normalizeAcpAgent(process.env.OPENCLAW_LIVE_ACP_BIND_AGENT);
      const agentCommandOverride =
        process.env.OPENCLAW_LIVE_ACP_BIND_AGENT_COMMAND?.trim() || undefined;
      const runCancelTranscriptProbe = isTruthyEnvValue(
        process.env.OPENCLAW_LIVE_ACP_BIND_CANCEL_TRANSCRIPT_PROBE,
      );
      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-live-acp-bind-"));
      const probeWorkspace = path.join(tempRoot, "workspace");
      if (runCancelTranscriptProbe) {
        await fs.mkdir(probeWorkspace, { recursive: true });
      }
      const tempStateDir = path.join(tempRoot, "state");
      const tempConfigPath = path.join(tempRoot, "openclaw.json");
      const port = await getFreeGatewayPort();
      const token = `test-${randomUUID()}`;
      const parentModel = resolveLiveParentModel();
      const originalSessionKey = "main";
      const slackUserId = `U${randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
      const conversationId = `user:${slackUserId}`;
      const accountId = "default";
      const followupToken = createAcpProbePhrase("violet lantern", randomBytes(4).toString("hex"));
      const recallToken = createAcpProbePhrase("silver harbor", randomBytes(4).toString("hex"));
      const memoryToken = createAcpProbePhrase("quiet cedar", randomBytes(4).toString("hex"));
      let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
      let client: GatewayClient | undefined;
      const gatewayEvents: EventFrame[] = [];
      const outboundDeliveries: CapturedOutboundText[] = [];
      let pinnedChannelRegistry:
        | ReturnType<typeof createSlackCurrentConversationBindingRegistry>
        | undefined;

      clearRuntimeConfigSnapshot();
      setTestEnvValue("OPENCLAW_STATE_DIR", tempStateDir);
      process.env.OPENCLAW_SKIP_CHANNELS = "1";
      process.env.OPENCLAW_SKIP_GMAIL_WATCHER = "1";
      process.env.OPENCLAW_SKIP_CRON = "0";
      process.env.OPENCLAW_SKIP_CANVAS_HOST = "1";
      process.env.OPENCLAW_GATEWAY_TOKEN = token;
      process.env.OPENCLAW_GATEWAY_PORT = String(port);
      if (liveAgent === "codex" && !agentCommandOverride) {
        await prepareCodexHomeForLiveBindTest(tempRoot);
      }

      const cfg = getRuntimeConfig();
      const acpxEntry = cfg.plugins?.entries?.acpx;
      const existingAgentOverrides: Record<string, { command?: string }> =
        typeof acpxEntry?.config === "object" &&
        acpxEntry.config &&
        typeof acpxEntry.config.agents === "object" &&
        acpxEntry.config.agents
          ? (acpxEntry.config.agents as Record<string, { command?: string }>)
          : {};
      const nextCfg = {
        ...cfg,
        agents: {
          ...cfg.agents,
          defaults: {
            ...cfg.agents?.defaults,
            model: {
              ...resolveModelObject(cfg.agents?.defaults?.model),
              primary: parentModel,
            },
            models: {
              ...cfg.agents?.defaults?.models,
              [parentModel]: cfg.agents?.defaults?.models?.[parentModel] ?? {},
            },
          },
        },
        gateway: {
          ...cfg.gateway,
          mode: "local",
          bind: "loopback",
          port,
        },
        acp: {
          ...cfg.acp,
          enabled: true,
          backend: "acpx",
          defaultAgent: liveAgent,
          allowedAgents: Array.from(new Set([...(cfg.acp?.allowedAgents ?? []), liveAgent])),
          dispatch: {
            ...cfg.acp?.dispatch,
            enabled: true,
          },
          stream: {
            ...cfg.acp?.stream,
            ...(runCancelTranscriptProbe ? { deliveryMode: "live" as const } : {}),
          },
        },
        plugins: {
          ...cfg.plugins,
          enabled: true,
          allow: Array.from(new Set([...(cfg.plugins?.allow ?? []), "acpx"])),
          entries: {
            ...cfg.plugins?.entries,
            acpx: {
              ...acpxEntry,
              enabled: true,
              config: {
                ...acpxEntry?.config,
                probeAgent: liveAgent,
                // The cancellation proof needs text streaming only; denying ACP
                // approvals prevents a model from expanding its read-only sandbox.
                permissionMode: runCancelTranscriptProbe ? "deny-all" : "approve-all",
                nonInteractivePermissions: "deny",
                openClawToolsMcpBridge: !runCancelTranscriptProbe,
                ...(agentCommandOverride
                  ? {
                      agents: {
                        ...existingAgentOverrides,
                        [liveAgent]: {
                          command: agentCommandOverride,
                        },
                      },
                    }
                  : {}),
              },
            },
          },
        },
        cron: {
          ...cfg.cron,
          enabled: true,
          store: path.join(tempRoot, "cron.json"),
        },
      };
      await fs.writeFile(tempConfigPath, `${JSON.stringify(nextCfg, null, 2)}\n`);
      setTestEnvValue("OPENCLAW_CONFIG_PATH", tempConfigPath);
      logLiveStep(`using parent live model ${parentModel}`);
      clearConfigCache();
      clearRuntimeConfigSnapshot();
      clearPluginLoaderCache();
      resetPluginRuntimeStateForTest();

      try {
        logLiveStep(`starting gateway on port ${String(port)}`);
        server = await startGatewayServer(port, {
          bind: "loopback",
          auth: { mode: "token", token },
          controlUiEnabled: false,
        });
        logLiveStep("gateway startup returned");
        await waitForGatewayPort({ host: "127.0.0.1", port, timeoutMs: CONNECT_TIMEOUT_MS });
        logLiveStep("gateway port is reachable");
        client = await connectClient({
          url: `ws://127.0.0.1:${port}`,
          token,
          timeoutMs: CONNECT_TIMEOUT_MS,
          onEvent: (event) => gatewayEvents.push(event),
        });
        logLiveStep("gateway websocket connected");
        const channelRegistry = createSlackCurrentConversationBindingRegistry(outboundDeliveries);
        pinActivePluginChannelRegistry(channelRegistry);
        pinnedChannelRegistry = channelRegistry;

        const bindResult = await bindConversationAndWait({
          client,
          sessionKey: originalSessionKey,
          liveAgent,
          originatingChannel: "slack",
          originatingTo: conversationId,
          originatingAccountId: accountId,
          cwd: runCancelTranscriptProbe ? probeWorkspace : undefined,
        });
        const { mainAssistantTexts, spawnedSessionKey } = bindResult;
        logLiveStep("bind command completed");
        expect(mainAssistantTexts.join("\n\n")).toContain("Bound this conversation to");
        expect(spawnedSessionKey).toMatch(new RegExp(`^agent:${liveAgent}:acp:`));
        logLiveStep(
          runCancelTranscriptProbe
            ? "binding announced for redacted ACP session"
            : `binding announced for session ${spawnedSessionKey ?? "missing"}`,
        );

        if (runCancelTranscriptProbe) {
          expect(liveAgent).toBe("codex");
          await runCancelledPartialTranscriptProof({
            client,
            events: gatewayEvents,
            originalSessionKey,
            spawnedSessionKey,
            originatingChannel: "slack",
            originatingTo: conversationId,
            originatingAccountId: accountId,
            outboundDeliveries,
          });
          return;
        }

        let firstBoundHistory: Awaited<ReturnType<typeof waitForAssistantText>> | null = null;
        for (let attempt = 0; attempt < 3 && !firstBoundHistory; attempt += 1) {
          await sendChatAndWait({
            client,
            sessionKey: originalSessionKey,
            idempotencyKey: `idem-followup-${attempt}-${randomUUID()}`,
            message: createAcpSinglePhrasePrompt(followupToken),
            originatingChannel: "slack",
            originatingTo: conversationId,
            originatingAccountId: accountId,
          });
          logLiveStep(`follow-up turn completed (attempt ${String(attempt + 1)})`);
          try {
            firstBoundHistory = await waitForAssistantText({
              client,
              sessionKey: spawnedSessionKey,
              contains: followupToken,
              timeoutMs: 60_000,
            });
          } catch {
            if (attempt === 2) {
              break;
            }
            logLiveStep("bound follow-up token not observed yet; retrying");
          }
        }
        if (!firstBoundHistory) {
          try {
            const firstBoundTurn = await waitForAssistantTurn({
              client,
              sessionKey: spawnedSessionKey,
              minAssistantCount: 1,
              timeoutMs: 60_000,
            });
            firstBoundHistory = {
              messages: firstBoundTurn.messages,
              lastAssistantText: firstBoundTurn.lastAssistantText,
              matchedAssistantText: firstBoundTurn.lastAssistantText,
            };
          } catch (error) {
            if (liveAgent !== "claude") {
              throw error;
            }
            firstBoundHistory = { messages: [], lastAssistantText: "", matchedAssistantText: "" };
            logLiveStep("bound follow-up response not observed; continuing to marker probe");
          }
        }
        const observedFollowupToken =
          firstBoundHistory.matchedAssistantText.includes(followupToken);
        const firstAssistantCount = extractAssistantTexts(firstBoundHistory.messages).length;

        let recallHistory: Awaited<ReturnType<typeof waitForAssistantText>> | null = null;
        const expectedRecallAssistantCount = firstAssistantCount + 1;
        const maxRecallAttempts = liveAgent === "claude" ? 3 : 1;
        for (let attempt = 0; attempt < maxRecallAttempts && !recallHistory; attempt += 1) {
          await sendChatAndWait({
            client,
            sessionKey: originalSessionKey,
            idempotencyKey: `idem-memory-${attempt}-${randomUUID()}`,
            message: createAcpRecallPrompt(followupToken, recallToken),
            originatingChannel: "slack",
            originatingTo: conversationId,
            originatingAccountId: accountId,
          });
          logLiveStep(`memory recall turn completed (attempt ${String(attempt + 1)})`);

          try {
            recallHistory = await waitForAssistantText({
              client,
              sessionKey: spawnedSessionKey,
              contains: followupToken,
              minAssistantCount: expectedRecallAssistantCount,
              timeoutMs: liveAgent === "claude" ? 60_000 : 25_000,
            });
          } catch {
            if (attempt === maxRecallAttempts - 1) {
              break;
            }
            logLiveStep("bound memory recall token not observed yet; retrying");
          }
        }
        if (!recallHistory) {
          if (liveAgent === "claude") {
            try {
              const recallTurn = await waitForAssistantTurn({
                client,
                sessionKey: spawnedSessionKey,
                minAssistantCount: expectedRecallAssistantCount,
                timeoutMs: 60_000,
              });
              recallHistory = {
                messages: recallTurn.messages,
                lastAssistantText: recallTurn.lastAssistantText,
                matchedAssistantText: recallTurn.lastAssistantText,
              };
              logLiveStep(
                "bound memory recall response did not repeat token; using turn progression",
              );
            } catch {
              recallHistory = firstBoundHistory;
              logLiveStep(
                "bound memory recall response not observed; continuing from previous bound transcript",
              );
            }
          } else {
            // Live ACP harnesses can miss or significantly delay this intermediate recall turn.
            // Continue from the previously observed bound transcript and validate marker/image/cron
            // on subsequent turns.
            recallHistory = firstBoundHistory;
            logLiveStep(
              "bound memory recall response not observed; continuing from previous bound transcript",
            );
          }
        }
        const recallAssistantText = recallHistory.matchedAssistantText;
        if (liveAgent === "claude" && recallAssistantText.includes(recallToken)) {
          expect(recallAssistantText).toContain(followupToken);
          expect(recallAssistantText).toContain(recallToken);
        }
        logLiveStep("bound session transcript retained the previous token");
        const recallAssistantCount = extractAssistantTexts(recallHistory.messages).length;

        let boundHistory: Awaited<ReturnType<typeof waitForAssistantText>> | null = null;
        for (let attempt = 0; attempt < 3 && !boundHistory; attempt += 1) {
          await sendChatAndWait({
            client,
            sessionKey: originalSessionKey,
            idempotencyKey: `idem-marker-${attempt}-${randomUUID()}`,
            message: createAcpSinglePhrasePrompt(memoryToken),
            originatingChannel: "slack",
            originatingTo: conversationId,
            originatingAccountId: accountId,
          });
          logLiveStep(`memory marker turn completed (attempt ${String(attempt + 1)})`);
          try {
            boundHistory = await waitForAssistantText({
              client,
              sessionKey: spawnedSessionKey,
              contains: memoryToken,
              minAssistantCount: recallAssistantCount + 1,
            });
          } catch {
            if (attempt === 2) {
              throw new Error(
                `${liveAgent} ACP bind completed, but the bound session did not emit the marker transcript`,
              );
            }
            logLiveStep("bound marker token not observed yet; retrying");
          }
        }
        if (!boundHistory) {
          throw new Error(`timed out waiting for bound marker phrase ${memoryToken}`);
        }
        const assistantTexts = extractAssistantTexts(boundHistory.messages);
        if (observedFollowupToken) {
          expect(assistantTexts.join("\n\n")).toContain(followupToken);
        }
        expect(boundHistory.matchedAssistantText).toContain(memoryToken);
        logLiveStep("bound session transcript contains the final marker token");

        if (
          shouldRunLiveImageProbe({
            agent: liveAgent,
            override: process.env.OPENCLAW_LIVE_ACP_BIND_IMAGE_PROBE,
          })
        ) {
          const markerAssistantCount = assistantTexts.length;
          let imageHistory: Awaited<ReturnType<typeof waitForAssistantTurn>> | null = null;
          for (let attempt = 0; attempt < 2 && !imageHistory; attempt += 1) {
            await sendChatAndWait({
              client,
              sessionKey: originalSessionKey,
              idempotencyKey: `idem-image-${attempt}-${randomUUID()}`,
              message:
                "What animal is drawn in the attached image? Reply with only the lowercase animal name.",
              originatingChannel: "slack",
              originatingTo: conversationId,
              originatingAccountId: accountId,
              attachments: [
                {
                  mimeType: "image/png",
                  fileName: `probe-${randomUUID()}.png`,
                  content: renderCatFacePngBase64(),
                },
              ],
            });
            logLiveStep(`image turn completed (attempt ${String(attempt + 1)})`);

            try {
              imageHistory = await waitForAssistantTurn({
                client,
                sessionKey: spawnedSessionKey,
                minAssistantCount: markerAssistantCount + 1,
                timeoutMs: liveAgent === "claude" ? 60_000 : 45_000,
              });
            } catch {
              if (attempt === 1) {
                logLiveStep(
                  "bound session image reply not observed; continuing to cron verification",
                );
                break;
              }
              logLiveStep("bound session image reply not observed yet; retrying");
            }
          }
          if (imageHistory) {
            assertLiveImageProbeReply(imageHistory.lastAssistantText);
            logLiveStep("bound session classified the probe image");
          }
        } else {
          logLiveStep(`skipping image probe for ${liveAgent}`);
        }

        const requireCronMcpProbe = shouldRequireCronMcpProbe();
        let cronJobId: string | undefined;
        let lastCronAssistantText = "";
        let lastCronProbeName = "";
        let lastCronMismatch = "";
        for (let attempt = 0; attempt < ACP_CRON_MCP_PROBE_MAX_ATTEMPTS; attempt += 1) {
          const cronProbe = createLiveCronProbeSpec({
            agentId: liveAgent,
            sessionKey: spawnedSessionKey,
          });
          lastCronProbeName = cronProbe.name;
          try {
            await sendChatAndWait({
              client,
              sessionKey: originalSessionKey,
              idempotencyKey: `idem-cron-${attempt}-${randomUUID()}`,
              message: buildLiveCronProbeMessage({
                agent: liveAgent,
                argsJson: cronProbe.argsJson,
                attempt,
                exactReply: cronProbe.name,
              }),
              originatingChannel: "slack",
              originatingTo: conversationId,
              originatingAccountId: accountId,
            });
          } catch (error) {
            lastCronMismatch = error instanceof Error ? error.message : String(error);
            logLiveStep(
              `cron mcp turn failed after attempt ${String(attempt + 1)}: ${lastCronMismatch}`,
            );
            if (!requireCronMcpProbe) {
              logLiveStep(
                `cron mcp turn ${lastCronProbeName} failed; continuing after bind/image verification`,
              );
              break;
            }
            if (attempt === ACP_CRON_MCP_PROBE_MAX_ATTEMPTS - 1) {
              throw error;
            }
            continue;
          }
          logLiveStep(`cron mcp turn completed (attempt ${String(attempt + 1)})`);

          let cronHistory: Awaited<ReturnType<typeof waitForAssistantText>> | null = null;
          try {
            cronHistory = await waitForAssistantText({
              client,
              sessionKey: spawnedSessionKey,
              timeoutMs: 20_000,
              contains: cronProbe.name,
            });
          } catch {
            logLiveStep("cron assistant reply not observed yet; relying on CLI verification");
          }
          if (cronHistory) {
            lastCronAssistantText = cronHistory.lastAssistantText;
          }
          const verifyResult = await pollCronJobVisibleViaCli({
            port,
            token,
            env: process.env,
            expectedName: cronProbe.name,
            expectedMessage: cronProbe.message,
          });
          const createdJob = verifyResult.job;
          if (verifyResult.error) {
            lastCronMismatch = verifyResult.error;
            logLiveStep(
              `cron cli verification failed after attempt ${String(
                attempt + 1,
              )}; polls=${String(verifyResult.pollsUsed)}; error=${lastCronMismatch}`,
            );
          }
          if (createdJob) {
            try {
              assertCronJobMatches({
                job: createdJob,
                expectedName: cronProbe.name,
                expectedMessage: cronProbe.message,
                expectedSessionKey: spawnedSessionKey,
                expectedAgentId: liveAgent,
              });
            } catch (error) {
              lastCronMismatch = error instanceof Error ? error.message : String(error);
              logLiveStep(
                `cron mcp job ${cronProbe.name} mismatch after attempt ${String(
                  attempt + 1,
                )}: ${lastCronMismatch}`,
              );
              if (attempt === ACP_CRON_MCP_PROBE_MAX_ATTEMPTS - 1 && requireCronMcpProbe) {
                throw error;
              }
              continue;
            }
            cronJobId = createdJob.id;
            if (cronHistory) {
              expect(cronHistory.lastAssistantText.trim().length).toBeGreaterThan(0);
            }
            break;
          }
          logLiveStep(
            `cron mcp job not observed after attempt ${String(
              attempt + 1,
            )}; polls=${String(verifyResult.pollsUsed)}`,
          );
          if (attempt === ACP_CRON_MCP_PROBE_MAX_ATTEMPTS - 1) {
            if (!requireCronMcpProbe) {
              logLiveStep(
                `cron mcp job ${lastCronProbeName} not observed; continuing after bind/image verification${
                  lastCronMismatch ? `; last mismatch=${lastCronMismatch}` : ""
                }`,
              );
              break;
            }
            throw new Error(
              `acp cron cli verify could not find job ${lastCronProbeName}: reply=${JSON.stringify(
                lastCronAssistantText,
              )}${lastCronMismatch ? ` mismatch=${lastCronMismatch}` : ""}`,
            );
          }
        }
        if (!cronJobId) {
          if (!requireCronMcpProbe) {
            return;
          }
          throw new Error(`acp cron cli verify did not create job ${lastCronProbeName}`);
        }
        await runOpenClawCliJson(
          ["cron", "rm", cronJobId, "--json", "--url", `ws://127.0.0.1:${port}`, "--token", token],
          process.env,
        );
        logLiveStep("bound session created cron via MCP and CLI verification passed");
      } finally {
        try {
          if (pinnedChannelRegistry) {
            releasePinnedPluginChannelRegistry(pinnedChannelRegistry);
          }
          clearConfigCache();
          clearRuntimeConfigSnapshot();
          await client?.stopAndWait({ timeoutMs: 2_000 }).catch(() => {});
          await server?.close();
        } finally {
          await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
          restoreLiveEnv(previousEnv);
        }
      }
    },
    LIVE_TIMEOUT_MS + 360_000,
  );
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
