import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config/config.js";
import {
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticRuntimeMetricEvent,
} from "../infra/diagnostic-events.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { getFreePortBlockWithPermissionFallback } from "../test-utils/ports.js";
import { GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { GatewayClient } from "./client.js";
import { renderCatNoncePngBase64 } from "./live-image-probe.js";
import { startGatewayServer } from "./server.js";
import { extractPayloadText } from "./test-helpers.agent-results.js";

const LIVE = isTruthyEnvValue(process.env.LIVE) || isTruthyEnvValue(process.env.OPENCLAW_LIVE_TEST);
const CLAUDE_MEDIA_LIVE = isTruthyEnvValue(process.env.OPENCLAW_LIVE_CLAUDE_SDK_MEDIA_TEST);
const describeLive = LIVE && CLAUDE_MEDIA_LIVE ? describe : describe.skip;

const DEFAULT_PROVIDER = process.env.OPENCLAW_LIVE_CLAUDE_SDK_PROVIDER?.trim() || "claude-pro";
const DEFAULT_MODEL = process.env.OPENCLAW_LIVE_CLAUDE_SDK_MODEL?.trim() || "claude-sonnet-4-5";

async function getFreeGatewayPort(): Promise<number> {
  return await getFreePortBlockWithPermissionFallback({
    offsets: [0, 1, 2, 4],
    fallbackBase: 41_000,
  });
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
      clientVersion: "dev",
      mode: "test",
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

function metricNumber(
  evt: Pick<DiagnosticRuntimeMetricEvent, "fields"> | undefined,
  key: string,
): number | undefined {
  const raw = evt?.fields?.[key];
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return undefined;
  }
  return raw;
}

describeLive("gateway live (claude-sdk media resume)", () => {
  it("reuses persisted media references after gateway restart in resumed Claude SDK sessions", async () => {
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

    const provider = DEFAULT_PROVIDER;
    const modelId = DEFAULT_MODEL;
    if (!modelId.startsWith("claude-")) {
      throw new Error(
        `OPENCLAW_LIVE_CLAUDE_SDK_MODEL must be a full Claude SDK model id (claude-*). Got: ${modelId}`,
      );
    }
    const modelKey = `${provider}/${modelId}`;

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-live-claude-media-"));
    const cfg = loadConfig();
    const nextCfg = {
      ...cfg,
      diagnostics: {
        ...cfg.diagnostics,
        enabled: true,
      },
      agents: {
        ...cfg.agents,
        defaults: {
          ...cfg.agents?.defaults,
          model: { primary: modelKey },
          models: {
            ...cfg.agents?.defaults?.models,
            [modelKey]: {},
          },
        },
      },
    };
    const tempConfigPath = path.join(tempDir, "openclaw.json");
    await fs.writeFile(tempConfigPath, `${JSON.stringify(nextCfg, null, 2)}\n`);
    process.env.OPENCLAW_CONFIG_PATH = tempConfigPath;

    const port = await getFreeGatewayPort();
    const metrics: DiagnosticRuntimeMetricEvent[] = [];
    const stopMetrics = onDiagnosticEvent((evt) => {
      if (evt.type === "runtime.metric") {
        metrics.push(evt);
      }
    });

    let server = await startGatewayServer(port, {
      bind: "loopback",
      auth: { mode: "token", token },
      controlUiEnabled: false,
    });
    let client = await connectClient({
      url: `ws://127.0.0.1:${port}`,
      token,
    });

    try {
      const sessionKey = `agent:live:claude-media:${randomUUID()}`;
      const imageCode = randomBytes(3).toString("hex").toUpperCase();
      const imageBase64 = renderCatNoncePngBase64(imageCode);

      const firstPayload = await client.request(
        "agent",
        {
          sessionKey,
          idempotencyKey: `idem-${randomUUID()}-media-1`,
          message:
            "Look at the attached image and reply with one short sentence that includes the word cat.",
          attachments: [
            {
              mimeType: "image/png",
              fileName: `resume-probe-${imageCode}.png`,
              content: imageBase64,
            },
          ],
          deliver: false,
        },
        { expectFinal: true },
      );
      if (firstPayload?.status !== "ok") {
        throw new Error(`first run failed: status=${String(firstPayload?.status)}`);
      }
      expect(extractPayloadText(firstPayload?.result).trim().length).toBeGreaterThan(0);
      const firstMetricCount = metrics.length;

      client.stop();
      await server.close();

      server = await startGatewayServer(port, {
        bind: "loopback",
        auth: { mode: "token", token },
        controlUiEnabled: false,
      });
      client = await connectClient({
        url: `ws://127.0.0.1:${port}`,
        token,
      });

      const secondPayload = await client.request(
        "agent",
        {
          sessionKey,
          idempotencyKey: `idem-${randomUUID()}-media-2`,
          message:
            "Analyze the attached image again and reply in one short sentence with the word cat.",
          attachments: [
            {
              mimeType: "image/png",
              fileName: `resume-probe-${imageCode}.png`,
              content: imageBase64,
            },
          ],
          deliver: false,
        },
        { expectFinal: true },
      );
      if (secondPayload?.status !== "ok") {
        throw new Error(`second run failed: status=${String(secondPayload?.status)}`);
      }
      expect(extractPayloadText(secondPayload?.result).trim().length).toBeGreaterThan(0);

      const secondTurnMetrics = metrics
        .slice(firstMetricCount)
        .filter((evt) => evt.sessionKey === sessionKey);
      const secondFileRefMetric = secondTurnMetrics.find(
        (evt) =>
          evt.metric === "claude_sdk.media.file_ref_used" && (metricNumber(evt, "count") ?? 0) > 0,
      );
      expect(secondFileRefMetric).toBeDefined();

      const secondInlineMetric = secondTurnMetrics.find(
        (evt) => evt.metric === "claude_sdk.media.inline_bytes_sent",
      );
      expect(metricNumber(secondInlineMetric, "bytes")).toBe(0);
    } finally {
      stopMetrics();
      resetDiagnosticEventsForTest();
      client.stop();
      await server.close();
      await fs.rm(tempDir, { recursive: true, force: true });

      if (previous.configPath === undefined) {
        delete process.env.OPENCLAW_CONFIG_PATH;
      } else {
        process.env.OPENCLAW_CONFIG_PATH = previous.configPath;
      }
      if (previous.token === undefined) {
        delete process.env.OPENCLAW_GATEWAY_TOKEN;
      } else {
        process.env.OPENCLAW_GATEWAY_TOKEN = previous.token;
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
  }, 180_000);
});
