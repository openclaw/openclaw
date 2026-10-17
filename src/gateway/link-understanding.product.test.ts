import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { text } from "node:stream/consumers";
import { expect, it, vi } from "vitest";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

vi.mock("../infra/net/fetch-guard.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/net/fetch-guard.js")>(
    "../infra/net/fetch-guard.js",
  );
  return {
    ...actual,
    fetchWithSsrFGuard: async (params: Parameters<typeof actual.fetchWithSsrFGuard>[0]) =>
      actual.fetchWithSsrFGuard({
        ...params,
        lookupFn: async () => [{ address: "127.0.0.1", family: 4 }],
        policy: { ...params.policy, allowPrivateNetwork: true },
      }),
  };
});

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server did not bind a loopback port");
  }
  return address.port;
}

async function close(server: ReturnType<typeof createServer> | undefined): Promise<void> {
  if (!server?.listening) {
    return;
  }
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

it(
  "Gateway link understanding fetches bare URLs but not titled markdown links through chat.send",
  { timeout: 90_000 },
  async () =>
    withTestDir({ prefix: "openclaw-link-gateway-" }, async (tempHome) => {
      const stateDir = path.join(tempHome, ".openclaw");
      const workspaceDir = path.join(tempHome, "workspace");
      const configPath = path.join(stateDir, "openclaw.json");
      const bundledPluginsDir = path.join(tempHome, "bundled-plugins");
      const providerBodies: string[] = [];
      const linkRequests: string[] = [];
      let providerServer: ReturnType<typeof createServer> | undefined;
      let linkServer: ReturnType<typeof createServer> | undefined;
      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;

      const env = {
        HOME: tempHome,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_GATEWAY_TOKEN: "link-understanding-gateway-token",
        OPENCLAW_TEST_FAST: "0",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      };
      const envSnapshot = captureEnv(Object.keys(env));
      try {
        await Promise.all(
          [workspaceDir, bundledPluginsDir, stateDir].map((dir) =>
            fs.mkdir(dir, { recursive: true }),
          ),
        );
        for (const [key, value] of Object.entries(env)) {
          setTestEnvValue(key, value);
        }

        linkServer = createServer((request, response) => {
          const requestPath = request.url ?? "";
          linkRequests.push(requestPath);
          response.end(requestPath === "/citation" ? "CITATION_PAGE" : "BARE_PAGE");
        });
        const linkPort = await listen(linkServer);

        providerServer = createServer(async (request, response) => {
          providerBodies.push(await text(request));
          writeOpenAiResponsesText(response, { text: "OK", messageId: "msg", responseId: "resp" });
        });
        const providerPort = await listen(providerServer);
        const provider = buildMockOpenAiResponsesProvider(`http://127.0.0.1:${providerPort}/v1`);
        const cfg = {
          agents: {
            defaults: {
              workspace: workspaceDir,
              skipBootstrap: true,
              model: { primary: provider.modelRef },
              models: {
                [provider.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } },
              },
            },
            entries: { main: {} },
          },
          models: { mode: "replace", providers: { [provider.providerId]: provider.config } },
          tools: {
            links: {
              enabled: true,
              models: [{ type: "cli", command: "curl", args: ["{{LinkUrl}}"] }],
            },
          },
          gateway: { auth: { mode: "token", token: "link-understanding-gateway-token" } },
        };
        gateway = await startGatewayWithClient({
          cfg,
          configPath,
          token: "link-understanding-gateway-token",
          clientDisplayName: "link-understanding-gateway",
        });
        const linkBase = `http://loopback.test:${linkPort}`;
        const started = await gateway.client.request<{ runId?: string; status?: string }>(
          "chat.send",
          {
            sessionKey: "agent:main:link-understanding-gateway",
            message: `[citation](${linkBase}/citation "Citation") ${linkBase}/bare`,
            deliver: false,
            idempotencyKey: "link-understanding-gateway-run",
          },
        );
        expect(started).toMatchObject({ status: "started", runId: expect.any(String) });
        await expect(
          gateway.client.request(
            "agent.wait",
            { runId: started.runId, timeoutMs: 30_000 },
            { timeoutMs: 35_000 },
          ),
        ).resolves.toMatchObject({ status: "ok" });

        expect(linkRequests).toEqual(["/bare"]);
        expect(providerBodies.join("\n")).toContain("BARE_PAGE");
        expect(providerBodies.join("\n")).not.toContain("CITATION_PAGE");
      } finally {
        if (gateway) {
          await disconnectGatewayClient(gateway.client).catch(() => undefined);
          await gateway.server.close().catch(() => undefined);
        }
        await close(providerServer);
        await close(linkServer);
        envSnapshot.restore();
        clearRuntimeConfigSnapshot();
        clearConfigCache();
        clearSessionStoreCacheForTest();
      }
    }),
);
