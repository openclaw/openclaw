import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { SystemAgentSetupDetectResult } from "../../packages/gateway-protocol/src/schema/openclaw.js";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { discoverOpenAICompatibleLocalModels } from "../plugin-sdk/provider-setup.js";
import { listManualSetupInferenceOptions } from "../system-agent/setup-inference-detect.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";

const lifetime = createFixtureLifetime();
let scenario: "idle" | "ready" | "protected" | "unknown" = "idle";
const requests: string[] = [];
let fixture: {
  baseUrl: string;
  state: OpenClawTestState;
  gateway: Awaited<ReturnType<typeof startGatewayWithClient>>;
};

// The suite owns the real Gateway and private selectors; the case owns RPC behavior.
// Use the shared setup-hook budget instead of spending the 60s case deadline on boot.
beforeAll(async () => {
  const started = performance.now();
  fixture = await lifetime.acquire(async (rejectAfterCleanup) => {
    const state = await createOpenClawTestState({
      label: "setup-local-services",
      env: {
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_DISABLE_BONJOUR: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      },
    });
    // Without a returned handle, acquisition errors do not certify native cleanup.
    // The existing lifetime retains private selectors and inputs on those failures.
    const http = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        createServer((request, response) => {
          const path = new URL(request.url ?? "/", "http://fixture.test").pathname;
          requests.push(`${request.method} ${request.url}`);
          response.setHeader("content-type", "application/json");
          if (scenario === "protected") {
            response.writeHead(401).end("{}");
            return;
          }
          if (scenario === "unknown") {
            response.end("{}");
            return;
          }
          const ready = scenario === "ready";
          const bodies: Record<string, unknown> = {
            "/health": { status: "ok" },
            "/models": {
              data: ready ? [{ id: "fixture-llama", status: { value: "loaded" } }] : [],
            },
            "/props": { default_generation_settings: { n_ctx: 8192 } },
            "/api/tags": {
              models: [{ name: "fixture-ollama", details: { parameter_size: "1B" } }],
            },
            "/api/ps": { models: ready ? [{ name: "fixture-ollama" }] : [] },
            "/api/show": {
              capabilities: ["completion", "tools"],
              model_info: { "llama.context_length": 32768 },
            },
          };
          if (!Object.hasOwn(bodies, path)) {
            response.writeHead(404).end("{}");
            return;
          }
          response.end(JSON.stringify(bodies[path]));
        }),
    });
    const baseUrl = `http://127.0.0.1:${http.claim.port}`;
    const gateway = await startGatewayWithClient({
      configPath: state.configPath,
      token: "synthetic-local-service-test",
      cfg: {
        gateway: { mode: "local" },
        agents: {
          defaults: {
            workspace: state.workspaceDir,
            skipBootstrap: true,
            model: { primary: "openai/preserved-model" },
          },
        },
        models: {
          providers: {
            "llama-app": { baseUrl: `${baseUrl}/v1`, models: [] },
            "llama-cpp": { baseUrl: `${baseUrl}/v1`, models: [] },
            ollama: { baseUrl, models: [] },
          },
        },
        plugins: {
          allow: ["llama-cpp", "ollama"],
          entries: { "llama-cpp": { enabled: true }, ollama: { enabled: true } },
          slots: { memory: "none" },
        },
        cron: { enabled: false },
        update: { checkOnStart: false },
      },
    });
    const cleanup = async () => {
      await runQaGatewayFixture(
        () => disconnectGatewayClient(gateway.client),
        () => gateway.server.close(),
      );
      await http.releaseListener();
      await http.claim.release();
      await state.cleanup();
    };
    try {
      await gateway.server.startupSettled;
      return { baseUrl, state, gateway, cleanup };
    } catch (error) {
      return await rejectAfterCleanup(error, cleanup);
    }
  });
  console.info(
    "[setup-local-services] suite-ready durationMs=" + Math.round(performance.now() - started),
  );
});

// Joins late setup/case settlement before closing the server or restoring selectors.
afterAll(() => lifetime.cleanup());

it(
  "keeps reachable local services separate from runnable models through setup RPC",
  { timeout: 60_000 },
  () =>
    lifetime.run(async () => {
      const started = performance.now();
      const {
        baseUrl,
        state,
        gateway: { client },
      } = fixture;
      try {
        const configBefore = await readFile(state.configPath, "utf8");
        const configStat = await stat(state.configPath);
        requests.length = 0;
        const manual = await listManualSetupInferenceOptions();
        expect(requests).toEqual([]);
        expect(manual.prepareOptions?.every((option) => !("serviceReachable" in option))).toBe(
          true,
        );
        for (const current of ["idle", "ready", "protected", "unknown"] as const) {
          scenario = current;
          requests.length = 0;
          const result = await client.request<SystemAgentSetupDetectResult>(
            "openclaw.setup.detect",
            {},
          );
          const option = (id: string) => result.prepareOptions?.find((entry) => entry.id === id);
          expect(result.configuredModel, current).toBe("openai/preserved-model");
          expect(await readFile(state.configPath, "utf8"), current).toBe(configBefore);
          const currentStat = await stat(state.configPath);
          expect([currentStat.mtimeMs, currentStat.ctimeMs], current).toEqual([
            configStat.mtimeMs,
            configStat.ctimeMs,
          ]);
          expect(
            requests.every(
              (entry) =>
                [
                  "GET /health",
                  "GET /models",
                  "GET /v1/models",
                  "GET /api/tags",
                  "GET /api/ps",
                  "POST /api/show",
                ].includes(entry) ||
                (entry.startsWith("GET /props?") && entry.endsWith("autoload=false")),
            ),
            current,
          ).toBe(true);
          expect(
            result.candidates.some((candidate) => candidate.modelRef === "llama-app/fixture-llama"),
            current,
          ).toBe(current === "ready");
          expect(
            result.candidates.some((candidate) => candidate.modelRef === "ollama/fixture-ollama"),
            current,
          ).toBe(current === "ready");
          if (current === "idle" || current === "ready") {
            if (!option("llama-app")?.serviceReachable) {
              const diagnostic = await discoverOpenAICompatibleLocalModels({
                baseUrl: `${baseUrl}/v1`,
                serverBaseUrl: baseUrl,
                label: "isolated Llama fixture",
                healthPath: "/health",
                modelsPathOrder: "server-first",
                rawResult: true,
              });
              throw new Error(
                `Missing RPC service fact: ${diagnostic.kind}; ${"error" in diagnostic ? String(diagnostic.error) : "no discovery error"}; HTTP fixture requests: ${requests.join(", ")}`,
              );
            }
            expect(option("llama-app"), current).toMatchObject({ serviceReachable: true });
          } else {
            expect(option("llama-app"), current).not.toHaveProperty("serviceReachable");
          }
          expect(option("ollama"), current).toMatchObject({ serviceReachable: true });
          expect(
            requests.some((entry) => entry.includes("/api/ps")),
            current,
          ).toBe(true);
        }
      } finally {
        console.info(
          "[setup-local-services] rpc-case durationMs=" + Math.round(performance.now() - started),
        );
      }
    }),
);
