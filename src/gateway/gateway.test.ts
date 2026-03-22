import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearAllBootstrapSnapshots } from "../agents/bootstrap-cache.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store.js";
import { resetAgentRunContextForTest } from "../infra/agent-events.js";
import { clearGatewaySubagentRuntime } from "../plugins/runtime/index.js";
import { captureEnv } from "../test-utils/env.js";
import { startGatewayServer } from "./server.js";
import {
  connectDeviceAuthReq,
  disconnectGatewayClient,
  connectGatewayClient,
  getFreeGatewayPort,
  startGatewayWithClient,
} from "./test-helpers.e2e.js";
import { installOpenAiResponsesMock } from "./test-helpers.openai-mock.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

let writeConfigFile: typeof import("../config/config.js").writeConfigFile;
let resolveConfigPath: typeof import("../config/config.js").resolveConfigPath;
const GATEWAY_E2E_TIMEOUT_MS = 90_000;
let gatewayTestSeq = 0;

function nextGatewayId(prefix: string): string {
  return `${prefix}-${process.pid}-${process.env.VITEST_POOL_ID ?? "0"}-${gatewayTestSeq++}`;
}

describe("gateway e2e", () => {
  beforeEach(() => {
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    clearSessionStoreCacheForTest();
    resetAgentRunContextForTest();
    clearAllBootstrapSnapshots();
    clearGatewaySubagentRuntime();
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    clearSessionStoreCacheForTest();
    resetAgentRunContextForTest();
    clearAllBootstrapSnapshots();
    clearGatewaySubagentRuntime();
  });

  beforeAll(async () => {
    ({ writeConfigFile, resolveConfigPath } = await import("../config/config.js"));
  });

  it(
    "accepts a gateway agent request over ws and returns a run id",
    { timeout: GATEWAY_E2E_TIMEOUT_MS },
    async () => {
      const envSnapshot = captureEnv([
        "HOME",
        "OPENCLAW_STATE_DIR",
        "OPENCLAW_CONFIG_PATH",
        "OPENCLAW_GATEWAY_TOKEN",
        "OPENCLAW_SKIP_CHANNELS",
        "OPENCLAW_SKIP_GMAIL_WATCHER",
        "OPENCLAW_SKIP_CRON",
        "OPENCLAW_SKIP_CANVAS_HOST",
        "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
      ]);

      const { baseUrl: openaiBaseUrl, restore } = installOpenAiResponsesMock();

      const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-mock-home-"));
      process.env.HOME = tempHome;
      process.env.OPENCLAW_STATE_DIR = path.join(tempHome, ".openclaw");
      delete process.env.OPENCLAW_CONFIG_PATH;
      process.env.OPENCLAW_SKIP_CHANNELS = "1";
      process.env.OPENCLAW_SKIP_GMAIL_WATCHER = "1";
      process.env.OPENCLAW_SKIP_CRON = "1";
      process.env.OPENCLAW_SKIP_CANVAS_HOST = "1";
      process.env.OPENCLAW_SKIP_BROWSER_CONTROL_SERVER = "1";

      const token = nextGatewayId("test-token");
      process.env.OPENCLAW_GATEWAY_TOKEN = token;

      const workspaceDir = path.join(tempHome, "openclaw");
      await fs.mkdir(workspaceDir, { recursive: true });

      const configDir = path.join(tempHome, ".openclaw");
      await fs.mkdir(configDir, { recursive: true });
      const configPath = path.join(configDir, "openclaw.json");
      const mockProvider = buildMockOpenAiResponsesProvider(openaiBaseUrl);

      const cfg = {
        agents: {
          defaults: {
            workspace: workspaceDir,
            model: { primary: mockProvider.modelRef },
            models: {
              [mockProvider.modelRef]: {
                params: {
                  transport: "sse",
                  openaiWsWarmup: false,
                },
              },
            },
          },
        },
        models: {
          mode: "replace",
          providers: {
            [mockProvider.providerId]: mockProvider.config,
          },
        },
        gateway: { auth: { token } },
      };

      const { server, client } = await startGatewayWithClient({
        cfg,
        configPath,
        token,
        clientDisplayName: "vitest-mock-openai",
      });

      try {
        const sessionKey = "agent:dev:mock-openai";

        const runId = nextGatewayId("run");
        const payload = await client.request<{
          status?: unknown;
          runId?: unknown;
        }>(
          "agent",
          {
            sessionKey,
            idempotencyKey: `idem-${runId}`,
            message: "Reply with ok.",
            deliver: false,
          },
          { expectFinal: false },
        );

        expect(payload?.status).toBe("accepted");
        expect(typeof payload?.runId).toBe("string");
      } finally {
        await disconnectGatewayClient(client);
        await server.close({ reason: "mock openai test complete" });
        await fs.rm(tempHome, { recursive: true, force: true });
        restore();
        envSnapshot.restore();
      }
    },
  );

  it(
    "runs wizard over ws and writes auth token config",
    { timeout: GATEWAY_E2E_TIMEOUT_MS },
    async () => {
      const envSnapshot = captureEnv([
        "HOME",
        "OPENCLAW_STATE_DIR",
        "OPENCLAW_CONFIG_PATH",
        "OPENCLAW_GATEWAY_TOKEN",
        "OPENCLAW_SKIP_CHANNELS",
        "OPENCLAW_SKIP_GMAIL_WATCHER",
        "OPENCLAW_SKIP_CRON",
        "OPENCLAW_SKIP_CANVAS_HOST",
        "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
      ]);

      process.env.OPENCLAW_SKIP_CHANNELS = "1";
      process.env.OPENCLAW_SKIP_GMAIL_WATCHER = "1";
      process.env.OPENCLAW_SKIP_CRON = "1";
      process.env.OPENCLAW_SKIP_CANVAS_HOST = "1";
      process.env.OPENCLAW_SKIP_BROWSER_CONTROL_SERVER = "1";
      delete process.env.OPENCLAW_GATEWAY_TOKEN;

      const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-wizard-home-"));
      process.env.HOME = tempHome;
      delete process.env.OPENCLAW_STATE_DIR;
      delete process.env.OPENCLAW_CONFIG_PATH;

      const wizardToken = nextGatewayId("wiz-token");
      const port = await getFreeGatewayPort();
      const server = await startGatewayServer(port, {
        bind: "loopback",
        auth: { mode: "token", token: wizardToken },
        controlUiEnabled: false,
        wizardRunner: async (_opts, _runtime, prompter) => {
          await prompter.intro("Wizard E2E");
          await prompter.note("write token");
          const token = await prompter.text({ message: "token" });
          await writeConfigFile({
            gateway: { auth: { mode: "token", token: String(token) } },
          });
          await prompter.outro("ok");
        },
      });

      const client = await connectGatewayClient({
        url: `ws://127.0.0.1:${port}`,
        token: wizardToken,
        clientDisplayName: "vitest-wizard",
      });

      try {
        const start = await client.request<{
          sessionId?: string;
          done: boolean;
          status: "running" | "done" | "cancelled" | "error";
          step?: {
            id: string;
            type: "note" | "select" | "text" | "confirm" | "multiselect" | "progress";
          };
          error?: string;
        }>("wizard.start", { mode: "local" });
        const sessionId = start.sessionId;
        expect(typeof sessionId).toBe("string");

        let next = start;
        let didSendToken = false;
        while (!next.done) {
          const step = next.step;
          if (!step) {
            throw new Error("wizard missing step");
          }
          const value = step.type === "text" ? wizardToken : null;
          if (step.type === "text") {
            didSendToken = true;
          }
          next = await client.request("wizard.next", {
            sessionId,
            answer: { stepId: step.id, value },
          });
        }

        expect(didSendToken).toBe(true);
        expect(next.status).toBe("done");

        const parsed = JSON.parse(await fs.readFile(resolveConfigPath(), "utf8"));
        const token = (parsed as Record<string, unknown>)?.gateway as
          | Record<string, unknown>
          | undefined;
        expect((token?.auth as { token?: string } | undefined)?.token).toBe(wizardToken);
      } finally {
        await disconnectGatewayClient(client);
        await server.close({ reason: "wizard e2e complete" });
      }

      const port2 = await getFreeGatewayPort();
      const server2 = await startGatewayServer(port2, {
        bind: "loopback",
        controlUiEnabled: false,
      });
      try {
        const resNoToken = await connectDeviceAuthReq({
          url: `ws://127.0.0.1:${port2}`,
        });
        expect(resNoToken.ok).toBe(false);
        expect(resNoToken.error?.message ?? "").toContain("unauthorized");

        const resToken = await connectDeviceAuthReq({
          url: `ws://127.0.0.1:${port2}`,
          token: wizardToken,
        });
        expect(resToken.ok).toBe(true);
      } finally {
        await server2.close({ reason: "wizard auth verify" });
        await fs.rm(tempHome, { recursive: true, force: true });
        envSnapshot.restore();
      }
    },
  );
});
