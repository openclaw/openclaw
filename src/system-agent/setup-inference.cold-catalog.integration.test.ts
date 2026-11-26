import fs from "node:fs/promises";
import http from "node:http";
import { expect, it } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { loadPersistedPluginModelCatalogs } from "../agents/plugin-model-catalog-execution.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../agents/prepared-model-runtime.test-support.js";
import { runSystemAgentWithInference } from "../commands/system-agent-with-inference.js";
import { captureRuntimeConfigAsyncReader } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetPluginLoaderTestStateForTest } from "../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createColdPluginFixture } from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { verifySetupInferenceConfig } from "./setup-inference-turn.js";
import { createSystemAgentTestRuntime } from "./system-agent.runtime.test-support.js";

// Real setup gate, runtime, discovery worker, model resolution and HTTP inference.
// Only the external provider is synthetic; no preseeded catalog or model row.
it.each([
  { name: "runtime pin", pinned: true, listing: "ready", succeeds: true },
  { name: "implicit runtime", pinned: false, listing: "ready", succeeds: true },
  { name: "empty account listing", pinned: true, listing: "empty", succeeds: false },
  { name: "failed account listing", pinned: true, listing: "failed", succeeds: false },
  { name: "cancelled account listing", pinned: true, listing: "cancelled", succeeds: false },
] as const)("checks setup against a cold catalog: $name", async ({ pinned, listing, succeeds }) => {
  await withOpenClawTestState(
    { label: "setup-cold-catalog", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
    async (state) => {
      const requests: string[] = [];
      const credentials: Array<string | undefined> = [];
      const inferenceBodies: unknown[] = [];
      const catalogStarted = createDeferred();
      const catalogClosed = createDeferred();
      const server = await reserveTestPortListener({
        offsets: [0],
        createListener: () =>
          http.createServer((request, response) => {
            void (async () => {
              requests.push(`${request.method} ${request.url}`);
              credentials.push(request.headers.authorization);
              if (request.url === "/models") {
                if (listing === "cancelled") {
                  response.once("close", () => catalogClosed.resolve());
                  catalogStarted.resolve();
                  return;
                }
                if (listing === "failed") {
                  response.writeHead(503);
                  response.end("catalog unavailable");
                  return;
                }
                if (listing === "empty") {
                  response.setHeader("content-type", "application/json");
                  response.end("[]");
                  return;
                }
                response.setHeader("content-type", "application/json");
                response.end(
                  JSON.stringify([
                    {
                      id: "account-only-model",
                      name: "Account model",
                      contextWindow: 32768,
                      maxTokens: 1024,
                      reasoning: false,
                      input: ["text"],
                      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    },
                  ]),
                );
                return;
              }
              const chunks: Buffer[] = [];
              for await (const chunk of request) {
                chunks.push(Buffer.from(chunk));
              }
              const body = JSON.parse(Buffer.concat(chunks).toString());
              inferenceBodies.push(body);
              response.writeHead(200, { "content-type": "text/event-stream" });
              const chunk = {
                id: "setup-proof",
                object: "chat.completion.chunk",
                created: 0,
                model: body.model,
                choices: [
                  { index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null },
                ],
              };
              const stop = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
              response.end(
                [
                  "data: " + JSON.stringify(chunk),
                  "data: " + JSON.stringify(stop),
                  "data: [DONE]",
                  "",
                ].join("\n\n"),
              );
            })().catch((error: unknown) => {
              response.destroy(error instanceof Error ? error : new Error(String(error)));
            });
          }),
      });
      try {
        const baseUrl = "http://127.0.0.1:" + server.claim.port;
        const pluginDir = state.path("provider");
        await fs.mkdir(pluginDir);
        const fixture = createColdPluginFixture({
          rootDir: pluginDir,
          pluginId: "setup-provider",
          providerId: "setup-provider",
          manifest: { modelCatalog: { discovery: { "setup-provider": "refreshable" } } },
        });
        await fs.writeFile(
          fixture.runtimeSource,
          [
            'module.exports = { id: "setup-provider", register(api) {',
            'api.registerProvider({ id: "setup-provider", label: "Setup provider", auth: [],',
            'catalog: { order: "simple", run: async (ctx) => {',
            'const auth = ctx.resolveProviderAuth("setup-provider");',
            "const response = await fetch(" +
              JSON.stringify(baseUrl + "/models") +
              ', { headers: { Authorization: "Bearer " + auth.apiKey }, signal: ctx.signal });',
            'if (!response.ok) return { providers: {}, outcomes: [{ provider: "setup-provider", status: "unavailable", profileId: auth.profileId }] };',
            "const models = await response.json();",
            'return { provider: { api: "openai-completions", baseUrl: ' +
              JSON.stringify(baseUrl) +
              ", models },",
            'outcomes: [{ provider: "setup-provider", status: "ready", profileId: auth.profileId }] };',
            "} } }); } };",
          ].join("\n"),
        );
        const config: OpenClawConfig = {
          agents: {
            entries: { main: { workspace: state.workspaceDir } },
            defaults: {
              model: "setup-provider/account-only-model",
              ...(pinned
                ? {
                    models: {
                      "setup-provider/account-only-model": { agentRuntime: { id: "openclaw" } },
                    },
                  }
                : {}),
            },
          },
          plugins: {
            allow: ["setup-provider"],
            load: { paths: [pluginDir] },
            entries: { "setup-provider": { enabled: true } },
            slots: { memory: "none" },
          },
        };
        await state.writeConfig(config);
        await state.writeAuthProfiles({
          version: 1,
          profiles: {
            "setup-provider:test": {
              type: "api_key",
              provider: "setup-provider",
              key: "synthetic-setup-key",
            },
          },
        });
        const beforeConfig = await fs.readFile(state.configPath, "utf8");
        expect(await loadPersistedPluginModelCatalogs(state.agentDir())).toEqual([]);
        const { runtime, lines } = createSystemAgentTestRuntime();
        const exits: number[] = [];
        runtime.exit = (code) => {
          exits.push(code);
        };
        if (listing === "cancelled") {
          await captureRuntimeConfigAsyncReader()();
          const controller = new AbortController();
          const probe = verifySetupInferenceConfig({ config, runtime, signal: controller.signal });
          await awaitGateBeforeSettlement(
            catalogStarted.promise,
            probe.then((result) => {
              if (!result.ok) {
                throw new Error(result.error);
              }
            }),
            "Probe ended before discovery",
          );
          controller.abort();
          expect(await probe).toMatchObject({ ok: false });
          await catalogClosed.promise;
        } else {
          await runSystemAgentWithInference(
            { message: "Reply exactly OK. Do not change settings or call tools.", json: true },
            runtime,
          );
          if (succeeds) {
            expect(exits, lines.join("\n")).not.toContain(1);
          } else {
            expect(exits).toContain(1);
            expect(lines.join("\n")).toContain("Unknown model: setup-provider/account-only-model");
          }
        }
        expect(requests).toEqual(
          succeeds ? ["GET /models", "POST /chat/completions"] : ["GET /models"],
        );
        expect(inferenceBodies).toEqual(
          succeeds ? [expect.objectContaining({ model: "account-only-model" })] : [],
        );
        expect(credentials).toEqual(requests.map(() => "Bearer synthetic-setup-key"));
        expect(await loadPersistedPluginModelCatalogs(state.agentDir())).toEqual([]);
        expect(await fs.readFile(state.configPath, "utf8")).toBe(beforeConfig);
      } finally {
        await resetPreparedModelRuntimeSnapshotsForTest();
        clearPluginMetadataLifecycleCaches();
        resetPluginLoaderTestStateForTest();
        await server.releaseListener();
        await server.claim.release();
      }
    },
  );
});
