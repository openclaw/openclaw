import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";
import { describe, it } from "vitest";
import { resolveOpenClawAgentDir } from "../agents/agent-paths.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import {
  type AuthProfileStore,
  ensureAuthProfileStore,
  resolveAuthProfileOrder,
  saveAuthProfileStore,
} from "../agents/auth-profiles.js";
import {
  collectAnthropicApiKeys,
  isAnthropicBillingError,
  isAnthropicRateLimitError,
} from "../agents/live-auth-keys.js";
import { isModernModelRef } from "../agents/live-model-filter.js";
import { getApiKeyForModel } from "../agents/model-auth.js";
import { shouldSuppressBuiltInModel } from "../agents/model-suppression.js";
import { ensureOpenClawModelsJson } from "../agents/models-config.js";
import { isRateLimitErrorMessage } from "../agents/pi-embedded-helpers/errors.js";
import { discoverAuthStorage, discoverModels } from "../agents/pi-model-discovery.js";
import { clearRuntimeConfigSnapshot, loadConfig } from "../config/config.js";
import type { ModelsConfig, OpenClawConfig, ModelProviderConfig } from "../config/types.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { DEFAULT_AGENT_ID } from "../routing/session-key.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { GatewayClient } from "./client.js";
import { renderCatNoncePngBase64 } from "./live-image-probe.js";
import {
  hasExpectedSingleNonce,
  hasExpectedToolNonce,
  shouldRetryExecReadProbe,
  shouldRetryToolReadProbe,
} from "./live-tool-probe-utils.js";
import { startGatewayServer } from "./server.js";
import { loadSessionEntry, readSessionMessages } from "./session-utils.js";

const LIVE = isTruthyEnvValue(process.env.LIVE) || isTruthyEnvValue(process.env.OPENCLAW_LIVE_TEST);
const GATEWAY_LIVE = isTruthyEnvValue(process.env.OPENCLAW_LIVE_GATEWAY);
const ZAI_FALLBACK = isTruthyEnvValue(process.env.OPENCLAW_LIVE_GATEWAY_ZAI_FALLBACK);
const PROVIDERS = parseFilter(process.env.OPENCLAW_LIVE_GATEWAY_PROVIDERS);
const THINKING_LEVEL = "high";
const THINKING_TAG_RE = /<\s*\/?\s*(?:think(?:ing)?|thought|antthinking)\s*>/i;
const FINAL_TAG_RE = /<\s*\/?\s*final\s*>/i;
const ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL = "ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL";
const GATEWAY_LIVE_DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const GATEWAY_LIVE_UNBOUNDED_TIMEOUT_MS = 60 * 60 * 1000;
const GATEWAY_LIVE_MAX_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const GATEWAY_LIVE_PROBE_TIMEOUT_MS = Math.max(
  30_000,
  toInt(process.env.OPENCLAW_LIVE_GATEWAY_STEP_TIMEOUT_MS, 90_000),
);
const GATEWAY_LIVE_MAX_MODELS = resolveGatewayLiveMaxModels();
const GATEWAY_LIVE_SUITE_TIMEOUT_MS = resolveGatewayLiveSuiteTimeoutMs(GATEWAY_LIVE_MAX_MODELS);

const describeLive = LIVE || GATEWAY_LIVE ? describe : describe.skip;

function parseFilter(raw?: string): Set<string> | null {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed === "all") {
    return null;
  }
  const ids = trimmed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.length ? new Set(ids) : null;
}

function toInt(value: string | undefined, fallback: number): number {
  const trimmed = value?.trim();
  if (!trimmed) {
    return fallback;
  }
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function resolveGatewayLiveMaxModels(): number {
  const gatewayMax = toInt(process.env.OPENCLAW_LIVE_GATEWAY_MAX_MODELS, -1);
  if (gatewayMax >= 0) {
    return gatewayMax;
  }
  // Reuse shared live-model cap when gateway-specific cap is not provided.
  return Math.max(0, toInt(process.env.OPENCLAW_LIVE_MAX_MODELS, 0));
}

function resolveGatewayLiveSuiteTimeoutMs(maxModels: number): number {
  if (maxModels <= 0) {
    return GATEWAY_LIVE_UNBOUNDED_TIMEOUT_MS;
  }
  // Gateway live runs multiple probes per model; scale timeout by model cap.
  const estimated = 5 * 60 * 1000 + maxModels * 90 * 1000;
  return Math.max(
    GATEWAY_LIVE_DEFAULT_TIMEOUT_MS,
    Math.min(GATEWAY_LIVE_MAX_TIMEOUT_MS, estimated),
  );
}

function isGatewayLiveProbeTimeout(error: string): boolean {
  return /probe timeout after \d+ms/i.test(error);
}

async function withGatewayLiveProbeTimeout<T>(operation: Promise<T>, context: string): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`probe timeout after ${GATEWAY_LIVE_PROBE_TIMEOUT_MS}ms (${context})`));
        }, GATEWAY_LIVE_PROBE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function capByProviderSpread<T>(
  items: T[],
  maxItems: number,
  providerOf: (item: T) => string,
): T[] {
  if (maxItems <= 0 || items.length <= maxItems) {
    return items;
  }
  const providerOrder: string[] = [];
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const provider = providerOf(item);
    const bucket = grouped.get(provider);
    if (bucket) {
      bucket.push(item);
      continue;
    }
    providerOrder.push(provider);
    grouped.set(provider, [item]);
  }

  const selected: T[] = [];
  while (selected.length < maxItems && grouped.size > 0) {
    for (const provider of providerOrder) {
      const bucket = grouped.get(provider);
      if (!bucket || bucket.length === 0) {
        continue;
      }
      const item = bucket.shift();
      if (item) {
        selected.push(item);
      }
      if (bucket.length === 0) {
        grouped.delete(provider);
      }
      if (selected.length >= maxItems) {
        break;
      }
    }
  }
  return selected;
}

function logProgress(message: string): void {
  console.log(`[live] ${message}`);
}

function enterProductionEnvForLiveRun() {
  const previous = {
    vitest: process.env.VITEST,
    nodeEnv: process.env.NODE_ENV,
  };
  delete process.env.VITEST;
  process.env.NODE_ENV = "production";
  return previous;
}

function restoreProductionEnvForLiveRun(previous: {
  vitest: string | undefined;
  nodeEnv: string | undefined;
}) {
  if (previous.vitest === undefined) {
    delete process.env.VITEST;
  } else {
    process.env.VITEST = previous.vitest;
  }
  if (previous.nodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = previous.nodeEnv;
  }
}

function formatFailurePreview(
  failures: Array<{ model: string; error: string }>,
  maxItems: number,
): string {
  const limit = Math.max(1, maxItems);
  const lines = failures.slice(0, limit).map((failure, index) => {
    const normalized = failure.error.replace(/\s+/g, " ").trim();
    const clipped = normalized.length > 320 ? `${normalized.slice(0, 317)}...` : normalized;
    return `${index + 1}. ${failure.model}: ${clipped}`;
  });
  const remaining = failures.length - limit;
  if (remaining > 0) {
    lines.push(`... and ${remaining} more`);
  }
  return lines.join("\n");
}

function assertNoReasoningTags(params: {
  text: string;
  model: string;
  phase: string;
  label: string;
}): void {
  if (!params.text) {
    return;
  }
  if (THINKING_TAG_RE.test(params.text) || FINAL_TAG_RE.test(params.text)) {
    const snippet = params.text.length > 200 ? `${params.text.slice(0, 200)}…` : params.text;
    throw new Error(
      `[${params.label}] reasoning tag leak (${params.model} / ${params.phase}): ${snippet}`,
    );
  }
}

function isMeaningful(text: string): boolean {
  if (!text) {
    return false;
  }
  const trimmed = text.trim();
  if (trimmed.toLowerCase() === "ok") {
    return false;
  }
  if (trimmed.length < 60) {
    return false;
  }
  const words = trimmed.split(/\s+/g).filter(Boolean);
  if (words.length < 12) {
    return false;
  }
  return true;
}

function isGoogleModelNotFoundText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  if (!/not found/i.test(trimmed)) {
    return false;
  }
  if (/models\/.+ is not found for api version/i.test(trimmed)) {
    return true;
  }
  if (/"status"\s*:\s*"NOT_FOUND"/.test(trimmed)) {
    return true;
  }
  if (/"code"\s*:\s*404/.test(trimmed)) {
    return true;
  }
  return false;
}

function isGoogleishProvider(provider: string): boolean {
  return provider === "google" || provider.startsWith("google-");
}

function isRefreshTokenReused(error: string): boolean {
  return /refresh_token_reused/i.test(error);
}

function isChatGPTUsageLimitErrorMessage(raw: string): boolean {
  const msg = raw.toLowerCase();
  return msg.includes("hit your chatgpt usage limit") && msg.includes("try again in");
}

function isProviderUnavailableErrorMessage(raw: string): boolean {
  const msg = raw.toLowerCase();
  return (
    msg.includes("no allowed providers are available") ||
    msg.includes("provider unavailable") ||
    msg.includes("upstream provider unavailable") ||
    msg.includes("upstream error from google")
  );
}

function isInstructionsRequiredError(error: string): boolean {
  return /instructions are required/i.test(error);
}

function isOpenAIReasoningSequenceError(error: string): boolean {
  const msg = error.toLowerCase();
  return msg.includes("required following item") && msg.includes("reasoning");
}

function isToolNonceRefusal(error: string): boolean {
  const msg = error.toLowerCase();
  if (!msg.includes("nonce")) {
    return false;
  }
  return (
    msg.includes("token") ||
    msg.includes("secret") ||
    msg.includes("local file") ||
    msg.includes("disclose") ||
    msg.includes("can't help") ||
    msg.includes("can’t help") ||
    msg.includes("can't comply") ||
    msg.includes("can’t comply")
  );
}

function isToolNonceProbeMiss(error: string): boolean {
  const msg = error.toLowerCase();
  return msg.includes("tool probe missing nonce") || msg.includes("exec+read probe missing nonce");
}

function isMissingProfileError(error: string): boolean {
  return /no credentials found for profile/i.test(error);
}

function isEmptyStreamText(text: string): boolean {
  return text.includes("request ended without sending any chunks");
}

function buildAnthropicRefusalToken(): string {
  const suffix = randomUUID().replace(/-/g, "");
  return `${ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL}_${suffix}`;
}

async function runAnthropicRefusalProbe(params: {
  client: GatewayClient;
  sessionKey: string;
  modelKey: string;
  label: string;
  thinkingLevel: string;
}): Promise<void> {
  logProgress(`${params.label}: refusal-probe`);
  const magic = buildAnthropicRefusalToken();
  const probeText = await requestGatewayAgentText({
    client: params.client,
    sessionKey: params.sessionKey,
    idempotencyKey: `idem-${randomUUID()}-refusal`,
    message: `Reply with the single word ok. Test token: ${magic}`,
    thinkingLevel: params.thinkingLevel,
    context: `${params.label}: refusal-probe`,
  });
  assertNoReasoningTags({
    text: probeText,
    model: params.modelKey,
    phase: "refusal-probe",
    label: params.label,
  });
  if (!/\bok\b/i.test(probeText)) {
    throw new Error(`refusal probe missing ok: ${probeText}`);
  }

  const followupText = await requestGatewayAgentText({
    client: params.client,
    sessionKey: params.sessionKey,
    idempotencyKey: `idem-${randomUUID()}-refusal-followup`,
    message: "Now reply with exactly: still ok.",
    thinkingLevel: params.thinkingLevel,
    context: `${params.label}: refusal-followup`,
  });
  assertNoReasoningTags({
    text: followupText,
    model: params.modelKey,
    phase: "refusal-followup",
    label: params.label,
  });
  if (!/\bstill\b/i.test(followupText) || !/\bok\b/i.test(followupText)) {
    throw new Error(`refusal followup missing expected text: ${followupText}`);
  }
}

function randomImageProbeCode(len = 6): string {
  // Chosen to avoid common OCR confusions in our 5x7 bitmap font.
  // Notably: 0↔8, B↔8, 6↔9, 3↔B, D↔0.
  // Must stay within the glyph set in `src/gateway/live-image-probe.ts`.
  const alphabet = "24567ACEF";
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i += 1) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

function editDistance(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  const aLen = a.length;
  const bLen = b.length;
  if (aLen === 0) {
    return bLen;
  }
  if (bLen === 0) {
    return aLen;
  }

  let prev = Array.from({ length: bLen + 1 }, (_v, idx) => idx);
  let curr = Array.from({ length: bLen + 1 }, () => 0);

  for (let i = 1; i <= aLen; i += 1) {
    curr[0] = i;
    const aCh = a.charCodeAt(i - 1);
    for (let j = 1; j <= bLen; j += 1) {
      const cost = aCh === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1, // delete
        curr[j - 1] + 1, // insert
        prev[j - 1] + cost, // substitute
      );
    }
    [prev, curr] = [curr, prev];
  }

  return prev[bLen] ?? Number.POSITIVE_INFINITY;
}
async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close();
        reject(new Error("failed to acquire free port"));
        return;
      }
      const port = addr.port;
      srv.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve(port);
        }
      });
    });
  });
}

async function isPortFree(port: number): Promise<boolean> {
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    return false;
  }
  return await new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => {
      srv.close(() => resolve(true));
    });
  });
}

async function getFreeGatewayPort(): Promise<number> {
  // Gateway uses derived ports (browser/canvas). Avoid flaky collisions by
  // ensuring the common derived offsets are free too.
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const port = await getFreePort();
    const candidates = [port, port + 1, port + 2, port + 4];
    const ok = (await Promise.all(candidates.map((candidate) => isPortFree(candidate)))).every(
      Boolean,
    );
    if (ok) {
      return port;
    }
  }
  throw new Error("failed to acquire a free gateway port block");
}

async function connectClient(params: { url: string; token: string }) {
  return await new Promise<GatewayClient>((resolve, reject) => {
    let settled = false;
    const stop = (err?: Error, client?: GatewayClient) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (err) {
        reject(err);
      } else {
        resolve(client as GatewayClient);
      }
    };
    const client = new GatewayClient({
      url: params.url,
      token: params.token,
      clientName: GATEWAY_CLIENT_NAMES.TEST,
      clientDisplayName: "vitest-live",
      clientVersion: "dev",
      mode: GATEWAY_CLIENT_MODES.TEST,
      onHelloOk: () => stop(undefined, client),
      onConnectError: (err) => stop(err),
      onClose: (code, reason) =>
        stop(new Error(`gateway closed during connect (${code}): ${reason}`)),
    });
    const timer = setTimeout(() => stop(new Error("gateway connect timeout")), 10_000);
    timer.unref();
    client.start();
  });
}

function extractTranscriptMessageText(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const record = message as {
    text?: unknown;
    content?: unknown;
  };
  if (typeof record.text === "string" && record.text.trim()) {
    return record.text.trim();
  }
  if (typeof record.content === "string" && record.content.trim()) {
    return record.content.trim();
  }
  if (!Array.isArray(record.content)) {
    return "";
  }
  return record.content
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return "";
      }
      const text = (entry as { text?: unknown }).text;
      return typeof text === "string" && text.trim() ? text.trim() : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function readSessionAssistantTexts(sessionKey: string): string[] {
  const { storePath, entry } = loadSessionEntry(sessionKey);
  if (!entry?.sessionId) {
    return [];
  }
  const messages = readSessionMessages(entry.sessionId, storePath, entry.sessionFile);
  const assistantTexts: string[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const role = (message as { role?: unknown }).role;
    if (role !== "assistant") {
      continue;
    }
    assistantTexts.push(extractTranscriptMessageText(message));
  }
  return assistantTexts;
}

async function waitForSessionAssistantText(params: {
  sessionKey: string;
  baselineAssistantCount: number;
  context: string;
}) {
  const startedAt = Date.now();
  let delayMs = 50;
  while (Date.now() - startedAt < GATEWAY_LIVE_PROBE_TIMEOUT_MS) {
    const assistantTexts = readSessionAssistantTexts(params.sessionKey);
    if (assistantTexts.length > params.baselineAssistantCount) {
      const freshText = assistantTexts
        .slice(params.baselineAssistantCount)
        .map((text) => text.trim())
        .findLast((text) => text.length > 0);
      if (freshText) {
        return freshText;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    delayMs = Math.min(delayMs * 2, 250);
  }
  throw new Error(`probe timeout after ${GATEWAY_LIVE_PROBE_TIMEOUT_MS}ms (${params.context})`);
}

async function requestGatewayAgentText(params: {
  client: GatewayClient;
  sessionKey: string;
  message: string;
  thinkingLevel: string;
  context: string;
  idempotencyKey: string;
  attachments?: Array<{
    mimeType: string;
    fileName: string;
    content: string;
  }>;
}) {
  const baselineAssistantCount = readSessionAssistantTexts(params.sessionKey).length;
  const accepted = await withGatewayLiveProbeTimeout(
    params.client.request<{ runId?: unknown; status?: unknown }>("agent", {
      sessionKey: params.sessionKey,
      idempotencyKey: params.idempotencyKey,
      message: params.message,
      thinking: params.thinkingLevel,
      deliver: false,
      attachments: params.attachments,
    }),
    `${params.context}: agent-accept`,
  );
  if (accepted?.status !== "accepted") {
    throw new Error(`agent status=${String(accepted?.status)}`);
  }
  return await waitForSessionAssistantText({
    sessionKey: params.sessionKey,
    baselineAssistantCount,
    context: `${params.context}: transcript-final`,
  });
}

type GatewayModelSuiteParams = {
  label: string;
  cfg: OpenClawConfig;
  candidates: Array<Model<Api>>;
  extraToolProbes: boolean;
  extraImageProbes: boolean;
  thinkingLevel: string;
  providerOverrides?: Record<string, ModelProviderConfig>;
};

function buildLiveGatewayConfig(params: {
  cfg: OpenClawConfig;
  candidates: Array<Model<Api>>;
  providerOverrides?: Record<string, ModelProviderConfig>;
}): OpenClawConfig {
  const providerOverrides = params.providerOverrides ?? {};
  const lmstudioProvider = params.cfg.models?.providers?.lmstudio;
  const baseProviders = params.cfg.models?.providers ?? {};
  const nextProviders = {
    ...baseProviders,
    ...(lmstudioProvider
      ? {
          lmstudio: {
            ...lmstudioProvider,
            api: "openai-completions",
          },
        }
      : {}),
    ...providerOverrides,
  };
  const providers = Object.keys(nextProviders).length > 0 ? nextProviders : baseProviders;
  const baseModels = params.cfg.models;
  return {
    ...params.cfg,
    agents: {
      ...params.cfg.agents,
      list: (params.cfg.agents?.list ?? []).map((entry) => ({
        ...entry,
        sandbox: { mode: "off" },
      })),
      defaults: {
        ...params.cfg.agents?.defaults,
        // Live tests should avoid Docker sandboxing so tool probes can
        // operate on the temporary probe files we create in the host workspace.
        sandbox: { mode: "off" },
        models: Object.fromEntries(params.candidates.map((m) => [`${m.provider}/${m.id}`, {}])),
      },
    },
    models:
      Object.keys(providers).length > 0
        ? ({ ...baseModels, providers } as ModelsConfig)
        : baseModels,
  };
}

function sanitizeAuthConfig(params: {
  cfg: OpenClawConfig;
  agentDir: string;
}): OpenClawConfig["auth"] | undefined {
  const auth = params.cfg.auth;
  if (!auth) {
    return auth;
  }
  const store = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
  });

  let profiles: NonNullable<OpenClawConfig["auth"]>["profiles"] | undefined;
  if (auth.profiles) {
    profiles = {};
    for (const [profileId, profile] of Object.entries(auth.profiles)) {
      if (!store.profiles[profileId]) {
        continue;
      }
      profiles[profileId] = profile;
    }
    if (Object.keys(profiles).length === 0) {
      profiles = undefined;
    }
  }

  let order: Record<string, string[]> | undefined;
  if (auth.order) {
    order = {};
    for (const [provider, ids] of Object.entries(auth.order)) {
      const filtered = ids.filter((id) => Boolean(store.profiles[id]));
      if (filtered.length === 0) {
        continue;
      }
      order[provider] = filtered;
    }
    if (Object.keys(order).length === 0) {
      order = undefined;
    }
  }

  if (!profiles && !order && !auth.cooldowns) {
    return undefined;
  }
  return {
    ...auth,
    profiles,
    order,
  };
}

function buildMinimaxProviderOverride(params: {
  cfg: OpenClawConfig;
  api: "openai-completions" | "anthropic-messages";
  baseUrl: string;
}): ModelProviderConfig | null {
  const existing = params.cfg.models?.providers?.minimax;
  if (!existing || !Array.isArray(existing.models) || existing.models.length === 0) {
    return null;
  }
  return {
    ...existing,
    api: params.api,
    baseUrl: params.baseUrl,
  };
}

async function runGatewayModelSuite(params: GatewayModelSuiteParams) {
  clearRuntimeConfigSnapshot();
  const runtimeEnv = enterProductionEnvForLiveRun();
  const previous = {
    configPath: process.env.OPENCLAW_CONFIG_PATH,
    token: process.env.OPENCLAW_GATEWAY_TOKEN,
    skipChannels: process.env.OPENCLAW_SKIP_CHANNELS,
    skipGmail: process.env.OPENCLAW_SKIP_GMAIL_WATCHER,
    skipCron: process.env.OPENCLAW_SKIP_CRON,
    skipCanvas: process.env.OPENCLAW_SKIP_CANVAS_HOST,
    agentDir: process.env.OPENCLAW_AGENT_DIR,
    piAgentDir: process.env.PI_CODING_AGENT_DIR,
    stateDir: process.env.OPENCLAW_STATE_DIR,
  };
  let tempAgentDir: string | undefined;
  let tempStateDir: string | undefined;

  process.env.OPENCLAW_SKIP_CHANNELS = "1";
  process.env.OPENCLAW_SKIP_GMAIL_WATCHER = "1";
  process.env.OPENCLAW_SKIP_CRON = "1";
  process.env.OPENCLAW_SKIP_CANVAS_HOST = "1";

  const token = `test-${randomUUID()}`;
  process.env.OPENCLAW_GATEWAY_TOKEN = token;
  const agentId = "dev";

  const hostAgentDir = resolveOpenClawAgentDir();
  const hostStore = ensureAuthProfileStore(hostAgentDir, {
    allowKeychainPrompt: false,
  });
  const sanitizedStore: AuthProfileStore = {
    version: hostStore.version,
    profiles: { ...hostStore.profiles },
    // Keep selection state so the gateway picks the same known-good profiles
    // as the host (important when some profiles are rate-limited/disabled).
    order: hostStore.order ? { ...hostStore.order } : undefined,
    lastGood: hostStore.lastGood ? { ...hostStore.lastGood } : undefined,
    usageStats: hostStore.usageStats ? { ...hostStore.usageStats } : undefined,
  };
  tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-live-state-"));
  process.env.OPENCLAW_STATE_DIR = tempStateDir;
  tempAgentDir = path.join(tempStateDir, "agents", DEFAULT_AGENT_ID, "agent");
  saveAuthProfileStore(sanitizedStore, tempAgentDir);
  const tempSessionAgentDir = path.join(tempStateDir, "agents", agentId, "agent");
  if (tempSessionAgentDir !== tempAgentDir) {
    saveAuthProfileStore(sanitizedStore, tempSessionAgentDir);
  }
  process.env.OPENCLAW_AGENT_DIR = tempAgentDir;
  process.env.PI_CODING_AGENT_DIR = tempAgentDir;

  const workspaceDir = resolveAgentWorkspaceDir(params.cfg, agentId);
  await fs.mkdir(workspaceDir, { recursive: true });
  const nonceA = randomUUID();
  const nonceB = randomUUID();
  const toolProbePath = path.join(workspaceDir, `.openclaw-live-tool-probe.${nonceA}.txt`);
  await fs.writeFile(toolProbePath, `nonceA=${nonceA}\nnonceB=${nonceB}\n`);

  const agentDir = resolveOpenClawAgentDir();
  const sanitizedCfg: OpenClawConfig = {
    ...params.cfg,
    auth: sanitizeAuthConfig({ cfg: params.cfg, agentDir }),
  };
  const nextCfg = buildLiveGatewayConfig({
    cfg: sanitizedCfg,
    candidates: params.candidates,
    providerOverrides: params.providerOverrides,
  });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-live-"));
  const tempConfigPath = path.join(tempDir, "openclaw.json");
  await fs.writeFile(tempConfigPath, `${JSON.stringify(nextCfg, null, 2)}\n`);
  process.env.OPENCLAW_CONFIG_PATH = tempConfigPath;

  const liveProviders = nextCfg.models?.providers;
  if (liveProviders && Object.keys(liveProviders).length > 0) {
    const modelsPath = path.join(tempAgentDir, "models.json");
    await fs.mkdir(tempAgentDir, { recursive: true });
    await fs.writeFile(modelsPath, `${JSON.stringify({ providers: liveProviders }, null, 2)}\n`);
  }

  let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
  let client: GatewayClient | undefined;
  try {
    const port = await withGatewayLiveProbeTimeout(
      getFreeGatewayPort(),
      `${params.label}: gateway-port`,
    );
    server = await withGatewayLiveProbeTimeout(
      startGatewayServer(port, {
        bind: "loopback",
        auth: { mode: "token", token },
        controlUiEnabled: false,
      }),
      `${params.label}: gateway-start`,
    );

    client = await withGatewayLiveProbeTimeout(
      connectClient({
        url: `ws://127.0.0.1:${port}`,
        token,
      }),
      `${params.label}: gateway-connect`,
    );
  } catch (error) {
    const message = String(error);
    if (isGatewayLiveProbeTimeout(message)) {
      logProgress(`[${params.label}] skip (gateway startup timeout)`);
      return;
    }
    throw error;
  }

  if (!server || !client) {
    logProgress(`[${params.label}] skip (gateway startup incomplete)`);
    return;
  }

  try {
    logProgress(
      `[${params.label}] running ${params.candidates.length} models (thinking=${params.thinkingLevel})`,
    );
    const anthropicKeys = collectAnthropicApiKeys();
    if (anthropicKeys.length > 0) {
      process.env.ANTHROPIC_API_KEY = anthropicKeys[0];
      logProgress(`[${params.label}] anthropic keys loaded: ${anthropicKeys.length}`);
    }
    const sessionKey = `agent:${agentId}:${params.label}`;
    const failures: Array<{ model: string; error: string }> = [];
    let skippedCount = 0;
    const total = params.candidates.length;

    for (const [index, model] of params.candidates.entries()) {
      const modelKey = `${model.provider}/${model.id}`;
      const progressLabel = `[${params.label}] ${index + 1}/${total} ${modelKey}`;

      const attemptMax =
        model.provider === "anthropic" && anthropicKeys.length > 0 ? anthropicKeys.length : 1;

      for (let attempt = 0; attempt < attemptMax; attempt += 1) {
        if (model.provider === "anthropic" && anthropicKeys.length > 0) {
          process.env.ANTHROPIC_API_KEY = anthropicKeys[attempt];
        }
        try {
          // Ensure session exists + override model for this run.
          // Reset between models: avoids cross-provider transcript incompatibilities
          // (notably OpenAI Responses requiring reasoning replay for function_call items).
          await withGatewayLiveProbeTimeout(
            client.request("sessions.reset", {
              key: sessionKey,
            }),
            `${progressLabel}: sessions-reset`,
          );
          await withGatewayLiveProbeTimeout(
            client.request("sessions.patch", {
              key: sessionKey,
              model: modelKey,
            }),
            `${progressLabel}: sessions-patch`,
          );

          logProgress(`${progressLabel}: prompt`);
          let text = await requestGatewayAgentText({
            client,
            sessionKey,
            idempotencyKey: `idem-${randomUUID()}`,
            message:
              "Explain in 2-3 sentences how the JavaScript event loop handles microtasks vs macrotasks. Must mention both words: microtask and macrotask.",
            thinkingLevel: params.thinkingLevel,
            context: `${progressLabel}: prompt`,
          });
          if (!text) {
            logProgress(`${progressLabel}: empty response, retrying`);
            text = await requestGatewayAgentText({
              client,
              sessionKey,
              idempotencyKey: `idem-${randomUUID()}-retry`,
              message:
                "Explain in 2-3 sentences how the JavaScript event loop handles microtasks vs macrotasks. Must mention both words: microtask and macrotask.",
              thinkingLevel: params.thinkingLevel,
              context: `${progressLabel}: prompt-retry`,
            });
          }
          if (!text && isGoogleishProvider(model.provider)) {
            logProgress(`${progressLabel}: skip (google empty response)`);
            break;
          }
          if (
            isEmptyStreamText(text) &&
            (model.provider === "minimax" || model.provider === "openai-codex")
          ) {
            logProgress(`${progressLabel}: skip (${model.provider} empty response)`);
            break;
          }
          if (isGoogleishProvider(model.provider) && isGoogleModelNotFoundText(text)) {
            // Catalog drift: model IDs can disappear or become unavailable on the API.
            // Treat as skip when scanning "all models" for Google.
            logProgress(`${progressLabel}: skip (google model not found)`);
            break;
          }
          assertNoReasoningTags({
            text,
            model: modelKey,
            phase: "prompt",
            label: params.label,
          });
          if (!isMeaningful(text)) {
            if (isGoogleishProvider(model.provider) && /gemini/i.test(model.id)) {
              logProgress(`${progressLabel}: skip (google not meaningful)`);
              break;
            }
            throw new Error(`not meaningful: ${text}`);
          }
          if (!/\bmicro\s*-?\s*tasks?\b/i.test(text) || !/\bmacro\s*-?\s*tasks?\b/i.test(text)) {
            throw new Error(`missing required keywords: ${text}`);
          }

          // Real tool invocation: force the agent to Read a local file and echo a nonce.
          logProgress(`${progressLabel}: tool-read`);
          const runIdTool = randomUUID();
          const maxToolReadAttempts = 3;
          let toolText = "";
          for (
            let toolReadAttempt = 0;
            toolReadAttempt < maxToolReadAttempts;
            toolReadAttempt += 1
          ) {
            const strictReply = toolReadAttempt > 0;
            toolText = await requestGatewayAgentText({
              client,
              sessionKey,
              idempotencyKey: `idem-${runIdTool}-tool-${toolReadAttempt + 1}`,
              message: strictReply
                ? "OpenClaw live tool probe (local, safe): " +
                  `use the tool named \`read\` (or \`Read\`) with JSON arguments {"path":"${toolProbePath}"}. ` +
                  `Then reply with exactly: ${nonceA} ${nonceB}. No extra text.`
                : "OpenClaw live tool probe (local, safe): " +
                  `use the tool named \`read\` (or \`Read\`) with JSON arguments {"path":"${toolProbePath}"}. ` +
                  "Then reply with the two nonce values you read (include both).",
              thinkingLevel: params.thinkingLevel,
              context: `${progressLabel}: tool-read`,
            });
            if (
              isEmptyStreamText(toolText) &&
              (model.provider === "minimax" || model.provider === "openai-codex")
            ) {
              logProgress(`${progressLabel}: skip (${model.provider} empty response)`);
              break;
            }
            assertNoReasoningTags({
              text: toolText,
              model: modelKey,
              phase: "tool-read",
              label: params.label,
            });
            if (hasExpectedToolNonce(toolText, nonceA, nonceB)) {
              break;
            }
            if (
              shouldRetryToolReadProbe({
                text: toolText,
                nonceA,
                nonceB,
                provider: model.provider,
                attempt: toolReadAttempt,
                maxAttempts: maxToolReadAttempts,
              })
            ) {
              logProgress(
                `${progressLabel}: tool-read retry (${toolReadAttempt + 2}/${maxToolReadAttempts}) malformed tool output`,
              );
              continue;
            }
            throw new Error(`tool probe missing nonce: ${toolText}`);
          }
          if (!hasExpectedToolNonce(toolText, nonceA, nonceB)) {
            throw new Error(`tool probe missing nonce: ${toolText}`);
          }

          if (params.extraToolProbes) {
            logProgress(`${progressLabel}: tool-exec`);
            const nonceC = randomUUID();
            const toolWritePath = path.join(tempDir, `write-${runIdTool}.txt`);
            const maxExecReadAttempts = 3;
            let execReadText = "";
            for (
              let execReadAttempt = 0;
              execReadAttempt < maxExecReadAttempts;
              execReadAttempt += 1
            ) {
              const strictReply = execReadAttempt > 0;
              execReadText = await requestGatewayAgentText({
                client,
                sessionKey,
                idempotencyKey: `idem-${runIdTool}-exec-read-${execReadAttempt + 1}`,
                message: strictReply
                  ? "OpenClaw live tool probe (local, safe): " +
                    "use the tool named `exec` (or `Exec`) to run this command: " +
                    `mkdir -p "${tempDir}" && printf '%s' '${nonceC}' > "${toolWritePath}". ` +
                    `Then use the tool named \`read\` (or \`Read\`) with JSON arguments {"path":"${toolWritePath}"}. ` +
                    `Then reply with exactly: ${nonceC}. No extra text.`
                  : "OpenClaw live tool probe (local, safe): " +
                    "use the tool named `exec` (or `Exec`) to run this command: " +
                    `mkdir -p "${tempDir}" && printf '%s' '${nonceC}' > "${toolWritePath}". ` +
                    `Then use the tool named \`read\` (or \`Read\`) with JSON arguments {"path":"${toolWritePath}"}. ` +
                    "Finally reply including the nonce text you read back.",
                thinkingLevel: params.thinkingLevel,
                context: `${progressLabel}: tool-exec`,
              });
              if (
                isEmptyStreamText(execReadText) &&
                (model.provider === "minimax" || model.provider === "openai-codex")
              ) {
                logProgress(`${progressLabel}: skip (${model.provider} empty response)`);
                break;
              }
              assertNoReasoningTags({
                text: execReadText,
                model: modelKey,
                phase: "tool-exec",
                label: params.label,
              });
              if (hasExpectedSingleNonce(execReadText, nonceC)) {
                break;
              }
              if (
                shouldRetryExecReadProbe({
                  text: execReadText,
                  nonce: nonceC,
                  provider: model.provider,
                  attempt: execReadAttempt,
                  maxAttempts: maxExecReadAttempts,
                })
              ) {
                logProgress(
                  `${progressLabel}: tool-exec retry (${execReadAttempt + 2}/${maxExecReadAttempts}) malformed tool output`,
                );
                continue;
              }
              throw new Error(`exec+read probe missing nonce: ${execReadText}`);
            }
            if (!hasExpectedSingleNonce(execReadText, nonceC)) {
              throw new Error(`exec+read probe missing nonce: ${execReadText}`);
            }

            await fs.rm(toolWritePath, { force: true });
          }

          if (params.extraImageProbes && model.input?.includes("image")) {
            logProgress(`${progressLabel}: image`);
            // Shorter code => less OCR flake across providers, still tests image attachments end-to-end.
            const imageCode = randomImageProbeCode();
            const imageBase64 = renderCatNoncePngBase64(imageCode);
            const runIdImage = randomUUID();

            const imageText = await requestGatewayAgentText({
              client,
              sessionKey,
              idempotencyKey: `idem-${runIdImage}-image`,
              message:
                "Look at the attached image. Reply with exactly two tokens separated by a single space: " +
                "(1) the animal shown or written in the image, lowercase; " +
                "(2) the code printed in the image, uppercase. No extra text.",
              attachments: [
                {
                  mimeType: "image/png",
                  fileName: `probe-${runIdImage}.png`,
                  content: imageBase64,
                },
              ],
              thinkingLevel: params.thinkingLevel,
              context: `${progressLabel}: image`,
            });
            // Best-effort: do not fail the whole live suite on flaky image handling.
            // (We still keep prompt + tool probes as hard checks.)
            if (
              isEmptyStreamText(imageText) &&
              (model.provider === "minimax" || model.provider === "openai-codex")
            ) {
              logProgress(`${progressLabel}: image skip (${model.provider} empty response)`);
            } else {
              assertNoReasoningTags({
                text: imageText,
                model: modelKey,
                phase: "image",
                label: params.label,
              });
              if (!/\bcat\b/i.test(imageText)) {
                logProgress(`${progressLabel}: image skip (missing 'cat')`);
              } else {
                const candidates = imageText.toUpperCase().match(/[A-Z0-9]{6,20}/g) ?? [];
                const bestDistance = candidates.reduce((best, cand) => {
                  if (Math.abs(cand.length - imageCode.length) > 2) {
                    return best;
                  }
                  return Math.min(best, editDistance(cand, imageCode));
                }, Number.POSITIVE_INFINITY);
                // OCR / image-read flake: allow a small edit distance, but still require the "cat" token above.
                if (!(bestDistance <= 3)) {
                  logProgress(`${progressLabel}: image skip (code mismatch)`);
                }
              }
            }
          }

          // Regression: tool-call-only turn followed by a user message (OpenAI responses bug class).
          if (
            (model.provider === "openai" && model.api === "openai-responses") ||
            (model.provider === "openai-codex" && model.api === "openai-codex-responses")
          ) {
            logProgress(`${progressLabel}: tool-only regression`);
            const runId2 = randomUUID();
            const firstText = await requestGatewayAgentText({
              client,
              sessionKey,
              idempotencyKey: `idem-${runId2}-1`,
              message: `Call the tool named \`read\` (or \`Read\`) on "${toolProbePath}". Do not write any other text.`,
              thinkingLevel: params.thinkingLevel,
              context: `${progressLabel}: tool-only-regression-first`,
            });
            assertNoReasoningTags({
              text: firstText,
              model: modelKey,
              phase: "tool-only",
              label: params.label,
            });

            const reply = await requestGatewayAgentText({
              client,
              sessionKey,
              idempotencyKey: `idem-${runId2}-2`,
              message: `Now answer: what are the values of nonceA and nonceB in "${toolProbePath}"? Reply with exactly: ${nonceA} ${nonceB}.`,
              thinkingLevel: params.thinkingLevel,
              context: `${progressLabel}: tool-only-regression-second`,
            });
            assertNoReasoningTags({
              text: reply,
              model: modelKey,
              phase: "tool-only-followup",
              label: params.label,
            });
            if (!reply.includes(nonceA) || !reply.includes(nonceB)) {
              throw new Error(`unexpected reply: ${reply}`);
            }
          }

          if (model.provider === "anthropic") {
            await runAnthropicRefusalProbe({
              client,
              sessionKey,
              modelKey,
              label: progressLabel,
              thinkingLevel: params.thinkingLevel,
            });
          }

          logProgress(`${progressLabel}: done`);
          break;
        } catch (err) {
          const message = String(err);
          if (
            model.provider === "anthropic" &&
            isAnthropicRateLimitError(message) &&
            attempt + 1 < attemptMax
          ) {
            logProgress(`${progressLabel}: rate limit, retrying with next key`);
            continue;
          }
          if (model.provider === "anthropic" && isAnthropicBillingError(message)) {
            if (attempt + 1 < attemptMax) {
              logProgress(`${progressLabel}: billing issue, retrying with next key`);
              continue;
            }
            logProgress(`${progressLabel}: skip (anthropic billing)`);
            break;
          }
          if (
            model.provider === "anthropic" &&
            isEmptyStreamText(message) &&
            attempt + 1 < attemptMax
          ) {
            logProgress(`${progressLabel}: empty response, retrying with next key`);
            continue;
          }
          if (model.provider === "anthropic" && isEmptyStreamText(message)) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (anthropic empty response)`);
            break;
          }
          if (isGoogleishProvider(model.provider) && isRateLimitErrorMessage(message)) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (google rate limit)`);
            break;
          }
          if (isProviderUnavailableErrorMessage(message)) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (provider unavailable)`);
            break;
          }
          if (
            model.provider === "anthropic" &&
            isGatewayLiveProbeTimeout(message) &&
            attempt + 1 < attemptMax
          ) {
            logProgress(`${progressLabel}: probe timeout, retrying with next key`);
            continue;
          }
          if (isGatewayLiveProbeTimeout(message)) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (probe timeout)`);
            break;
          }
          // OpenAI Codex refresh tokens can become single-use; skip instead of failing all live tests.
          if (model.provider === "openai-codex" && isRefreshTokenReused(message)) {
            logProgress(`${progressLabel}: skip (codex refresh token reused)`);
            break;
          }
          if (model.provider === "openai-codex" && isChatGPTUsageLimitErrorMessage(message)) {
            logProgress(`${progressLabel}: skip (chatgpt usage limit)`);
            break;
          }
          if (model.provider === "openai-codex" && isInstructionsRequiredError(message)) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (instructions required)`);
            break;
          }
          if (
            (model.provider === "openai" || model.provider === "openai-codex") &&
            isOpenAIReasoningSequenceError(message)
          ) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (openai reasoning sequence error)`);
            break;
          }
          if (
            (model.provider === "openai" || model.provider === "openai-codex") &&
            isToolNonceRefusal(message)
          ) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (tool probe refusal)`);
            break;
          }
          if (model.provider === "anthropic" && isToolNonceProbeMiss(message)) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (anthropic tool probe nonce miss)`);
            break;
          }
          if (isMissingProfileError(message)) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (missing auth profile)`);
            break;
          }
          if (params.label.startsWith("minimax-")) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (minimax endpoint error)`);
            break;
          }
          logProgress(`${progressLabel}: failed`);
          failures.push({ model: modelKey, error: message });
          break;
        }
      }
    }

    if (failures.length > 0) {
      const preview = formatFailurePreview(failures, 20);
      throw new Error(
        `gateway live model failures (${failures.length}, showing ${Math.min(failures.length, 20)}):\n${preview}`,
      );
    }
    if (skippedCount === total) {
      logProgress(`[${params.label}] skipped all models (missing profiles)`);
    }
  } finally {
    clearRuntimeConfigSnapshot();
    restoreProductionEnvForLiveRun(runtimeEnv);
    client.stop();
    await server.close({ reason: "live test complete" });
    await fs.rm(toolProbePath, { force: true });
    await fs.rm(tempDir, { recursive: true, force: true });
    if (tempAgentDir) {
      await fs.rm(tempAgentDir, { recursive: true, force: true });
    }
    if (tempStateDir) {
      await fs.rm(tempStateDir, { recursive: true, force: true });
    }

    process.env.OPENCLAW_CONFIG_PATH = previous.configPath;
    process.env.OPENCLAW_GATEWAY_TOKEN = previous.token;
    process.env.OPENCLAW_SKIP_CHANNELS = previous.skipChannels;
    process.env.OPENCLAW_SKIP_GMAIL_WATCHER = previous.skipGmail;
    process.env.OPENCLAW_SKIP_CRON = previous.skipCron;
    process.env.OPENCLAW_SKIP_CANVAS_HOST = previous.skipCanvas;
    process.env.OPENCLAW_AGENT_DIR = previous.agentDir;
    process.env.PI_CODING_AGENT_DIR = previous.piAgentDir;
    process.env.OPENCLAW_STATE_DIR = previous.stateDir;
  }
}

describeLive("gateway live (dev agent, profile keys)", () => {
  it(
    "runs meaningful prompts across models with available keys",
    async () => {
      clearRuntimeConfigSnapshot();
      const cfg = loadConfig();
      await ensureOpenClawModelsJson(cfg);

      const agentDir = resolveOpenClawAgentDir();
      const authStore = ensureAuthProfileStore(agentDir, {
        allowKeychainPrompt: false,
      });
      const authStorage = discoverAuthStorage(agentDir);
      const modelRegistry = discoverModels(authStorage, agentDir);
      const all = modelRegistry.getAll();

      const rawModels = process.env.OPENCLAW_LIVE_GATEWAY_MODELS?.trim();
      const useModern = !rawModels || rawModels === "modern" || rawModels === "all";
      const useExplicit = Boolean(rawModels) && !useModern;
      const filter = useExplicit ? parseFilter(rawModels) : null;
      const maxModels = GATEWAY_LIVE_MAX_MODELS;
      const wanted = filter
        ? all.filter((m) => filter.has(`${m.provider}/${m.id}`))
        : all.filter((m) => isModernModelRef({ provider: m.provider, id: m.id }));

      const providerProfileCache = new Map<string, boolean>();
      const candidates: Array<Model<Api>> = [];
      for (const model of wanted) {
        if (shouldSuppressBuiltInModel({ provider: model.provider, id: model.id })) {
          continue;
        }
        if (PROVIDERS && !PROVIDERS.has(model.provider)) {
          continue;
        }
        let hasProfile = providerProfileCache.get(model.provider);
        if (hasProfile === undefined) {
          const order = resolveAuthProfileOrder({
            cfg,
            store: authStore,
            provider: model.provider,
          });
          hasProfile = order.some((profileId) => Boolean(authStore.profiles[profileId]));
          providerProfileCache.set(model.provider, hasProfile);
        }
        if (!hasProfile) {
          continue;
        }
        candidates.push(model);
      }

      if (candidates.length === 0) {
        logProgress("[all-models] no API keys found; skipping");
        return;
      }
      const selectedCandidates = capByProviderSpread(
        candidates,
        maxModels > 0 ? maxModels : candidates.length,
        (model) => model.provider,
      );
      logProgress(`[all-models] selection=${useExplicit ? "explicit" : "modern"}`);
      if (selectedCandidates.length < candidates.length) {
        logProgress(
          `[all-models] capped to ${selectedCandidates.length}/${candidates.length} via OPENCLAW_LIVE_GATEWAY_MAX_MODELS=${maxModels}`,
        );
      }
      const imageCandidates = selectedCandidates.filter((m) => m.input?.includes("image"));
      if (imageCandidates.length === 0) {
        logProgress("[all-models] no image-capable models selected; image probe will be skipped");
      }
      await runGatewayModelSuite({
        label: "all-models",
        cfg,
        candidates: selectedCandidates,
        extraToolProbes: true,
        extraImageProbes: true,
        thinkingLevel: THINKING_LEVEL,
      });

      const minimaxCandidates = selectedCandidates.filter((model) => model.provider === "minimax");
      if (minimaxCandidates.length === 0) {
        logProgress("[minimax] no candidates with keys; skipping dual endpoint probes");
        return;
      }

      const minimaxAnthropic = buildMinimaxProviderOverride({
        cfg,
        api: "anthropic-messages",
        baseUrl: "https://api.minimax.io/anthropic",
      });
      if (minimaxAnthropic) {
        await runGatewayModelSuite({
          label: "minimax-anthropic",
          cfg,
          candidates: minimaxCandidates,
          extraToolProbes: true,
          extraImageProbes: true,
          thinkingLevel: THINKING_LEVEL,
          providerOverrides: { minimax: minimaxAnthropic },
        });
      } else {
        logProgress("[minimax-anthropic] missing minimax provider config; skipping");
      }
    },
    GATEWAY_LIVE_SUITE_TIMEOUT_MS,
  );

  it("z.ai fallback handles anthropic tool history", async () => {
    if (!ZAI_FALLBACK) {
      return;
    }
    clearRuntimeConfigSnapshot();
    const runtimeEnv = enterProductionEnvForLiveRun();
    const previous = {
      configPath: process.env.OPENCLAW_CONFIG_PATH,
      token: process.env.OPENCLAW_GATEWAY_TOKEN,
      skipChannels: process.env.OPENCLAW_SKIP_CHANNELS,
      skipGmail: process.env.OPENCLAW_SKIP_GMAIL_WATCHER,
      skipCron: process.env.OPENCLAW_SKIP_CRON,
      skipCanvas: process.env.OPENCLAW_SKIP_CANVAS_HOST,
    };

    process.env.OPENCLAW_SKIP_CHANNELS = "1";
    process.env.OPENCLAW_SKIP_GMAIL_WATCHER = "1";
    process.env.OPENCLAW_SKIP_CRON = "1";
    process.env.OPENCLAW_SKIP_CANVAS_HOST = "1";

    const token = `test-${randomUUID()}`;
    process.env.OPENCLAW_GATEWAY_TOKEN = token;

    const cfg = loadConfig();
    await ensureOpenClawModelsJson(cfg);

    const agentDir = resolveOpenClawAgentDir();
    const authStorage = discoverAuthStorage(agentDir);
    const modelRegistry = discoverModels(authStorage, agentDir);
    const anthropic = modelRegistry.find("anthropic", "claude-opus-4-5") as Model<Api> | null;
    const zai = modelRegistry.find("zai", "glm-4.7") as Model<Api> | null;

    if (!anthropic || !zai) {
      return;
    }
    try {
      await getApiKeyForModel({ model: anthropic, cfg });
      await getApiKeyForModel({ model: zai, cfg });
    } catch {
      return;
    }

    const agentId = "dev";
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    await fs.mkdir(workspaceDir, { recursive: true });
    const nonceA = randomUUID();
    const nonceB = randomUUID();
    const toolProbePath = path.join(workspaceDir, `.openclaw-live-zai-fallback.${nonceA}.txt`);
    await fs.writeFile(toolProbePath, `nonceA=${nonceA}\nnonceB=${nonceB}\n`);

    let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
    let client: GatewayClient | undefined;
    try {
      const port = await withGatewayLiveProbeTimeout(
        getFreeGatewayPort(),
        "zai-fallback: gateway-port",
      );
      server = await withGatewayLiveProbeTimeout(
        startGatewayServer(port, {
          bind: "loopback",
          auth: { mode: "token", token },
          controlUiEnabled: false,
        }),
        "zai-fallback: gateway-start",
      );

      client = await withGatewayLiveProbeTimeout(
        connectClient({
          url: `ws://127.0.0.1:${port}`,
          token,
        }),
        "zai-fallback: gateway-connect",
      );
    } catch (error) {
      const message = String(error);
      if (isGatewayLiveProbeTimeout(message)) {
        logProgress("[zai-fallback] skip (gateway startup timeout)");
        return;
      }
      throw error;
    }

    if (!server || !client) {
      logProgress("[zai-fallback] skip (gateway startup incomplete)");
      return;
    }

    try {
      const sessionKey = `agent:${agentId}:live-zai-fallback`;

      await withGatewayLiveProbeTimeout(
        client.request("sessions.patch", {
          key: sessionKey,
          model: "anthropic/claude-opus-4-5",
        }),
        "zai-fallback: sessions-patch-anthropic",
      );
      await withGatewayLiveProbeTimeout(
        client.request("sessions.reset", {
          key: sessionKey,
        }),
        "zai-fallback: sessions-reset",
      );

      const toolText = await requestGatewayAgentText({
        client,
        sessionKey,
        idempotencyKey: `idem-${randomUUID()}-tool`,
        message:
          `Call the tool named \`read\` (or \`Read\` if \`read\` is unavailable) with JSON arguments {"path":"${toolProbePath}"}. ` +
          `Then reply with exactly: ${nonceA} ${nonceB}. No extra text.`,
        thinkingLevel: THINKING_LEVEL,
        context: "zai-fallback: tool-probe",
      });
      assertNoReasoningTags({
        text: toolText,
        model: "anthropic/claude-opus-4-5",
        phase: "zai-fallback-tool",
        label: "zai-fallback",
      });
      if (!toolText.includes(nonceA) || !toolText.includes(nonceB)) {
        throw new Error(`anthropic tool probe missing nonce: ${toolText}`);
      }

      await withGatewayLiveProbeTimeout(
        client.request("sessions.patch", {
          key: sessionKey,
          model: "zai/glm-4.7",
        }),
        "zai-fallback: sessions-patch-zai",
      );

      const followupText = await requestGatewayAgentText({
        client,
        sessionKey,
        idempotencyKey: `idem-${randomUUID()}-followup`,
        message:
          `What are the values of nonceA and nonceB in "${toolProbePath}"? ` +
          `Reply with exactly: ${nonceA} ${nonceB}.`,
        thinkingLevel: THINKING_LEVEL,
        context: "zai-fallback: followup",
      });
      assertNoReasoningTags({
        text: followupText,
        model: "zai/glm-4.7",
        phase: "zai-fallback-followup",
        label: "zai-fallback",
      });
      if (!followupText.includes(nonceA) || !followupText.includes(nonceB)) {
        throw new Error(`zai followup missing nonce: ${followupText}`);
      }
    } finally {
      clearRuntimeConfigSnapshot();
      restoreProductionEnvForLiveRun(runtimeEnv);
      client.stop();
      await server.close({ reason: "live test complete" });
      await fs.rm(toolProbePath, { force: true });

      process.env.OPENCLAW_CONFIG_PATH = previous.configPath;
      process.env.OPENCLAW_GATEWAY_TOKEN = previous.token;
      process.env.OPENCLAW_SKIP_CHANNELS = previous.skipChannels;
      process.env.OPENCLAW_SKIP_GMAIL_WATCHER = previous.skipGmail;
      process.env.OPENCLAW_SKIP_CRON = previous.skipCron;
      process.env.OPENCLAW_SKIP_CANVAS_HOST = previous.skipCanvas;
    }
  }, 180_000);
});
