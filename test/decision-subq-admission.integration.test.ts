import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";
import { expect, it, vi, type MockInstance } from "vitest";
import subq from "../extensions/subq/index.js";
import { createAdmittedRunOperatorAuthority } from "../src/agents/admitted-run-context.js";
import { prepareOperatorModelPolicy } from "../src/agents/operator-model-policy.js";
import { parseDecisionEvaluateInput } from "../src/agents/tools/decision-tool-contract.js";
import { createDecisionTool } from "../src/agents/tools/decision-tool.js";
import { withGatewayToolCallerIdentity } from "../src/agents/tools/gateway-caller-context.js";
import { resolveConfigWidePluginManifestRegistry } from "../src/config/io.plugin-metadata.js";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
} from "../src/config/runtime-snapshot.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import {
  evaluateDecisionInRegistry,
  inspectDecisionProviders,
  prepareDecisionProviderReload,
} from "../src/decisions/runtime.js";
import type { DecisionBatch } from "../src/decisions/types.js";
import { validateDecisionResultV2 } from "../src/decisions/validation-v2.js";
import { fetchWithRuntimeDispatcher } from "../src/infra/net/runtime-fetch.js";
import { createHttp1Agent } from "../src/infra/net/undici-runtime.js";
import { withServer } from "../src/plugin-sdk/test-helpers/http-test-server.js";
import { runPluginRegisterSyncInRegistry } from "../src/plugins/loader-module-runtime.js";
import { createPluginRecord } from "../src/plugins/loader-records.js";
import { resetPluginLoaderTestStateForTest } from "../src/plugins/loader.test-fixtures.js";
import { getPluginInstance } from "../src/plugins/plugin-instance-scope.js";
import { clearPluginMetadataLifecycleCaches } from "../src/plugins/plugin-metadata-lifecycle.js";
import { resolvePluginMetadataSnapshot } from "../src/plugins/plugin-metadata-snapshot.js";
import { createRuntimeTestRegistry } from "../src/plugins/registry-runtime.test-helpers.js";
import { setActivePluginRegistry } from "../src/plugins/runtime.js";
import { createPluginRuntime } from "../src/plugins/runtime/index.js";
import { createColdPluginHermeticEnv } from "../src/plugins/test-helpers/cold-plugin-fixtures.js";
import {
  activateSecretsRuntimeSnapshot,
  clearSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshotRevision,
  prepareSecretsRuntimeSnapshot,
} from "../src/secrets/runtime.js";
import { createDeferredCore } from "../src/shared/deferred.js";
import { withEnvAsync } from "../src/test-utils/env.js";
import { createOpenClawTestState } from "../src/test-utils/openclaw-test-state.js";
import { VERSION } from "../src/version.js";

const batch: DecisionBatch = {
  state: "Service is down",
  questions: {
    urgent: { type: "boolean" },
    route: { type: "choice", criteria: { support: "Service failures", sales: null } },
    impact: { type: "score", criteria: ["Low", "High"] },
  },
};
const nativeUrl = "https://api.subq.ai/v1/systemone";

const changes = [
  "allowed",
  "model-denied",
  "consumer-revoked",
  "core-allowed",
  "secret-replaced",
  "secret-removed",
] as const;

it.each(changes)(
  "checks the real SubQ host authority and final network dispatch after DNS preparation (%s)",
  async (change) => {
    const state = await createOpenClawTestState({ label: "subq-authority", applyEnv: false });
    const emptyBundled = state.path("bundled");
    const received: Array<{ method?: string; authorization?: string; body: unknown }> = [];
    fs.mkdirSync(emptyBundled);
    try {
      await withServer(
        (request, response) => {
          const incoming = {
            method: request.method,
            authorization: request.headers.authorization,
            body: undefined as unknown,
          };
          received.push(incoming);
          const chunks: Buffer[] = [];
          request.on("data", (chunk: Buffer) => chunks.push(chunk));
          request.on("end", () => {
            incoming.body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            response.setHeader("content-type", "application/json");
            response.end(
              JSON.stringify({
                model: "subq-snap-preview",
                answers: {
                  urgent: { type: "noul", noul: 0.9 },
                  route: {
                    type: "choice",
                    choice: "support",
                    probabilities: { support: 0.8, sales: 0.2 },
                  },
                  impact: {
                    type: "score",
                    score: 0.6,
                    probabilities: { "0": 0.4, "1": 0.6 },
                    legend: { "0": "Low", "1": "High" },
                  },
                },
                usage: { input_tokens: 10, output_tokens: 0 },
              }),
            );
          });
        },
        async (baseUrl) => {
          const cfg: OpenClawConfig = {
            agents: {
              defaults: { decisionModel: "subq/subq-snap-preview", workspace: state.workspaceDir },
              entries: { main: {} },
            },
            plugins: {
              load: { paths: [fileURLToPath(new URL("../extensions/subq", import.meta.url))] },
              slots: { memory: "none" },
              entries: {
                subq: {
                  enabled: true,
                  config: { apiKey: { source: "env", provider: "default", id: "SUBQ_API_KEY" } },
                },
                consumer: { enabled: true },
              },
            },
          };
          await withEnvAsync(
            {
              ...createColdPluginHermeticEnv(state.root, { bundledPluginsDir: emptyBundled }),
              ...state.envVars,
              OPENCLAW_COMPATIBILITY_HOST_VERSION: VERSION,
              OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
              SUBQ_API_KEY: "synthetic-subq-key",
              HTTP_PROXY: undefined,
              HTTPS_PROXY: undefined,
              ALL_PROXY: undefined,
              http_proxy: undefined,
              https_proxy: undefined,
              all_proxy: undefined,
            },
            async () => {
              const entered = createDeferredCore();
              const release = createDeferredCore();
              const controller = new AbortController();
              let pending: Promise<unknown> | undefined;
              let disposal:
                | ReturnType<NonNullable<ReturnType<typeof getPluginInstance>>["dispose"]>
                | undefined;
              let finalAdmission: "unreached" | "allowed" | "rejected" = "unreached";
              let builder: ReturnType<typeof createRuntimeTestRegistry> | undefined;
              let provider: ReturnType<typeof createPluginRecord> | undefined;
              let consumer: ReturnType<typeof createPluginRecord> | undefined;
              let dispatcher: ReturnType<typeof createHttp1Agent> | undefined;
              let forwarding: MockInstance<typeof ssrfRuntime.fetchWithSsrFGuard> | undefined;
              try {
                const metadata = resolvePluginMetadataSnapshot({
                  config: cfg,
                  env: process.env,
                  workspaceDir: state.workspaceDir,
                });
                const manifest = metadata.byPluginId.get("subq");
                assert(manifest);
                const snapshot = await prepareSecretsRuntimeSnapshot({
                  config: cfg,
                  env: process.env,
                  includeConfigRefs: true,
                  includeAuthStoreRefs: false,
                  manifestRegistry: resolveConfigWidePluginManifestRegistry({
                    config: cfg,
                    env: process.env,
                  }),
                });
                activateSecretsRuntimeSnapshot(snapshot);
                const secretRevision = getActiveSecretsRuntimeSnapshotRevision();
                const runtimeConfig = getRuntimeConfigSnapshot();
                assert(runtimeConfig);
                builder = createRuntimeTestRegistry(createPluginRuntime());
                provider = createPluginRecord({
                  ...manifest,
                  enabled: true,
                  configSchema: Boolean(manifest.configSchema),
                });
                const providerApi = builder.createApi(provider, { config: cfg });
                runPluginRegisterSyncInRegistry(
                  (api) => subq.register(api),
                  providerApi,
                  builder.registry,
                  provider.id,
                );
                consumer = createPluginRecord({
                  id: "consumer",
                  source: state.path("consumer.ts"),
                  origin: "global",
                  enabled: true,
                  configSchema: false,
                });
                const consumerApi = builder.createApi(consumer, { config: cfg });
                runPluginRegisterSyncInRegistry(
                  () => {},
                  consumerApi,
                  builder.registry,
                  consumer.id,
                );
                setActivePluginRegistry(builder.registry);
                const loopbackDispatcher = createHttp1Agent();
                dispatcher = loopbackDispatcher;
                const originalFetch = ssrfRuntime.fetchWithSsrFGuard;
                forwarding = vi
                  .spyOn(ssrfRuntime, "fetchWithSsrFGuard")
                  .mockImplementation((params) => {
                    expect(params.url).toBe(nativeUrl);
                    expect(params.requireHttps).toBe(true);
                    expect(params.init?.method).toBe("POST");
                    assert(params.beforeRequest);
                    // Keep native guard/admission intact. Only the final wire destination
                    // uses owned HTTP; synthetic DNS avoids external network in this owner proof.
                    return originalFetch({
                      ...params,
                      lookupFn: async (hostname) => {
                        expect(hostname).toBe("api.subq.ai");
                        entered.resolve();
                        await release.promise;
                        return [{ address: "93.184.216.34", family: 4 }];
                      },
                      beforeRequest: () => {
                        try {
                          params.beforeRequest!();
                          finalAdmission = "allowed";
                        } catch (error) {
                          finalAdmission = "rejected";
                          throw error;
                        }
                      },
                      fetchImpl: (url, init) => {
                        expect(url).toBe(nativeUrl);
                        // Never reuse the native-host pinned dispatcher for loopback.
                        return fetchWithRuntimeDispatcher(baseUrl + "/systemone", {
                          ...init,
                          dispatcher: loopbackDispatcher,
                        });
                      },
                    });
                  });
                expect(manifest.rootDir).toBe(
                  fileURLToPath(new URL("../extensions/subq", import.meta.url)),
                );
                expect(provider.source).toBe(manifest.source);
                expect(inspectDecisionProviders(cfg, builder.registry)).toEqual(
                  expect.arrayContaining([
                    expect.objectContaining({
                      providerId: "subq",
                      callable: true,
                      credentialReady: true,
                    }),
                  ]),
                );
                const authority = createAdmittedRunOperatorAuthority({
                  profileId: "decision-reader",
                  scopes: ["operator.write"],
                  assertCurrent() {},
                  modelPolicy: prepareOperatorModelPolicy({
                    cfg,
                    policy: {
                      sourceAgent: "main",
                      allow: ["subq/*"],
                      deny: change === "model-denied" ? ["subq/subq-snap-preview"] : [],
                    },
                    manifestPlugins: metadata,
                  }),
                });
                const tool = createDecisionTool("main", { config: cfg });
                assert(tool);
                const invoke: () => Promise<unknown> = () => {
                  const options = {
                    purpose: "owner-proof",
                    rubricVersion: "1",
                    timeoutMs: 5000,
                    signal: controller.signal,
                  };
                  if (
                    change === "core-allowed" ||
                    change === "secret-replaced" ||
                    change === "secret-removed"
                  ) {
                    // No caller predicate: the V1 host itself must fence changed secrets
                    // after DNS preparation, before the adapter's physical request.
                    return evaluateDecisionInRegistry(
                      batch,
                      options,
                      builder!.registry,
                      runtimeConfig,
                    );
                  }
                  return change === "consumer-revoked"
                    ? consumerApi.runtime.decisions.evaluate(batch, {
                        purpose: "owner-proof",
                        rubricVersion: "1",
                        timeoutMs: 5000,
                        signal: controller.signal,
                      })
                    : tool.execute("owner-proof", batch, controller.signal);
                };
                pending = withGatewayToolCallerIdentity(
                  {
                    agentId: "main",
                    sessionKey: "agent:main:fixture",
                    operatorAuthority: authority,
                  },
                  invoke,
                );
                const settled = pending.then(
                  (result) => ({ result }),
                  (error: unknown) => ({ error }),
                );
                if (change === "model-denied") {
                  await expect(pending).rejects.toThrow("cannot use this model");
                  expect(forwarding).not.toHaveBeenCalled();
                  expect(received).toHaveLength(0);
                } else {
                  await Promise.race([
                    entered.promise,
                    settled.then((outcome) => {
                      const detail =
                        "error" in outcome && outcome.error instanceof Error
                          ? { name: outcome.error.name, message: outcome.error.message }
                          : outcome;
                      throw new Error(
                        `SubQ settled before DNS preparation: ${JSON.stringify(detail)}`,
                      );
                    }),
                  ]);
                  expect(received).toHaveLength(0);
                  expect(getActiveSecretsRuntimeSnapshotRevision()).toBe(secretRevision);
                  if (change === "consumer-revoked") {
                    const instance = getPluginInstance(consumer);
                    assert(instance);
                    disposal = instance.dispose();
                    expect(instance.disposing).toBe(true);
                    expect(instance.acceptingCalls).toBe(false);
                    expect(instance.owner?.revoked).toBe(true);
                  } else if (change === "secret-replaced") {
                    activateSecretsRuntimeSnapshot(
                      await prepareSecretsRuntimeSnapshot({
                        config: cfg,
                        env: { ...process.env, SUBQ_API_KEY: "synthetic-subq-replacement" },
                        includeConfigRefs: true,
                        includeAuthStoreRefs: false,
                        manifestRegistry: resolveConfigWidePluginManifestRegistry({
                          config: cfg,
                          env: process.env,
                        }),
                      }),
                    );
                    expect(getActiveSecretsRuntimeSnapshotRevision()).toBeGreaterThan(
                      secretRevision,
                    );
                  } else if (change === "secret-removed") {
                    clearSecretsRuntimeSnapshot();
                    expect(getActiveSecretsRuntimeSnapshotRevision()).toBeGreaterThan(
                      secretRevision,
                    );
                  }
                  expect(controller.signal.aborted).toBe(false);
                  release.resolve();
                  const outcome = await settled;
                  expect(received).toHaveLength(
                    change === "allowed" || change === "core-allowed" ? 1 : 0,
                  );
                  expect(finalAdmission).toBe(
                    change === "allowed" || change === "core-allowed" ? "allowed" : "rejected",
                  );
                  if (change === "allowed") {
                    assert("result" in outcome);
                    const result = outcome.result as Awaited<ReturnType<typeof tool.execute>>;
                    const text = result.content[0];
                    assert(text?.type === "text");
                    const visible = JSON.parse(text.text);
                    const parsed = parseDecisionEvaluateInput(batch);
                    assert(parsed);
                    expect(visible.status).toBe("ok");
                    expect(validateDecisionResultV2(parsed, visible.result)).toBe(true);
                    expect(visible.result.usage).toEqual({ inputTokens: 10, outputTokens: 0 });
                    expect(received[0]).toMatchObject({
                      method: "POST",
                      authorization: "Bearer synthetic-subq-key",
                    });
                    expect(received[0]?.body).toMatchObject({
                      model: "subq-snap-preview",
                      questions: { urgent: { type: "noul" } },
                    });
                  } else if (change === "core-allowed") {
                    expect(outcome).toMatchObject({
                      result: {
                        status: "ok",
                        result: { answers: { urgent: { type: "boolean" } } },
                      },
                    });
                    expect(received[0]?.authorization).toBe("Bearer synthetic-subq-key");
                  } else if (change === "consumer-revoked") {
                    expect(outcome).toHaveProperty("error");
                    expect(await disposal).toEqual({ errors: [] });
                  } else {
                    expect(outcome).toEqual({
                      result: { status: "unavailable", reason: "retiring" },
                    });
                  }
                }
                expect(inspectDecisionProviders(cfg, builder.registry)[0]).toMatchObject({
                  callable: change !== "secret-removed",
                  credentialReady: change !== "secret-removed",
                  activeRequests: 0,
                });
                console.info(JSON.stringify({ change, finalAdmission, requests: received.length }));
              } finally {
                release.resolve();
                controller.abort();
                await pending?.catch(() => undefined);
                await disposal;
                forwarding?.mockRestore();
                if (consumer) {
                  await getPluginInstance(consumer)?.dispose();
                }
                if (builder && provider) {
                  prepareDecisionProviderReload(builder.registry, new Set([provider.id]));
                  await getPluginInstance(provider)?.dispose();
                }
                await dispatcher?.close();
                clearSecretsRuntimeSnapshot();
                clearPluginMetadataLifecycleCaches();
                resetPluginLoaderTestStateForTest();
                clearRuntimeConfigSnapshot();
              }
            },
          );
        },
      );
    } finally {
      await state.cleanup();
    }
  },
);
