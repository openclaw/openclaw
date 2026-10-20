import assert from "node:assert/strict";
import dns from "node:dns/promises";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";
import { expect, it, vi } from "vitest";
import levanto from "../extensions/levanto/index.js";
import { removeAuthProfilesAcrossOwnerStores } from "../src/agents/auth-profiles/profiles.js";
import { upsertAuthProfileWithLockOrThrow } from "../src/agents/auth-profiles/upsert-with-lock.js";
import * as modelAuthProvider from "../src/agents/model-auth-provider.js";
import { acquireAgentRunPreparedModelRuntime } from "../src/agents/prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../src/agents/prepared-model-runtime.test-support.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../src/config/runtime-snapshot.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import {
  evaluateDecisionV2InRegistry,
  prepareDecisionProviderReload,
} from "../src/decisions/runtime.js";
import type { DecisionBatchV2 } from "../src/decisions/types-v2.js";
import { DecisionContractError } from "../src/decisions/validation.js";
import { getImageMetadata } from "../src/media/media-services.js";
import { withServer } from "../src/plugin-sdk/test-helpers/http-test-server.js";
import { createPluginRuntimeMock } from "../src/plugin-sdk/test-helpers/plugin-runtime-mock.js";
import { runPluginRegisterSyncInRegistry } from "../src/plugins/loader-module-runtime.js";
import { createPluginRecord } from "../src/plugins/loader-records.js";
import { resetPluginLoaderTestStateForTest } from "../src/plugins/loader.test-fixtures.js";
import { getPluginInstance } from "../src/plugins/plugin-instance-scope.js";
import { clearPluginMetadataLifecycleCaches } from "../src/plugins/plugin-metadata-lifecycle.js";
import { resolvePluginMetadataSnapshot } from "../src/plugins/plugin-metadata-snapshot.js";
import { createTestPluginRegistry } from "../src/plugins/registry-runtime.test-helpers.js";
import { setActivePluginRegistry } from "../src/plugins/runtime.js";
import { createColdPluginHermeticEnv } from "../src/plugins/test-helpers/cold-plugin-fixtures.js";
import { createDeferredCore } from "../src/shared/deferred.js";
import { withEnvAsync } from "../src/test-utils/env.js";
import { createOpenClawTestState } from "../src/test-utils/openclaw-test-state.js";
import { VERSION } from "../src/version.js";

it.each(["allowed", "revoked", "replaced", "image-allowed", "box-unsupported"] as const)(
  "checks the registered Sage capability and credential owner before final HTTP (%s)",
  async (change) => {
    const state = await createOpenClawTestState({ label: "sage-authority", applyEnv: false });
    const agentId = "decision-agent";
    const agentDir = state.agentDir(agentId);
    const profileId = "levanto:fixture";
    const emptyBundled = state.path("bundled");
    const received: Array<{ url?: string; authorization?: string; body: unknown }> = [];
    try {
      fs.mkdirSync(emptyBundled);
      await state.writeAuthProfiles(
        {
          version: 1,
          profiles: {
            [profileId]: { type: "api_key", provider: "levanto", key: "synthetic-sage-key" },
          },
        },
        agentId,
      );
      await withServer(
        (request, response) => {
          const incoming = {
            url: request.url,
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
                id: "q",
                kind: "yesno",
                result: { answer: "yes", probability: 0.9 },
                meta: { model: "levanto-sage", usage: { input_tokens: 5, output_tokens: 1 } },
              }),
            );
          });
        },
        async (baseUrl) => {
          const cfg: OpenClawConfig = {
            agents: {
              defaults: {
                model: "unrelated/not-configured",
                decisionModel: `levanto/levanto-sage@${profileId}`,
                workspace: state.workspaceDir,
              },
              entries: { [agentId]: {} },
            },
            models: {
              providers: {
                levanto: {
                  baseUrl: "https://sage.levanto.ai",
                  models: [],
                  request: { allowPrivateNetwork: true },
                },
              },
            },
            plugins: {
              load: { paths: [fileURLToPath(new URL("../extensions/levanto", import.meta.url))] },
              slots: { memory: "none" },
              entries: { levanto: { enabled: true } },
            },
          };
          await withEnvAsync(
            {
              ...createColdPluginHermeticEnv(state.root, { bundledPluginsDir: emptyBundled }),
              ...state.envVars,
              OPENCLAW_COMPATIBILITY_HOST_VERSION: VERSION,
              OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
              LEVANTO_API_KEY: undefined,
              HTTP_PROXY: undefined,
              HTTPS_PROXY: undefined,
              ALL_PROXY: undefined,
              http_proxy: undefined,
              https_proxy: undefined,
              all_proxy: undefined,
            },
            async () => {
              setRuntimeConfigSnapshot(cfg);
              const metadata = resolvePluginMetadataSnapshot({
                config: cfg,
                env: process.env,
                workspaceDir: state.workspaceDir,
              });
              const manifest = metadata.byPluginId.get("levanto");
              assert(manifest);
              const builder = createTestPluginRegistry(
                createPluginRuntimeMock({ config: { current: () => cfg } }),
              );
              const record = createPluginRecord({
                ...manifest,
                enabled: true,
                configSchema: Boolean(manifest.configSchema),
              });
              const api = builder.createApi(record, { config: cfg });
              runPluginRegisterSyncInRegistry(
                (registration) => levanto.register(registration),
                api,
                builder.registry,
                record.id,
              );
              builder.registry.plugins.push(record);
              setActivePluginRegistry(builder.registry);
              try {
                // Keep the actual source identity and prepared auth/catalog owner;
                // Vitest imports only make the forwarding DNS barrier observable.
                await using prepared = await acquireAgentRunPreparedModelRuntime(
                  {
                    config: cfg,
                    agentId,
                    agentDir,
                    workspaceDir: state.workspaceDir,
                    loadRuntimePlugins: true,
                    runtimePluginSelections: [
                      { provider: "levanto", modelId: "levanto-sage", agentId },
                    ],
                  },
                  { catalogMode: "static", pluginMetadataSnapshot: metadata },
                );
                expect(prepared.snapshot.pluginRegistry?.providers).toEqual(
                  expect.arrayContaining([
                    expect.objectContaining({ pluginId: record.id, source: record.source }),
                  ]),
                );
                expect(prepared.snapshot.modelCatalog.entries).toEqual(
                  expect.arrayContaining([
                    expect.objectContaining({ provider: "levanto", id: "levanto-sage" }),
                  ]),
                );
                const entered = createDeferredCore();
                const release = createDeferredCore();
                const controller = new AbortController();
                const supported = change === "allowed" || change === "image-allowed";
                const auth = vi.spyOn(modelAuthProvider, "resolveApiKeyForProviderCore");
                const probe = vi
                  .spyOn(api.runtime.media, "getImageMetadata")
                  .mockImplementation(getImageMetadata);
                const registered = builder.registry.decisionProviders[0]?.host.provider;
                assert(registered?.contractVersion === 2);
                const adapter = vi.spyOn(registered, "evaluate");
                const originalFetch = ssrfRuntime.fetchWithSsrFGuard;
                let finalAdmission: "unreached" | "allowed" | "rejected" = "unreached";
                const forwarding = vi
                  .spyOn(ssrfRuntime, "fetchWithSsrFGuard")
                  .mockImplementation((params) => {
                    expect(params.url).toBe("https://sage.levanto.ai/decide");
                    expect(params.init?.method).toBe("POST");
                    expect(params.beforeRequest).toBeTypeOf("function");
                    // Substitute only the fixture wire destination. The native catalog,
                    // credential owner, original guard and final admission remain real.
                    return originalFetch({
                      ...params,
                      url: baseUrl + "/decide",
                      lookupFn: async (hostname, options) => {
                        entered.resolve();
                        await release.promise;
                        return dns.lookup(hostname, options);
                      },
                      beforeRequest: () => {
                        try {
                          params.beforeRequest?.();
                          finalAdmission = "allowed";
                        } catch (error) {
                          finalAdmission = "rejected";
                          throw error;
                        }
                      },
                    });
                  });
                const input: DecisionBatchV2 = {
                  state:
                    change === "image-allowed" || change === "box-unsupported"
                      ? {
                          type: "image",
                          dataUri:
                            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAK0lEQVR4nO3OIQEAAAwEoetfeovxBoGnq1tKQEBAQEBAQEBAQEBAQEBgHXhUDfhqRFDd3gAAAABJRU5ErkJggg==",
                        }
                      : { type: "text", text: "synthetic evidence" },
                  questions: {
                    q:
                      change === "box-unsupported"
                        ? { type: "box", instructions: "the red square" }
                        : { type: "boolean", instructions: "Needs review?" },
                  },
                };
                const pending = evaluateDecisionV2InRegistry(
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
                const settled = pending.then(
                  (result) => ({ result }),
                  (error: unknown) => ({ error }),
                );
                try {
                  if (change === "box-unsupported") {
                    await expect(pending).resolves.toMatchObject({
                      status: "unavailable",
                      reason: "unsupported-input",
                    });
                    expect(auth).not.toHaveBeenCalled();
                    expect(adapter).not.toHaveBeenCalled();
                    expect(probe).not.toHaveBeenCalled();
                    expect(forwarding).not.toHaveBeenCalled();
                    expect(received).toHaveLength(0);
                    return;
                  }
                  await Promise.race([
                    entered.promise,
                    settled.then((outcome) => {
                      throw new Error(
                        `Sage settled before DNS preparation: ${JSON.stringify(outcome)}`,
                      );
                    }),
                  ]);
                  expect(auth).toHaveBeenCalledOnce();
                  expect(adapter).toHaveBeenCalledOnce();
                  expect(probe).toHaveBeenCalledTimes(change === "image-allowed" ? 1 : 0);
                  expect(received).toHaveLength(0);
                  expect(prepared.snapshot.isCurrent()).toBe(true);
                  if (change === "revoked") {
                    expect(
                      await removeAuthProfilesAcrossOwnerStores({
                        cfg,
                        agentDir,
                        provider: "levanto",
                        profileIds: [profileId],
                      }),
                    ).toBe(true);
                  } else if (change === "replaced") {
                    await upsertAuthProfileWithLockOrThrow({
                      profileId,
                      agentDir,
                      credential: {
                        type: "api_key",
                        provider: "levanto",
                        key: "synthetic-replacement",
                      },
                    });
                  }
                  expect(prepared.snapshot.isCurrent()).toBe(supported);
                  release.resolve();
                  const outcome = await settled;
                  expect(finalAdmission).toBe(supported ? "allowed" : "rejected");
                  expect(received).toHaveLength(supported ? 1 : 0);
                  if (supported) {
                    expect(outcome).toMatchObject({
                      result: {
                        status: "ok",
                        result: {
                          answers: { q: { type: "boolean", answer: true, probabilityTrue: 0.9 } },
                          usage: { inputTokens: 5, outputTokens: 1 },
                        },
                      },
                    });
                    expect(received[0]).toMatchObject({
                      url: "/decide",
                      authorization: "Bearer synthetic-sage-key",
                    });
                    expect(received[0]?.body).not.toHaveProperty("grounding");
                  } else {
                    expect(outcome).toMatchObject({ error: new DecisionContractError() });
                  }
                  console.info(
                    JSON.stringify({
                      change,
                      generationCurrent: prepared.snapshot.isCurrent(),
                      finalAdmission,
                      requests: received.length,
                    }),
                  );
                } finally {
                  release.resolve();
                  controller.abort();
                  await settled;
                  forwarding.mockRestore();
                  adapter.mockRestore();
                  probe.mockRestore();
                  auth.mockRestore();
                }
              } finally {
                prepareDecisionProviderReload(builder.registry, new Set([record.id]));
                await getPluginInstance(record)?.dispose();
                await resetPreparedModelRuntimeSnapshotsForTest();
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
