import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Api, Model } from "@mariozechner/pi-ai";
import {
  discoverAuthStorage,
  discoverModels,
} from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { resolveClawdbotAgentDir } from "../agents/agent-paths.js";
import { getApiKeyForModel } from "../agents/model-auth.js";
import { ensureClawdbotModelsJson } from "../agents/models-config.js";
import { loadConfig } from "../config/config.js";
import { resolveUserPath } from "../utils.js";
import { GatewayClient } from "./client.js";
import { startGatewayServer } from "./server.js";
import { getFreePort } from "./test-helpers.js";

const LIVE = process.env.LIVE === "1" || process.env.CLAWDBOT_LIVE_TEST === "1";
const GATEWAY_LIVE = process.env.CLAWDBOT_LIVE_GATEWAY === "1";
const ALL_MODELS =
  process.env.CLAWDBOT_LIVE_GATEWAY_ALL_MODELS === "1" ||
  process.env.CLAWDBOT_LIVE_GATEWAY_MODELS === "all";

const describeLive = LIVE && GATEWAY_LIVE ? describe : describe.skip;

function parseFilter(raw?: string): Set<string> | null {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed === "all") return null;
  const ids = trimmed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.length ? new Set(ids) : null;
}

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

function isMeaningful(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.toLowerCase() === "ok") return false;
  if (trimmed.length < 60) return false;
  const words = trimmed.split(/\s+/g).filter(Boolean);
  if (words.length < 12) return false;
  return true;
}

type AgentFinalPayload = {
  status?: unknown;
  result?: unknown;
};

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
      clientName: "vitest-live",
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

describeLive("gateway live (dev agent, profile keys)", () => {
  it(
    "runs meaningful prompts across models with available keys",
    async () => {
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

      const cfg = loadConfig();
      await ensureClawdbotModelsJson(cfg);

      const workspaceDir = resolveUserPath(
        cfg.agents?.defaults?.workspace ?? path.join(os.homedir(), "clawd"),
      );
      await fs.mkdir(workspaceDir, { recursive: true });
      const nonceA = randomUUID();
      const nonceB = randomUUID();
      const toolProbePath = path.join(
        workspaceDir,
        `.clawdbot-live-tool-probe.${nonceA}.txt`,
      );
      await fs.writeFile(toolProbePath, `nonceA=${nonceA}\nnonceB=${nonceB}\n`);

      const agentDir = resolveClawdbotAgentDir();
      const authStorage = discoverAuthStorage(agentDir);
      const modelRegistry = discoverModels(authStorage, agentDir);
      const all = modelRegistry.getAll() as Array<Model<Api>>;

      const filter = parseFilter(process.env.CLAWDBOT_LIVE_GATEWAY_MODELS);

      // Default: honor user allowlist. Opt-in: scan all models with keys.
      const allowlistKeys = Object.keys(cfg.agents?.defaults?.models ?? {});
      const wanted =
        ALL_MODELS || allowlistKeys.length === 0
          ? all
          : all.filter((m) => allowlistKeys.includes(`${m.provider}/${m.id}`));

      const candidates: Array<Model<Api>> = [];
      for (const model of wanted) {
        const id = `${model.provider}/${model.id}`;
        if (filter && !filter.has(id)) continue;
        try {
          // eslint-disable-next-line no-await-in-loop
          await getApiKeyForModel({ model, cfg });
          candidates.push(model);
        } catch {
          // no creds; skip
        }
      }

      expect(candidates.length).toBeGreaterThan(0);

      // Build a temp config that allows all selected models, so session overrides stick.
      const nextCfg = {
        ...cfg,
        agents: {
          ...(cfg.agents ?? {}),
          defaults: {
            ...(cfg.agents?.defaults ?? {}),
            models: Object.fromEntries(
              candidates.map((m) => [`${m.provider}/${m.id}`, {}]),
            ),
          },
        },
      };
      const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "clawdbot-live-"),
      );
      const tempConfigPath = path.join(tempDir, "clawdbot.json");
      await fs.writeFile(
        tempConfigPath,
        `${JSON.stringify(nextCfg, null, 2)}\n`,
      );
      process.env.CLAWDBOT_CONFIG_PATH = tempConfigPath;

      const port = await getFreePort();
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
        const sessionKey = "agent:dev:live-gateway";

        const failures: Array<{ model: string; error: string }> = [];

        for (const model of candidates) {
          const modelKey = `${model.provider}/${model.id}`;

          try {
            // Ensure session exists + override model for this run.
            await client.request<Record<string, unknown>>("sessions.patch", {
              key: sessionKey,
              model: modelKey,
            });

            // “Meaningful” direct prompt (no tools).
            const runId = randomUUID();
            const payload = await client.request<AgentFinalPayload>(
              "agent",
              {
                sessionKey,
                idempotencyKey: `idem-${runId}`,
                message:
                  "Explain in 2-3 sentences how the JavaScript event loop handles microtasks vs macrotasks. Must mention both words: microtask and macrotask.",
                deliver: false,
              },
              { expectFinal: true },
            );

            if (payload?.status !== "ok") {
              throw new Error(`agent status=${String(payload?.status)}`);
            }
            const text = extractPayloadText(payload?.result);
            if (!isMeaningful(text)) throw new Error(`not meaningful: ${text}`);
            if (
              !/\\bmicrotask\\b/i.test(text) ||
              !/\\bmacrotask\\b/i.test(text)
            ) {
              throw new Error(`missing required keywords: ${text}`);
            }

            // Real tool invocation: force the agent to Read a local file and echo a nonce.
            const runIdTool = randomUUID();
            const toolProbe = await client.request<AgentFinalPayload>(
              "agent",
              {
                sessionKey,
                idempotencyKey: `idem-${runIdTool}-tool`,
                message:
                  `Call the tool named \`read\` (or \`Read\` if \`read\` is unavailable) on "${toolProbePath}". ` +
                  `Then reply with exactly: ${nonceA} ${nonceB}. No extra text.`,
                deliver: false,
              },
              { expectFinal: true },
            );
            if (toolProbe?.status !== "ok") {
              throw new Error(
                `tool probe failed: status=${String(toolProbe?.status)}`,
              );
            }
            const toolText = extractPayloadText(toolProbe?.result);
            if (!toolText.includes(nonceA) || !toolText.includes(nonceB)) {
              throw new Error(`tool probe missing nonce: ${toolText}`);
            }

            // Regression: tool-call-only turn followed by a user message (OpenAI responses bug class).
            if (
              (model.provider === "openai" &&
                model.api === "openai-responses") ||
              (model.provider === "openai-codex" &&
                model.api === "openai-codex-responses")
            ) {
              const runId2 = randomUUID();
              const first = await client.request<AgentFinalPayload>(
                "agent",
                {
                  sessionKey,
                  idempotencyKey: `idem-${runId2}-1`,
                  message:
                    "Call the tool named `read` (or `Read`) on package.json. Do not write any other text.",
                  deliver: false,
                },
                { expectFinal: true },
              );
              if (first?.status !== "ok") {
                throw new Error(
                  `tool-only turn failed: status=${String(first?.status)}`,
                );
              }

              const second = await client.request<AgentFinalPayload>(
                "agent",
                {
                  sessionKey,
                  idempotencyKey: `idem-${runId2}-2`,
                  message:
                    'Now answer: what is the "version" field in package.json? Reply with just the version string.',
                  deliver: false,
                },
                { expectFinal: true },
              );
              if (second?.status !== "ok") {
                throw new Error(
                  `post-tool message failed: status=${String(second?.status)}`,
                );
              }
              const version = extractPayloadText(second?.result);
              if (!/^\\d{4}\\.\\d+\\.\\d+/.test(version.trim())) {
                throw new Error(`unexpected version: ${version}`);
              }
            }
          } catch (err) {
            failures.push({ model: modelKey, error: String(err) });
          }
        }

        if (failures.length > 0) {
          const preview = failures
            .slice(0, 20)
            .map((f) => `- ${f.model}: ${f.error}`)
            .join("\n");
          throw new Error(
            `gateway live model failures (${failures.length}):\n${preview}`,
          );
        }
      } finally {
        client.stop();
        await server.close({ reason: "live test complete" });
        await fs.rm(toolProbePath, { force: true });
        await fs.rm(tempDir, { recursive: true, force: true });

        process.env.CLAWDBOT_CONFIG_PATH = previous.configPath;
        process.env.CLAWDBOT_GATEWAY_TOKEN = previous.token;
        process.env.CLAWDBOT_SKIP_PROVIDERS = previous.skipProviders;
        process.env.CLAWDBOT_SKIP_GMAIL_WATCHER = previous.skipGmail;
        process.env.CLAWDBOT_SKIP_CRON = previous.skipCron;
        process.env.CLAWDBOT_SKIP_CANVAS_HOST = previous.skipCanvas;
      }
    },
    20 * 60 * 1000,
  );
});
