// Gateway trajectory export live tests verify Codex harness runs emit trajectory artifacts under live settings.
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EventFrame } from "../../packages/gateway-protocol/src/index.js";
import { isLiveTestEnabled } from "../agents/live-test-helpers.js";
import type { OpenClawConfig } from "../config/config.js";
import { extractFirstTextBlock } from "../shared/chat-message-content.js";
import { GatewayClient } from "./client.js";
import {
  connectTestGatewayClient,
  createBootstrapWorkspace,
  ensurePairedTestGatewayClientIdentity,
  getFreeGatewayPort,
} from "./gateway-cli-backend.live-helpers.js";
import { restoreLiveEnv, snapshotLiveEnv, type LiveEnvSnapshot } from "./live-env-test-helpers.js";
import { extractPayloadText } from "./test-helpers.agent-results.js";

const LIVE = isLiveTestEnabled();
const CODEX_HARNESS_LIVE = process.env.OPENCLAW_LIVE_CODEX_HARNESS === "1";
const CODEX_HARNESS_DEBUG = process.env.OPENCLAW_LIVE_CODEX_HARNESS_DEBUG === "1";
const CODEX_HARNESS_AUTH_MODE =
  process.env.OPENCLAW_LIVE_CODEX_HARNESS_AUTH === "api-key" ? "api-key" : "codex-auth";
const describeLive = LIVE && CODEX_HARNESS_LIVE ? describe : describe.skip;
const LIVE_TIMEOUT_MS = 420_000;
const GATEWAY_CONNECT_TIMEOUT_MS = 60_000;
const AGENT_REQUEST_TIMEOUT_MS = 180_000;
const DEFAULT_CODEX_MODEL = "openai/gpt-5.5";

function logLiveStep(step: string, details?: Record<string, unknown>): void {
  if (!CODEX_HARNESS_DEBUG) {
    return;
  }
  const suffix = details && Object.keys(details).length > 0 ? ` ${JSON.stringify(details)}` : "";
  console.error(`[gateway-trajectory-live] ${step}${suffix}`);
}

function snapshotEnv(): LiveEnvSnapshot {
  return snapshotLiveEnv(["OPENCLAW_TRAJECTORY", "OPENCLAW_TRAJECTORY_DIR"]);
}

function restoreEnv(snapshot: LiveEnvSnapshot): void {
  restoreLiveEnv(snapshot);
}

async function removeLiveTempDir(dir: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      const code = (error as { code?: unknown } | null)?.code;
      if (code !== "EBUSY" && code !== "ENOTEMPTY" && code !== "EPERM" && code !== "EACCES") {
        throw error;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
    }
  }
  await fs.rm(dir, { recursive: true, force: true });
  void lastError;
}

async function writeLiveGatewayConfig(params: {
  configPath: string;
  modelKey: string;
  port: number;
  token: string;
  workspace: string;
}): Promise<void> {
  const cfg: OpenClawConfig = {
    gateway: {
      mode: "local",
      port: params.port,
      auth: { mode: "token", token: params.token },
    },
    plugins: { allow: ["codex"] },
    agents: {
      list: [{ id: "dev", default: true }],
      defaults: {
        workspace: params.workspace,
        skipBootstrap: true,
        model: { primary: params.modelKey },
        models: { [params.modelKey]: { agentRuntime: { id: "codex" } } },
        sandbox: { mode: "off" },
      },
    },
  };
  await fs.writeFile(params.configPath, `${JSON.stringify(cfg, null, 2)}\n`);
}

async function connectGatewayClient(params: {
  onEvent?: (event: EventFrame) => void;
  url: string;
  token: string;
}): Promise<GatewayClient> {
  const deviceIdentity = await ensurePairedTestGatewayClientIdentity({
    displayName: "trajectory-live",
  });
  const client = await connectTestGatewayClient({
    url: params.url,
    token: params.token,
    deviceIdentity,
    timeoutMs: GATEWAY_CONNECT_TIMEOUT_MS,
    requestTimeoutMs: 60_000,
    tickWatchTimeoutMs: AGENT_REQUEST_TIMEOUT_MS + 120_000,
    clientDisplayName: "trajectory-live",
    onEvent: params.onEvent,
  });
  return client;
}

async function requestAgentExactReply(params: {
  client: GatewayClient;
  expectedToken: string;
  message: string;
  sessionKey: string;
}): Promise<string> {
  const payload = (await params.client.request(
    "agent",
    {
      sessionKey: params.sessionKey,
      idempotencyKey: `idem-${randomUUID()}`,
      message: params.message,
      deliver: false,
      thinking: "low",
    },
    { expectFinal: true, timeoutMs: AGENT_REQUEST_TIMEOUT_MS },
  )) as {
    status?: string;
    result?: unknown;
  };
  if (payload?.status !== "ok") {
    throw new Error(`agent request failed: ${JSON.stringify(payload)}`);
  }
  const text = extractPayloadText(payload.result);
  expect(text).toContain(params.expectedToken);
  return text;
}

async function listDirectoryNames(dirPath: string): Promise<string[]> {
  try {
    return await fs.readdir(dirPath);
  } catch {
    return [];
  }
}

async function waitForPath(filePath: string, timeoutMs = 60_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await fs.stat(filePath);
      return;
    } catch {
      await new Promise((resolve) => {
        setTimeout(resolve, 500);
      });
    }
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

async function waitForChatFinalText(params: {
  events: EventFrame[];
  runId: string;
  timeoutMs: number;
}): Promise<string> {
  const deadline = Date.now() + params.timeoutMs;
  while (Date.now() < deadline) {
    const text = params.events
      .map((event) => extractChatFinalText(event, params.runId))
      .find(Boolean);
    if (text) {
      return text;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  throw new Error(`timed out waiting for chat final for ${params.runId}`);
}

function extractChatFinalText(event: EventFrame, runId: string): string | undefined {
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

async function approveTrajectoryExport(client: GatewayClient): Promise<string> {
  const startedAt = Date.now();
  let approval:
    | {
        id?: string;
        request?: {
          command?: string;
        };
      }
    | undefined;
  while (Date.now() - startedAt < 60_000) {
    const approvals = (await client.request(
      "exec.approval.list",
      {},
      { timeoutMs: 10_000 },
    )) as Array<{
      id?: string;
      request?: {
        command?: string;
      };
    }>;
    approval = approvals.find((entry) =>
      entry.request?.command?.includes("sessions export-trajectory"),
    );
    if (approval) {
      break;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });
  }
  expect(typeof approval?.id).toBe("string");
  expect(approval?.request?.command).toContain("sessions export-trajectory");
  if (!approval?.id) {
    throw new Error("expected trajectory export approval id");
  }
  await client.request(
    "exec.approval.resolve",
    { id: approval.id, decision: "allow-once" },
    { timeoutMs: 10_000 },
  );
  return approval.id;
}

describeLive("gateway live trajectory export", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const step of cleanup.splice(0).toReversed()) {
      await step();
    }
  });

  it(
    "exports a combined runtime and transcript trajectory bundle through the live gateway",
    async () => {
      const { clearRuntimeConfigSnapshot } = await import("../config/config.js");
      const { startGatewayServer } = await import("./server.js");

      const previousEnv = snapshotEnv();
      const tempDir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-openclaw-trajectory-live-"));
      cleanup.push(async () => {
        restoreEnv(previousEnv);
        clearRuntimeConfigSnapshot();
        await removeLiveTempDir(tempDir);
      });

      const stateDir = path.join(tempDir, "state");
      const trajectoryDir = path.join(tempDir, "runtime-traces");
      const { workspaceDir } = await createBootstrapWorkspace(tempDir);
      const configPath = path.join(tempDir, "openclaw.json");
      const token = `test-${randomUUID()}`;
      const port = await getFreeGatewayPort();
      const modelKey = process.env.OPENCLAW_LIVE_CODEX_HARNESS_MODEL ?? DEFAULT_CODEX_MODEL;

      clearRuntimeConfigSnapshot();
      process.env.OPENCLAW_AGENT_RUNTIME = "codex";
      // API-key CI lanes intentionally pass OPENAI_API_KEY through to the Codex
      // app-server harness; only stored Codex-auth runs should clear OpenAI env.
      if (CODEX_HARNESS_AUTH_MODE !== "api-key") {
        delete process.env.OPENAI_BASE_URL;
        delete process.env.OPENAI_API_KEY;
      } else if (!process.env.OPENAI_BASE_URL?.trim()) {
        delete process.env.OPENAI_BASE_URL;
      }
      process.env.OPENCLAW_CONFIG_PATH = configPath;
      process.env.OPENCLAW_GATEWAY_TOKEN = token;
      process.env.OPENCLAW_SKIP_BROWSER_CONTROL_SERVER = "1";
      process.env.OPENCLAW_SKIP_CANVAS_HOST = "1";
      process.env.OPENCLAW_SKIP_CHANNELS = "1";
      process.env.OPENCLAW_SKIP_CRON = "1";
      process.env.OPENCLAW_SKIP_GMAIL_WATCHER = "1";
      process.env.OPENCLAW_STATE_DIR = stateDir;
      process.env.OPENCLAW_TRAJECTORY = "1";
      process.env.OPENCLAW_TRAJECTORY_DIR = trajectoryDir;

      await fs.mkdir(stateDir, { recursive: true });
      await fs.mkdir(trajectoryDir, { recursive: true });
      await writeLiveGatewayConfig({ configPath, modelKey, port, token, workspace: workspaceDir });
      logLiveStep("config-written", { configPath, modelKey, port, workspaceDir });

      const server = await startGatewayServer(port, {
        bind: "loopback",
        auth: { mode: "token", token },
        controlUiEnabled: false,
      });
      logLiveStep("gateway-started", { port });
      cleanup.push(async () => {
        await server.close();
      });

      const gatewayEvents: EventFrame[] = [];
      const client = await connectGatewayClient({
        url: `ws://127.0.0.1:${port}`,
        token,
        onEvent: (event) => {
          gatewayEvents.push(event);
        },
      });
      logLiveStep("client-connected");
      cleanup.push(async () => {
        await client.stopAndWait({ timeoutMs: 5_000 });
      });

      const sessionKey = "agent:dev:live-trajectory-export";
      const replyToken = `TRAJECTORY-LIVE-${randomBytes(3).toString("hex").toUpperCase()}`;
      logLiveStep("agent-turn:start", { sessionKey, replyToken });
      const firstReply = await requestAgentExactReply({
        client,
        sessionKey,
        expectedToken: replyToken,
        message: `Reply with exactly ${replyToken} and nothing else.`,
      });
      logLiveStep("agent-turn:done", { firstReply });
      expect(firstReply.trim()).toBe(replyToken);

      const trajectoryFiles = await listDirectoryNames(trajectoryDir);
      logLiveStep("runtime-traces", { trajectoryDir, files: trajectoryFiles });
      expect(trajectoryFiles.length).toBeGreaterThan(0);

      const bundleDir = path.join(workspaceDir, ".openclaw", "trajectory-exports", "bundle");
      const beforeExport = new Set(await listDirectoryNames(tempDir));
      const exportRunId = `chat-export-${randomUUID()}`;
      logLiveStep("export:start", { bundleDir, exportRunId });
      const exportResponse = (await client.request(
        "chat.send",
        {
          sessionKey,
          message: "/export-trajectory bundle",
          idempotencyKey: exportRunId,
        },
        { timeoutMs: 60_000 },
      )) as { status?: string; message?: unknown };
      logLiveStep("export:ack", { status: exportResponse?.status });
      expect(
        exportResponse?.status === "accepted" ||
          exportResponse?.status === "ok" ||
          exportResponse?.status === "started",
      ).toBe(true);
      const finalText =
        typeof exportResponse?.message === "object"
          ? extractFirstTextBlock(exportResponse.message)
          : await waitForChatFinalText({
              events: gatewayEvents,
              runId: exportRunId,
              timeoutMs: 60_000,
            });
      expect(finalText).toContain("Trajectory exports can include");
      expect(finalText).toContain("through exec approval");
      const approvalId = await approveTrajectoryExport(client);
      logLiveStep("export:approved", { approvalId });
      await waitForPath(path.join(bundleDir, "events.jsonl"), 60_000);
      logLiveStep("export:done", { finalText });
      expect(finalText).toContain("Approve once");
      const bundleNames = await listDirectoryNames(bundleDir);
      for (const expectedName of [
        "artifacts.json",
        "events.jsonl",
        "manifest.json",
        "metadata.json",
        "prompts.json",
        "session.jsonl",
        "tools.json",
      ]) {
        expect(bundleNames).toContain(expectedName);
      }
      expect(beforeExport.has("bundle")).toBe(false);

      const manifest = JSON.parse(
        await fs.readFile(path.join(bundleDir, "manifest.json"), "utf8"),
      ) as {
        eventCount?: number;
        runtimeEventCount?: number;
        transcriptEventCount?: number;
      };
      expect(manifest.eventCount).toBeGreaterThan(0);
      expect(manifest.runtimeEventCount).toBeGreaterThan(0);
      expect(manifest.transcriptEventCount).toBeGreaterThan(0);

      const exportedEvents = (await fs.readFile(path.join(bundleDir, "events.jsonl"), "utf8"))
        .trim()
        .split(/\r?\n/u)
        .map((line) => JSON.parse(line) as { type?: string });
      const eventTypes = new Set(exportedEvents.map((event) => event.type));
      expect(eventTypes.has("context.compiled")).toBe(true);
      expect(eventTypes.has("prompt.submitted")).toBe(true);
      expect(eventTypes.has("model.completed")).toBe(true);
      expect(eventTypes.has("session.ended")).toBe(true);
      expect(eventTypes.has("user.message")).toBe(true);
      expect(eventTypes.has("assistant.message")).toBe(true);
    },
    LIVE_TIMEOUT_MS,
  );
});
