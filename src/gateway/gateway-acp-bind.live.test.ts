import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getAcpRuntimeBackend } from "../acp/runtime/registry.js";
import { isLiveTestEnabled } from "../agents/live-test-helpers.js";
import { clearRuntimeConfigSnapshot, loadConfig } from "../config/config.js";
import { isTruthyEnvValue } from "../infra/env.js";
import {
  pinActivePluginChannelRegistry,
  releasePinnedPluginChannelRegistry,
} from "../plugins/runtime.js";
import { extractFirstTextBlock } from "../shared/chat-message-content.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { sleep } from "../utils.js";
import { GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { GatewayClient } from "./client.js";
import { startGatewayServer } from "./server.js";

const LIVE = isLiveTestEnabled();
const ACP_BIND_LIVE = isTruthyEnvValue(process.env.OPENCLAW_LIVE_ACP_BIND);
const describeLive = LIVE && ACP_BIND_LIVE ? describe : describe.skip;

const CONNECT_TIMEOUT_MS = 90_000;
const LIVE_TIMEOUT_MS = 240_000;
type LiveAcpAgent = "claude" | "codex" | "gemini";

function createSlackCurrentConversationBindingRegistry() {
  return createTestRegistry([
    {
      pluginId: "slack",
      source: "test",
      plugin: {
        id: "slack",
        meta: { aliases: [] },
        conversationBindings: {
          supportsCurrentConversationBinding: true,
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
  return "claude";
}

function extractAssistantTexts(messages: unknown[]): string[] {
  return messages
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return undefined;
      }
      const role = (entry as { role?: unknown }).role;
      if (role !== "assistant") {
        return undefined;
      }
      return extractFirstTextBlock(entry);
    })
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function createAcpRecallPrompt(liveAgent: LiveAcpAgent): string {
  if (liveAgent !== "claude") {
    return "Please include the exact token from your immediately previous assistant reply.";
  }
  return "Reply with exactly the token from your immediately previous assistant reply and nothing else.";
}

function createAcpMarkerPrompt(liveAgent: LiveAcpAgent, memoryNonce: string): string {
  const token = `ACP-BIND-MEMORY-${memoryNonce}`;
  if (liveAgent !== "claude") {
    return `Please include the exact token ${token} in your reply.`;
  }
  return `Reply with exactly this token and nothing else: ${token}`;
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

async function connectClient(params: { url: string; token: string; timeoutMs?: number }) {
  const timeoutMs = params.timeoutMs ?? CONNECT_TIMEOUT_MS;
  const startedAt = Date.now();
  let attempt = 0;
  let lastError: Error | null = null;

  while (Date.now() - startedAt < timeoutMs) {
    attempt += 1;
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      break;
    }
    try {
      return await connectClientOnce({
        ...params,
        timeoutMs: Math.min(remainingMs, 35_000),
      });
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (!isRetryableGatewayConnectError(lastError) || remainingMs <= 5_000) {
        throw lastError;
      }
      logLiveStep(`gateway connect warmup retry ${attempt}: ${lastError.message}`);
      await sleep(Math.min(1_000 * attempt, 5_000));
    }
  }

  throw lastError ?? new Error("gateway connect timeout");
}

async function connectClientOnce(params: { url: string; token: string; timeoutMs?: number }) {
  const timeoutMs = params.timeoutMs ?? CONNECT_TIMEOUT_MS;
  return await new Promise<GatewayClient>((resolve, reject) => {
    let done = false;
    let client: GatewayClient | undefined;
    const finish = (result: { client?: GatewayClient; error?: Error }) => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(connectTimeout);
      if (result.error) {
        if (client) {
          void client.stopAndWait({ timeoutMs: 1_000 }).catch(() => {});
        }
        reject(result.error);
        return;
      }
      resolve(result.client as GatewayClient);
    };

    client = new GatewayClient({
      url: params.url,
      token: params.token,
      clientName: GATEWAY_CLIENT_NAMES.TEST,
      clientVersion: "dev",
      mode: "test",
      requestTimeoutMs: timeoutMs,
      connectChallengeTimeoutMs: timeoutMs,
      onHelloOk: () => finish({ client }),
      onConnectError: (error) => finish({ error }),
      onClose: (code, reason) =>
        finish({ error: new Error(`gateway closed during connect (${code}): ${reason}`) }),
    });

    const connectTimeout = setTimeout(
      () => finish({ error: new Error("gateway connect timeout") }),
      timeoutMs,
    );
    connectTimeout.unref();
    client.start();
  });
}

function isRetryableGatewayConnectError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes("gateway closed during connect (1000)") ||
    message.includes("gateway connect timeout") ||
    message.includes("gateway connect challenge timeout")
  );
}

function isRetryableAcpBindWarmupText(texts: string[]): boolean {
  const combined = texts.join("\n\n").toLowerCase();
  return (
    combined.includes("acp runtime backend is currently unavailable") ||
    combined.includes("try again in a moment") ||
    combined.includes("acp runtime backend is not configured") ||
    combined.includes("acp dispatch is disabled")
  );
}

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
  timeoutMs?: number;
}): Promise<{ mainAssistantTexts: string[]; spawnedSessionKey: string }> {
  const timeoutMs = params.timeoutMs ?? 90_000;
  const startedAt = Date.now();
  let attempt = 0;

  while (Date.now() - startedAt < timeoutMs) {
    attempt += 1;
    const backend = getAcpRuntimeBackend("acpx");
    const runtime = backend?.runtime as { probeAvailability?: () => Promise<void> } | undefined;
    if (runtime?.probeAvailability) {
      await runtime.probeAvailability().catch(() => {});
    }
    if (!(backend?.healthy?.() ?? false)) {
      logLiveStep(`acpx backend still unhealthy before bind attempt ${attempt}`);
      await sleep(5_000);
      continue;
    }

    await sendChatAndWait({
      client: params.client,
      sessionKey: params.sessionKey,
      idempotencyKey: `idem-bind-${randomUUID()}`,
      message: `/acp spawn ${params.liveAgent} --bind here`,
      originatingChannel: params.originatingChannel,
      originatingTo: params.originatingTo,
      originatingAccountId: params.originatingAccountId,
    });

    const mainHistory = await params.client.request<{ messages?: unknown[] }>("chat.history", {
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
  const result = await client.request<{ status?: string }>(
    "agent.wait",
    {
      runId,
      timeoutMs,
    },
    {
      timeoutMs: timeoutMs + 5_000,
    },
  );
  if (result?.status !== "ok") {
    throw new Error(`agent.wait failed for ${runId}: status=${String(result?.status)}`);
  }
}

async function sendChatAndWait(params: {
  client: GatewayClient;
  sessionKey: string;
  idempotencyKey: string;
  message: string;
  originatingChannel: string;
  originatingTo: string;
  originatingAccountId: string;
}) {
  const started = await params.client.request<{ runId?: string; status?: string }>("chat.send", {
    sessionKey: params.sessionKey,
    message: params.message,
    idempotencyKey: params.idempotencyKey,
    originatingChannel: params.originatingChannel,
    originatingTo: params.originatingTo,
    originatingAccountId: params.originatingAccountId,
  });
  if (started?.status !== "started" || typeof started.runId !== "string") {
    throw new Error(`chat.send did not start correctly: ${JSON.stringify(started)}`);
  }
  await waitForAgentRunOk(params.client, started.runId);
}

async function waitForAssistantText(params: {
  client: GatewayClient;
  sessionKey: string;
  contains: string;
  minAssistantCount?: number;
  timeoutMs?: number;
}): Promise<{ messages: unknown[]; lastAssistantText: string }> {
  const timeoutMs = params.timeoutMs ?? 30_000;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const history = await params.client.request<{ messages?: unknown[] }>("chat.history", {
      sessionKey: params.sessionKey,
      limit: 16,
    });
    const messages = history.messages ?? [];
    const assistantTexts = extractAssistantTexts(messages);
    const lastAssistantText = assistantTexts.at(-1) ?? null;
    if (
      assistantTexts.length >= (params.minAssistantCount ?? 1) &&
      lastAssistantText?.includes(params.contains)
    ) {
      return { messages, lastAssistantText };
    }
    await sleep(500);
  }

  const finalHistory = await params.client.request<{ messages?: unknown[] }>("chat.history", {
    sessionKey: params.sessionKey,
    limit: 16,
  });
  throw new Error(
    `timed out waiting for assistant text containing ${params.contains}: ${formatAssistantTextPreview(
      extractAssistantTexts(finalHistory.messages ?? []),
    )}`,
  );
}

describeLive("gateway live (ACP bind)", () => {
  it(
    "binds a synthetic Slack DM conversation to a live ACP session and reroutes the next turn",
    async () => {
      const previous = {
        configPath: process.env.OPENCLAW_CONFIG_PATH,
        stateDir: process.env.OPENCLAW_STATE_DIR,
        token: process.env.OPENCLAW_GATEWAY_TOKEN,
        port: process.env.OPENCLAW_GATEWAY_PORT,
        skipChannels: process.env.OPENCLAW_SKIP_CHANNELS,
        skipGmail: process.env.OPENCLAW_SKIP_GMAIL_WATCHER,
        skipCron: process.env.OPENCLAW_SKIP_CRON,
        skipCanvas: process.env.OPENCLAW_SKIP_CANVAS_HOST,
      };
      const liveAgent = normalizeAcpAgent(process.env.OPENCLAW_LIVE_ACP_BIND_AGENT);
      const agentCommandOverride =
        process.env.OPENCLAW_LIVE_ACP_BIND_AGENT_COMMAND?.trim() || undefined;
      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-live-acp-bind-"));
      const tempStateDir = path.join(tempRoot, "state");
      const tempConfigPath = path.join(tempRoot, "openclaw.json");
      const port = await getFreeGatewayPort();
      const token = `test-${randomUUID()}`;
      const originalSessionKey = "main";
      const slackUserId = `U${randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
      const conversationId = `user:${slackUserId}`;
      const accountId = "default";
      const followupNonce = randomBytes(4).toString("hex").toUpperCase();
      const memoryNonce = randomBytes(4).toString("hex").toUpperCase();

      clearRuntimeConfigSnapshot();
      process.env.OPENCLAW_STATE_DIR = tempStateDir;
      process.env.OPENCLAW_SKIP_CHANNELS = "1";
      process.env.OPENCLAW_SKIP_GMAIL_WATCHER = "1";
      process.env.OPENCLAW_SKIP_CRON = "1";
      process.env.OPENCLAW_SKIP_CANVAS_HOST = "1";
      process.env.OPENCLAW_GATEWAY_TOKEN = token;
      process.env.OPENCLAW_GATEWAY_PORT = String(port);

      const cfg = loadConfig();
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
        },
        plugins: {
          ...cfg.plugins,
          entries: {
            ...cfg.plugins?.entries,
            acpx: {
              ...acpxEntry,
              enabled: true,
              config: {
                ...acpxEntry?.config,
                permissionMode: "approve-all",
                nonInteractivePermissions: "deny",
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
      };
      await fs.writeFile(tempConfigPath, `${JSON.stringify(nextCfg, null, 2)}\n`);
      process.env.OPENCLAW_CONFIG_PATH = tempConfigPath;

      logLiveStep(`starting gateway on port ${String(port)}`);
      const server = await startGatewayServer(port, {
        bind: "loopback",
        auth: { mode: "token", token },
        controlUiEnabled: false,
      });
      logLiveStep("gateway startup returned");
      await waitForGatewayPort({ host: "127.0.0.1", port, timeoutMs: CONNECT_TIMEOUT_MS });
      logLiveStep("gateway port is reachable");
      const client = await connectClient({
        url: `ws://127.0.0.1:${port}`,
        token,
        timeoutMs: CONNECT_TIMEOUT_MS,
      });
      logLiveStep("gateway websocket connected");
      const channelRegistry = createSlackCurrentConversationBindingRegistry();
      pinActivePluginChannelRegistry(channelRegistry);

      try {
        const { mainAssistantTexts, spawnedSessionKey } = await bindConversationAndWait({
          client,
          sessionKey: originalSessionKey,
          liveAgent,
          originatingChannel: "slack",
          originatingTo: conversationId,
          originatingAccountId: accountId,
        });
        logLiveStep("bind command completed");
        expect(mainAssistantTexts.join("\n\n")).toContain("Bound this conversation to");
        expect(spawnedSessionKey).toMatch(new RegExp(`^agent:${liveAgent}:acp:`));
        logLiveStep(`binding announced for session ${spawnedSessionKey ?? "missing"}`);

        await sendChatAndWait({
          client,
          sessionKey: originalSessionKey,
          idempotencyKey: `idem-followup-${randomUUID()}`,
          message: `Reply with exactly this token and nothing else: ACP-BIND-${followupNonce}`,
          originatingChannel: "slack",
          originatingTo: conversationId,
          originatingAccountId: accountId,
        });
        logLiveStep("follow-up turn completed");

        const firstBoundHistory = await waitForAssistantText({
          client,
          sessionKey: spawnedSessionKey,
          contains: `ACP-BIND-${followupNonce}`,
        });
        const firstAssistantCount = extractAssistantTexts(firstBoundHistory.messages).length;

        await sendChatAndWait({
          client,
          sessionKey: originalSessionKey,
          idempotencyKey: `idem-memory-${randomUUID()}`,
          message: createAcpRecallPrompt(liveAgent),
          originatingChannel: "slack",
          originatingTo: conversationId,
          originatingAccountId: accountId,
        });
        logLiveStep("memory recall turn completed");

        const recallHistory = await waitForAssistantText({
          client,
          sessionKey: spawnedSessionKey,
          contains: `ACP-BIND-${followupNonce}`,
          minAssistantCount: firstAssistantCount + 1,
        });
        const recallAssistantText = recallHistory.lastAssistantText;
        expect(recallAssistantText).toContain(`ACP-BIND-${followupNonce}`);
        logLiveStep("bound session transcript retained the previous token");
        const recallAssistantCount = extractAssistantTexts(recallHistory.messages).length;

        await sendChatAndWait({
          client,
          sessionKey: originalSessionKey,
          idempotencyKey: `idem-marker-${randomUUID()}`,
          message: createAcpMarkerPrompt(liveAgent, memoryNonce),
          originatingChannel: "slack",
          originatingTo: conversationId,
          originatingAccountId: accountId,
        });
        logLiveStep("memory marker turn completed");

        const boundHistory = await waitForAssistantText({
          client,
          sessionKey: spawnedSessionKey,
          contains: `ACP-BIND-MEMORY-${memoryNonce}`,
          minAssistantCount: recallAssistantCount + 1,
        });
        const assistantTexts = extractAssistantTexts(boundHistory.messages);
        const lastAssistantText = boundHistory.lastAssistantText;
        expect(assistantTexts.join("\n\n")).toContain(`ACP-BIND-${followupNonce}`);
        expect(lastAssistantText).toContain(`ACP-BIND-MEMORY-${memoryNonce}`);
        logLiveStep("bound session transcript contains the final marker token");
      } finally {
        releasePinnedPluginChannelRegistry(channelRegistry);
        clearRuntimeConfigSnapshot();
        await client.stopAndWait({ timeoutMs: 2_000 }).catch(() => {});
        await server.close();
        await fs.rm(tempRoot, { recursive: true, force: true });
        if (previous.configPath === undefined) {
          delete process.env.OPENCLAW_CONFIG_PATH;
        } else {
          process.env.OPENCLAW_CONFIG_PATH = previous.configPath;
        }
        if (previous.stateDir === undefined) {
          delete process.env.OPENCLAW_STATE_DIR;
        } else {
          process.env.OPENCLAW_STATE_DIR = previous.stateDir;
        }
        if (previous.token === undefined) {
          delete process.env.OPENCLAW_GATEWAY_TOKEN;
        } else {
          process.env.OPENCLAW_GATEWAY_TOKEN = previous.token;
        }
        if (previous.port === undefined) {
          delete process.env.OPENCLAW_GATEWAY_PORT;
        } else {
          process.env.OPENCLAW_GATEWAY_PORT = previous.port;
        }
        if (previous.skipChannels === undefined) {
          delete process.env.OPENCLAW_SKIP_CHANNELS;
        } else {
          process.env.OPENCLAW_SKIP_CHANNELS = previous.skipChannels;
        }
        if (previous.skipGmail === undefined) {
          delete process.env.OPENCLAW_SKIP_GMAIL_WATCHER;
        } else {
          process.env.OPENCLAW_SKIP_GMAIL_WATCHER = previous.skipGmail;
        }
        if (previous.skipCron === undefined) {
          delete process.env.OPENCLAW_SKIP_CRON;
        } else {
          process.env.OPENCLAW_SKIP_CRON = previous.skipCron;
        }
        if (previous.skipCanvas === undefined) {
          delete process.env.OPENCLAW_SKIP_CANVAS_HOST;
        } else {
          process.env.OPENCLAW_SKIP_CANVAS_HOST = previous.skipCanvas;
        }
      }
    },
    LIVE_TIMEOUT_MS + 180_000,
  );
});
