import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import * as codexPluginModule from "../../extensions/codex/index.js";
import type { ModelsListResult } from "../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { prepareModelCatalogView } from "../../src/agents/model-catalog-view.js";
import { getPublishedPreparedModelCatalogOwnerSnapshot } from "../../src/agents/prepared-model-catalog.js";
import { getRuntimeConfig } from "../../src/config/config.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import {
  listModels,
  WITHOUT_OPENAI_ENV_AUTH,
} from "../../src/gateway/server-methods/models-list-result.openai-routes.test-support.js";
import {
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../../src/gateway/test-helpers.e2e.js";
import { loadManifestMetadataSnapshot } from "../../src/plugins/manifest-contract-eligibility.js";
import * as pluginModuleLoader from "../../src/plugins/plugin-module-loader-cache.js";
import { createEmptyPluginRegistry } from "../../src/plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../src/plugins/runtime.js";
import { withEnvAsync } from "../../src/test-utils/env.js";
import { withOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";

describe("models.list native account catalog", () => {
  afterEach(() => vi.restoreAllMocks());
  it("models.list selects a native user-home API-key catalog through the prepared Gateway owner", async (ctx) => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "native-catalog-" },
      async (state) => {
        await withEnvAsync(
          {
            ...WITHOUT_OPENAI_ENV_AUTH,
            CODEX_HOME: `${state.home}/codex`,
            SYNTHETIC_ABSENT_KEY: undefined,
            OPENCLAW_SKIP_CHANNELS: "1",
            OPENCLAW_SKIP_GMAIL_WATCHER: "1",
            OPENCLAW_SKIP_CRON: "1",
            OPENCLAW_SKIP_CANVAS_HOST: "1",
            OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          },
          async () => {
            // macOS Unix sockets have a short path limit; keep them outside the state fixture.
            const socketDir = await mkdtemp(
              path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "oc-catalog-"),
            );
            const socketPath =
              process.platform === "win32"
                ? `\\\\.\\pipe\\${path.basename(socketDir)}`
                : path.join(socketDir, "s");
            const httpServer = createServer();
            const server = new WebSocketServer({ server: httpServer });
            ctx.onTestFinished(async () => {
              for (const socket of server.clients) {
                socket.terminate();
              }
              await new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
              });
              await new Promise<void>((resolve) => {
                httpServer.close(() => resolve());
              });
              await rm(socketDir, { recursive: true, force: true });
            });
            const requests: string[] = [];
            let account: Record<string, unknown> | null = { type: "apiKey" };
            server.on("connection", (socket) => {
              socket.on("message", (data) => {
                const encoded = Array.isArray(data)
                  ? Buffer.concat(data)
                  : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
                const request = JSON.parse(encoded.toString("utf8")) as {
                  id?: number;
                  method: string;
                };
                requests.push(request.method);
                if (request.id !== undefined) {
                  const result =
                    request.method === "initialize"
                      ? { userAgent: "openclaw/0.149.1 (test)" }
                      : request.method === "account/read"
                        ? { account, requiresOpenaiAuth: true }
                        : request.method === "model/list"
                          ? {
                              data: [
                                {
                                  id: "synthetic-opaque",
                                  model: "synthetic-opaque",
                                  displayName: "Synthetic name",
                                  description: "Synthetic model",
                                  supportsPersonality: false,
                                  inputModalities: ["text"],
                                  supportedReasoningEfforts: [
                                    { reasoningEffort: "low", description: "Low" },
                                  ],
                                  defaultReasoningEffort: "low",
                                  hidden: false,
                                  isDefault: true,
                                },
                              ],
                              nextCursor: null,
                            }
                          : {};
                  socket.send(JSON.stringify({ id: request.id, result }));
                }
              });
            });
            httpServer.listen(socketPath);
            await once(server, "listening");
            const token = "native-catalog-gateway-token";
            let config: OpenClawConfig = {
              gateway: { mode: "local", auth: { mode: "token", token } },
              agents: {
                defaults: {
                  workspace: state.workspaceDir,
                  model: "openai/synthetic-opaque",
                  models: { "openai/synthetic-opaque": { agentRuntime: { id: "codex" } } },
                },
              },
              plugins: {
                allow: ["codex", "openai"],
                slots: { memory: "none" },
                entries: {
                  codex: {
                    enabled: true,
                    config: {
                      appServer: {
                        transport: "unix",
                        url: `unix://${socketPath}`,
                        homeScope: "user",
                        approvalPolicy: "on-request",
                        sandbox: "workspace-write",
                      },
                      computerUse: { enabled: false },
                    },
                  },
                },
              },
            };
            const codexRoot = fileURLToPath(new URL("../../extensions/codex/", import.meta.url));
            const bundledModules = new Map<string, unknown>([
              [path.join(codexRoot, "index.ts"), codexPluginModule],
            ]);
            const actualModuleLoader = pluginModuleLoader.getCachedPluginModuleLoader;
            // Keep real bundled modules in the host graph; the Gateway still owns registration.
            vi.spyOn(pluginModuleLoader, "getCachedPluginModuleLoader").mockImplementation(
              (params) => {
                const load = actualModuleLoader(params);
                return (target) => {
                  const modulePath = target.startsWith("file:")
                    ? fileURLToPath(target)
                    : path.resolve(target);
                  return bundledModules.has(modulePath)
                    ? bundledModules.get(modulePath)
                    : load(target);
                };
              },
            );
            await state.writeConfig(config);
            const gateway = await startGatewayWithClient({
              cfg: config,
              configPath: state.configPath,
              token,
              scopes: ["operator.admin"],
            });
            try {
              await gateway.server.startupSettled;
              const registeredList = (refresh = false) =>
                gateway.client.request<ModelsListResult>("models.list", {
                  agentId: "main",
                  view: "all",
                  refresh,
                  ...(refresh ? { provider: "openai" } : {}),
                });
              await expect
                .poll(
                  async () =>
                    (await registeredList()).models.find((row) => row.id === "synthetic-opaque")
                      ?.available,
                  { timeout: 15_000 },
                )
                .toBe(true);
              await expect
                .poll(async () => (await registeredList()).pendingProviders ?? [], {
                  timeout: 15_000,
                })
                .not.toContain("openai");
              const owner = getPublishedPreparedModelCatalogOwnerSnapshot({
                agentId: "main",
                config: getRuntimeConfig(),
              });
              const registry = owner?.pluginRegistry;
              const harness = registry?.agentHarnesses.find(
                (entry) => entry.harness.id === "codex",
              )?.harness;
              if (!owner || !registry || !harness?.loadModelCatalog) {
                throw new Error("Gateway did not publish the bundled native harness owner");
              }
              config = owner.observationConfig;
              const scope = {
                config,
                agentId: "main",
                agentDir: state.agentDir(),
                workspaceDir: state.workspaceDir,
              };
              const loadCatalog = harness.loadModelCatalog.bind(harness);
              const previous = captureActivePluginRegistrySnapshot();
              try {
                const result = await registeredList();
                expect(result.models).toEqual(
                  expect.arrayContaining([
                    expect.objectContaining({
                      id: "synthetic-opaque",
                      name: "Synthetic name",
                      available: true,
                      reasoning: true,
                    }),
                  ]),
                );
                expect(requests).toContain("account/read");
                expect(requests).not.toContain("account/login/start");
                const rows =
                  owner
                    .readFullModelCatalog?.()
                    ?.entries.filter((row) => row.id === "synthetic-opaque") ?? [];
                expect(rows[0]).toMatchObject({ nativeRuntime: "codex", name: "Synthetic name" });
                expect(rows[0]).not.toHaveProperty("api");
                expect(rows[0]).not.toHaveProperty("baseUrl");
                expect(
                  result.models.find((row) => row.id === "synthetic-opaque"),
                ).not.toHaveProperty("nativeRuntime");
                const readiness = (cfg = config) =>
                  harness.readModelCatalogReadiness?.({
                    ...scope,
                    config: cfg,
                    provider: "openai",
                    modelId: "synthetic-opaque",
                  });
                expect(readiness()).toEqual({ accountType: "apiKey", authMode: "api_key" });
                const configured = (cfg = config) =>
                  listModels({
                    ...scope,
                    pluginRegistry: registry,
                    cfg,
                    catalog: structuredClone(rows),
                    view: "configured",
                    preparedOnly: true,
                  });
                const calls = requests.length;
                expect((await configured()).models[0]?.available).toBe(true);
                expect(requests).toHaveLength(calls);
                expect((await configured({ ...config })).models[0]?.available).toBe(false);

                for (const socket of server.clients) {
                  socket.send(
                    JSON.stringify({ method: "account/updated", params: { authMode: null } }),
                  );
                }
                await expect.poll(() => readiness()).toBeUndefined();
                expect((await configured()).models[0]?.available).toBe(false);
                for (const observed of [
                  {
                    value: { type: "chatgpt", email: "synthetic@example.test", planType: "plus" },
                    readiness: { accountType: "chatgpt" },
                    available: true,
                  },
                  { value: null, readiness: undefined, available: false },
                  {
                    value: { type: "apiKey" },
                    readiness: { accountType: "apiKey", authMode: "api_key" },
                    available: true,
                  },
                ]) {
                  account = observed.value;
                  const beforeModels = requests.filter((method) => method === "model/list").length;
                  await registeredList(true);
                  await expect
                    .poll(() => requests.filter((method) => method === "model/list").length, {
                      timeout: 15_000,
                    })
                    .toBeGreaterThan(beforeModels);
                  await expect
                    .poll(async () => (await registeredList()).pendingProviders ?? [], {
                      timeout: 15_000,
                    })
                    .not.toContain("openai");
                  await expect
                    .poll(() => readiness(), { timeout: 15_000 })
                    .toEqual(observed.readiness);
                  await expect
                    .poll(
                      async () =>
                        (await registeredList()).models.find((row) => row.id === "synthetic-opaque")
                          ?.available,
                      { timeout: 15_000 },
                    )
                    .toBe(observed.available);
                }
                const hostRoutes: OpenClawConfig["models"][] = [
                  {
                    providers: {
                      openai: {
                        api: "openai-responses",
                        baseUrl: "https://host.example.test/v1",
                        models: [],
                      },
                    },
                  },
                  {
                    providers: {
                      openai: {
                        baseUrl: "",
                        models: [
                          {
                            id: " openai/synthetic-opaque ",
                            name: "Synthetic name",
                            api: "openai-responses",
                            baseUrl: "https://host.example.test/v1",
                            reasoning: true,
                            input: ["text"],
                            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                            maxTokens: 100,
                          },
                        ],
                      },
                    },
                  },
                  {
                    providers: {
                      openai: {
                        baseUrl: "",
                        apiKey: { source: "env", provider: "default", id: "SYNTHETIC_ABSENT_KEY" },
                        models: [],
                      },
                    },
                  },
                ];
                for (const [routeIndex, models] of hostRoutes.entries()) {
                  const hostConfig = { ...config, models };
                  await loadCatalog({ ...scope, config: hostConfig });
                  const host = await listModels({
                    ...scope,
                    pluginRegistry: registry,
                    cfg: hostConfig,
                    catalog: rows,
                    view: "configured",
                    preparedOnly: true,
                  });
                  expect(readiness(hostConfig)).toEqual({
                    accountType: "apiKey",
                    authMode: "api_key",
                  });
                  expect(host.models[0]?.available, `host route ${routeIndex}`).toBe(false);
                }
                expect(requests).not.toContain("account/login/start");
                for (const socket of server.clients) {
                  socket.close();
                }
                await expect.poll(() => readiness()).toBeUndefined();
                expect((await configured()).models[0]?.available).toBe(false);
                const snapshot = { entries: rows, routeVariants: rows };
                const nativeView = prepareModelCatalogView({
                  ...scope,
                  cfg: config,
                  snapshot,
                  metadataSnapshot: loadManifestMetadataSnapshot({ config, env: process.env }),
                });
                expect(
                  nativeView.evaluateNative(rows[0]!, {
                    availability: true,
                    selectedAuthMode: "oauth",
                    evidence: "runtime",
                    routeResolution: null,
                  }).availability,
                ).toBe(false);
                const hostRow = { ...rows[0]! };
                delete hostRow.nativeRuntime;
                const hostEvidence = {
                  availability: true,
                  selectedAuthMode: "oauth",
                  evidence: "runtime" as const,
                  routeResolution: null,
                };
                expect(nativeView.evaluateNative(hostRow, hostEvidence)).toBe(hostEvidence);
                const replacement = createEmptyPluginRegistry();
                setActivePluginRegistry(replacement);
                expect((await configured()).models[0]?.available).toBe(false);
              } finally {
                restoreActivePluginRegistrySnapshot(previous);
              }
            } finally {
              await disconnectGatewayClient(gateway.client);
              await gateway.server.close();
            }
          },
        );
      },
    );
  }, 120_000);
});
