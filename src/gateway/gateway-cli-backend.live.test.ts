import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parseModelRef } from "../agents/model-selection.js";
import { loadConfig } from "../config/config.js";
import { GatewayClient } from "./client.js";
import { startGatewayServer } from "./server.js";

const LIVE = process.env.LIVE === "1" || process.env.CLAWDBOT_LIVE_TEST === "1";
const CLI_LIVE = process.env.CLAWDBOT_LIVE_CLI_BACKEND === "1";
const describeLive = LIVE && CLI_LIVE ? describe : describe.skip;

const DEFAULT_MODEL = "claude-cli/claude-sonnet-4-5";
const DEFAULT_ARGS = [
  "-p",
  "--output-format",
  "json",
  "--dangerously-skip-permissions",
];
const DEFAULT_CLEAR_ENV: string[] = [];

function extractPayloadText(result: unknown): string {
  const record = result as Record<string, unknown>;
  const payloads = Array.isArray(record.payloads) ? record.payloads : [];
  const texts = payloads
    .map((p) =>
      p && typeof p === "object"
        ? (p as Record<string, unknown>).text
        : undefined,
    )
    .filter((t): t is string => typeof t === "string" && t.trim().length > 0);
  return texts.join("\n").trim();
}

function parseJsonStringArray(
  name: string,
  raw?: string,
): string[] | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  const parsed = JSON.parse(trimmed);
  if (
    !Array.isArray(parsed) ||
    !parsed.every((entry) => typeof entry === "string")
  ) {
    throw new Error(`${name} must be a JSON array of strings.`);
  }
  return parsed;
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
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

async function isPortFree(port: number): Promise<boolean> {
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return false;
  return await new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => {
      srv.close(() => resolve(true));
    });
  });
}

async function getFreeGatewayPort(): Promise<number> {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const port = await getFreePort();
    const candidates = [port, port + 1, port + 2, port + 4];
    const ok = (
      await Promise.all(candidates.map((candidate) => isPortFree(candidate)))
    ).every(Boolean);
    if (ok) return port;
  }
  throw new Error("failed to acquire a free gateway port block");
}

async function connectClient(params: { url: string; token: string }) {
  return await new Promise<GatewayClient>((resolve, reject) => {
    let settled = false;
    const stop = (err?: Error, client?: GatewayClient) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(client as GatewayClient);
    };
    const client = new GatewayClient({
      url: params.url,
      token: params.token,
      clientName: "vitest-live-cli-backend",
      clientVersion: "dev",
      mode: "test",
      onHelloOk: () => stop(undefined, client),
      onConnectError: (err) => stop(err),
      onClose: (code, reason) =>
        stop(new Error(`gateway closed during connect (${code}): ${reason}`)),
    });
    const timer = setTimeout(
      () => stop(new Error("gateway connect timeout")),
      10_000,
    );
    timer.unref();
    client.start();
  });
}

describeLive("gateway live (cli backend)", () => {
  it("runs the agent pipeline against the local CLI backend", async () => {
    const previous = {
      configPath: process.env.CLAWDBOT_CONFIG_PATH,
      token: process.env.CLAWDBOT_GATEWAY_TOKEN,
      skipProviders: process.env.CLAWDBOT_SKIP_PROVIDERS,
      skipGmail: process.env.CLAWDBOT_SKIP_GMAIL_WATCHER,
      skipCron: process.env.CLAWDBOT_SKIP_CRON,
      skipCanvas: process.env.CLAWDBOT_SKIP_CANVAS_HOST,
    };

    process.env.CLAWDBOT_SKIP_PROVIDERS = "1";
    process.env.CLAWDBOT_SKIP_GMAIL_WATCHER = "1";
    process.env.CLAWDBOT_SKIP_CRON = "1";
    process.env.CLAWDBOT_SKIP_CANVAS_HOST = "1";

    const token = `test-${randomUUID()}`;
    process.env.CLAWDBOT_GATEWAY_TOKEN = token;

    const rawModel =
      process.env.CLAWDBOT_LIVE_CLI_BACKEND_MODEL ?? DEFAULT_MODEL;
    const parsed = parseModelRef(rawModel, "claude-cli");
    if (!parsed || parsed.provider !== "claude-cli") {
      throw new Error(
        `CLAWDBOT_LIVE_CLI_BACKEND_MODEL must resolve to a claude-cli model. Got: ${rawModel}`,
      );
    }
    const modelKey = `${parsed.provider}/${parsed.model}`;

    const cliCommand =
      process.env.CLAWDBOT_LIVE_CLI_BACKEND_COMMAND ?? "claude";
    const cliArgs =
      parseJsonStringArray(
        "CLAWDBOT_LIVE_CLI_BACKEND_ARGS",
        process.env.CLAWDBOT_LIVE_CLI_BACKEND_ARGS,
      ) ?? DEFAULT_ARGS;
    const cliClearEnv =
      parseJsonStringArray(
        "CLAWDBOT_LIVE_CLI_BACKEND_CLEAR_ENV",
        process.env.CLAWDBOT_LIVE_CLI_BACKEND_CLEAR_ENV,
      ) ?? DEFAULT_CLEAR_ENV;

    const cfg = loadConfig();
    const existingBackends = cfg.agents?.defaults?.cliBackends ?? {};
    const nextCfg = {
      ...cfg,
      agents: {
        ...cfg.agents,
        defaults: {
          ...cfg.agents?.defaults,
          model: { primary: modelKey },
          models: {
            [modelKey]: {},
          },
          cliBackends: {
            ...existingBackends,
            "claude-cli": {
              command: cliCommand,
              args: cliArgs,
              clearEnv: cliClearEnv,
            },
          },
          sandbox: { mode: "off" },
        },
      },
    };

    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "clawdbot-live-cli-"),
    );
    const tempConfigPath = path.join(tempDir, "clawdbot.json");
    await fs.writeFile(tempConfigPath, `${JSON.stringify(nextCfg, null, 2)}\n`);
    process.env.CLAWDBOT_CONFIG_PATH = tempConfigPath;

    const port = await getFreeGatewayPort();
    const server = await startGatewayServer(port, {
      bind: "loopback",
      auth: { mode: "token", token },
      controlUiEnabled: false,
    });

    const client = await connectClient({
      url: `ws://127.0.0.1:${port}`,
      token,
    });

    try {
      const sessionKey = "agent:dev:live-cli-backend";
      const runId = randomUUID();
      const nonce = randomBytes(3).toString("hex").toUpperCase();
      const payload = await client.request<Record<string, unknown>>(
        "agent",
        {
          sessionKey,
          idempotencyKey: `idem-${runId}`,
          message: `Reply with exactly: CLI backend OK ${nonce}.`,
          deliver: false,
        },
        { expectFinal: true },
      );
      if (payload?.status !== "ok") {
        throw new Error(`agent status=${String(payload?.status)}`);
      }
      const text = extractPayloadText(payload?.result);
      expect(text).toContain(`CLI backend OK ${nonce}.`);
    } finally {
      client.stop();
      await server.close();
      await fs.rm(tempDir, { recursive: true, force: true });
      if (previous.configPath === undefined)
        delete process.env.CLAWDBOT_CONFIG_PATH;
      else process.env.CLAWDBOT_CONFIG_PATH = previous.configPath;
      if (previous.token === undefined)
        delete process.env.CLAWDBOT_GATEWAY_TOKEN;
      else process.env.CLAWDBOT_GATEWAY_TOKEN = previous.token;
      if (previous.skipProviders === undefined)
        delete process.env.CLAWDBOT_SKIP_PROVIDERS;
      else process.env.CLAWDBOT_SKIP_PROVIDERS = previous.skipProviders;
      if (previous.skipGmail === undefined)
        delete process.env.CLAWDBOT_SKIP_GMAIL_WATCHER;
      else process.env.CLAWDBOT_SKIP_GMAIL_WATCHER = previous.skipGmail;
      if (previous.skipCron === undefined)
        delete process.env.CLAWDBOT_SKIP_CRON;
      else process.env.CLAWDBOT_SKIP_CRON = previous.skipCron;
      if (previous.skipCanvas === undefined)
        delete process.env.CLAWDBOT_SKIP_CANVAS_HOST;
      else process.env.CLAWDBOT_SKIP_CANVAS_HOST = previous.skipCanvas;
    }
  }, 60_000);
});
