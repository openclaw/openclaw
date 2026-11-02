import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import baseten from "../extensions/baseten/index.js";
import { trackDecisionUsage } from "../src/agents/decision-inference.test-support.js";
import { acquireAgentRunPreparedModelRuntime } from "../src/agents/prepared-model-runtime.js";
import { closeProviderTransportDispatcherPool } from "../src/agents/provider-transport-dispatcher-pool.js";
import { setRuntimeConfigSnapshot } from "../src/config/runtime-snapshot.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { DecisionContractError } from "../src/decisions/contract-error.js";
import { prepareDecisionProviderReload } from "../src/decisions/provider-reload.js";
import { evaluateDecisionV2InRegistry } from "../src/decisions/runtime.js";
import type { DecisionBatchV2 } from "../src/decisions/types-v2.js";
import * as fetchGuard from "../src/infra/net/fetch-guard.js";
import { fetchWithRuntimeDispatcher } from "../src/infra/net/runtime-fetch.js";
import { createHttp1Agent } from "../src/infra/net/undici-runtime.js";
import { createPluginRuntimeMock } from "../src/plugin-sdk/test-helpers/plugin-runtime-mock.js";
import { runPluginRegisterSyncInRegistry } from "../src/plugins/loader-module-runtime.js";
import { getPluginInstance } from "../src/plugins/plugin-instance-scope.js";
import { createTestPluginRegistry } from "../src/plugins/registry-runtime.test-helpers.js";
import { setActivePluginRegistry } from "../src/plugins/runtime.js";
import { createDeferredCore } from "../src/shared/deferred.js";
import {
  admissionPlugin,
  resetAdmissionState,
  withAdmissionFixture,
} from "./decision-admission.test-support.js";

const modelId = "decision-models/baseten-elephant-9b-latest";
const profileId = "baseten:fixture";
const agentId = "decision-agent";
const nativeUrl = "https://inference.baseten.co/v1/systemone";
const input: DecisionBatchV2 = {
  state: { type: "json", value: { incident: "synthetic outage" } },
  questions: {
    urgent: { type: "boolean", instructions: "Needs review?" },
    impact: { type: "score", criteria: ["Low", { severity: "high" }] },
  },
};

it.each(["allowed", "auth-reflection", "header-reflection", "replaced", "abort-release"] as const)(
  "composes registered Baseten preparation, native HTTP and settlement (%s)",
  (change) =>
    withAdmissionFixture(
      "baseten",
      {
        model: "synthetic-native-backend",
        answers: {
          urgent: { type: "noul", noul: 0.9 },
          impact: {
            type: "score",
            score: 0.75,
            confidence: 0.8,
            probabilities: { "0": 0.25, "1": 0.75 },
            legend: { "0": "Low", "1": '{"severity":"high"}' },
          },
        },
        usage: { input_tokens: 11, output_tokens: 2 },
        ...(change === "auth-reflection" ? { diagnostic: "synthetic-replacement-secret" } : {}),
        ...(change === "header-reflection" ? { diagnostic: "synthetic-configured-secret" } : {}),
      },
      async ({ state, baseUrl, received }) => {
        const cfg: OpenClawConfig = {
          diagnostics: { enabled: true },
          agents: {
            defaults: {
              decisionModel: `baseten/${modelId}@${profileId}`,
              workspace: state.workspaceDir,
            },
            entries: { [agentId]: {} },
          },
          models: {
            providers: {
              baseten: {
                baseUrl: "https://inference.baseten.co/v1",
                models: [],
                request: {
                  auth: {
                    mode: "header",
                    headerName: "X-Fixture-Auth",
                    prefix: "Token-",
                    value: "synthetic-replacement-secret",
                  },
                  headers: { "X-Fixture-Secret": "synthetic-configured-secret" },
                },
              },
            },
          },
          plugins: {
            load: { paths: [fileURLToPath(new URL("../extensions/baseten", import.meta.url))] },
            slots: { memory: "none" },
            entries: { baseten: { enabled: true } },
          },
        };
        await state.writeAuthProfiles(
          {
            version: 1,
            profiles: {
              [profileId]: {
                type: "api_key",
                provider: "baseten",
                key: "synthetic-profile-secret",
              },
            },
          },
          agentId,
        );
        setRuntimeConfigSnapshot(cfg);
        const { metadata, record } = admissionPlugin("baseten", cfg, state.workspaceDir);
        const builder = createTestPluginRegistry(
          createPluginRuntimeMock({ config: { current: () => cfg } }),
        );
        const api = builder.createApi(record, { config: cfg });
        runPluginRegisterSyncInRegistry(baseten.register, api, builder.registry, record.id);
        builder.registry.plugins.push(record);
        setActivePluginRegistry(builder.registry);
        const controller = new AbortController();
        const dnsEntered = createDeferredCore();
        const allowDns = createDeferredCore();
        const releaseEntered = createDeferredCore();
        const allowRelease = createDeferredCore();
        const loopbackDispatcher = createHttp1Agent();
        const originalFetch = fetchGuard.fetchWithSsrFGuard;
        let admission: "unreached" | "allowed" | "rejected" = "unreached";
        let pending: Promise<unknown> | undefined;
        let settled = false;
        // Baseten uses the pooled provider transport. Forward its internal guard,
        // preserving the real pool, DNS admission and response lifecycle.
        const forwarding = vi
          .spyOn(fetchGuard, "fetchWithSsrFGuard")
          .mockImplementation(async (params) => {
            expect(params.url).toBe(nativeUrl);
            expect(params.dispatcherPool).toBeDefined();
            expect(params.maxRedirects).toBe(0);
            const guarded = await originalFetch({
              ...params,
              lookupFn: async (hostname) => {
                expect(hostname).toBe("inference.baseten.co");
                dnsEntered.resolve();
                await allowDns.promise;
                return [{ address: "93.184.216.34", family: 4 }];
              },
              beforeRequest: () => {
                try {
                  params.beforeRequest?.();
                  admission = "allowed";
                } catch (error) {
                  admission = "rejected";
                  throw error;
                }
              },
              fetchImpl: (url, init) => {
                expect(url).toBe(nativeUrl);
                // A native-host pinned dispatcher must never connect to loopback.
                return fetchWithRuntimeDispatcher(baseUrl + "/v1/systemone", {
                  ...init,
                  dispatcher: loopbackDispatcher,
                });
              },
            });
            return {
              ...guarded,
              release: async () => {
                releaseEntered.resolve();
                if (change === "abort-release") {
                  await allowRelease.promise;
                }
                await guarded.release();
              },
            };
          });
        try {
          await using prepared = await acquireAgentRunPreparedModelRuntime(
            {
              config: cfg,
              agentId,
              agentDir: state.agentDir(agentId),
              workspaceDir: state.workspaceDir,
              loadRuntimePlugins: true,
              runtimePluginPurpose: "isolated-completion",
              runtimePluginSelections: [{ provider: "baseten", modelId, agentId }],
            },
            { catalogMode: "static", pluginMetadataSnapshot: metadata },
          );
          expect(prepared.snapshot.isCurrent()).toBe(true);
          const usage = trackDecisionUsage();
          try {
            pending = evaluateDecisionV2InRegistry(
              input,
              {
                agentId,
                purpose: "owner-proof",
                rubricVersion: "1",
                timeoutMs: 5000,
                signal: controller.signal,
              },
              builder.registry,
              cfg,
            );
            const outcome = pending.then(
              (result) => ({ result }),
              (error: unknown) => ({ error }),
            );
            void outcome.then(() => {
              settled = true;
            });
            await Promise.race([
              dnsEntered.promise,
              outcome.then((value) => {
                throw new Error("Baseten settled before DNS preparation", { cause: value });
              }),
            ]);
            expect(received).toHaveLength(0);
            if (change === "replaced") {
              // Test workers persist through the fixture owner, not host-only agent admission.
              await state.writeAuthProfiles(
                {
                  version: 1,
                  profiles: {
                    [profileId]: {
                      type: "api_key",
                      provider: "baseten",
                      key: "synthetic-new-profile-secret",
                    },
                  },
                },
                agentId,
              );
            }
            allowDns.resolve();
            if (change === "abort-release") {
              await Promise.race([
                releaseEntered.promise,
                outcome.then((value) => {
                  throw new Error("Baseten settled before transport release", { cause: value });
                }),
              ]);
              // A full turn exposes an unawaited release through the complete host chain.
              await setImmediate();
              expect(settled).toBe(false);
              expect(usage).toHaveLength(0);
              expect(builder.registry.decisionProviders[0]?.host.inspect(cfg).activeRequests).toBe(
                1,
              );
              controller.abort(new Error("synthetic caller cancellation"));
              await setImmediate();
              expect(settled).toBe(false);
              expect(usage).toHaveLength(0);
              expect(builder.registry.decisionProviders[0]?.host.inspect(cfg).activeRequests).toBe(
                1,
              );
              allowRelease.resolve();
            }
            const completed = await outcome;
            if (change === "replaced") {
              expect(admission).toBe("rejected");
              expect(received).toHaveLength(0);
              expect(completed).toMatchObject({ error: new DecisionContractError() });
            } else {
              expect(admission).toBe("allowed");
              expect(received).toHaveLength(1);
              expect(received[0]).toMatchObject({
                url: "/v1/systemone",
                method: "POST",
                authorization: undefined,
                headers: {
                  "x-fixture-auth": "Token-synthetic-replacement-secret",
                  "x-fixture-secret": "synthetic-configured-secret",
                },
                body: {
                  model: modelId,
                  state: '{"incident":"synthetic outage"}',
                  questions: {
                    urgent: { type: "noul", instructions: "Needs review?" },
                    impact: { type: "score", criteria: ["Low", '{"severity":"high"}'] },
                  },
                },
              });
              if (change === "allowed") {
                expect(completed).toMatchObject({
                  result: {
                    status: "ok",
                    result: {
                      model: "synthetic-native-backend",
                      answers: {
                        urgent: { type: "boolean", probabilityTrue: 0.9 },
                        impact: { type: "score", score: 0.75 },
                      },
                      usage: { inputTokens: 11, outputTokens: 2 },
                    },
                  },
                });
                expect(usage).toMatchObject([
                  { provider: "baseten", model: modelId, usage: { input: 11, output: 2 } },
                ]);
              } else if (change === "abort-release") {
                assert("error" in completed);
                expect(completed.error).toBe(controller.signal.reason);
              } else {
                expect(completed).toMatchObject({
                  result: { status: "unavailable", reason: "invalid-response" },
                });
              }
            }
            expect(usage).toHaveLength(change === "allowed" ? 1 : 0);
            expect(builder.registry.decisionProviders[0]?.host.inspect(cfg).activeRequests).toBe(0);
          } finally {
            // Unblock physical work before the prepared handle begins disposal.
            allowDns.resolve();
            allowRelease.resolve();
            controller.abort();
            await pending?.catch(() => undefined);
          }
        } finally {
          forwarding.mockRestore();
          prepareDecisionProviderReload(builder.registry, new Set([record.id]));
          await getPluginInstance(record)?.dispose();
          await closeProviderTransportDispatcherPool();
          await loopbackDispatcher.close();
          await resetAdmissionState(true);
        }
      },
    ),
);
