import { Socket } from "node:net";
import { zstdDecompressSync } from "node:zlib";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../../config/config.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import { GatewayScheduler } from "../../../infra/gateway-scheduler.js";
import * as fetchGuard from "../../../infra/net/fetch-guard.js";
import {
  bindLegacyPluginSdkResourceHost,
  LegacyPluginSdkResourceHost,
} from "../../../plugins/legacy-sdk-resource-host.js";
import type { ProviderPlugin } from "../../../plugins/types.js";
import { loadBundledPluginFacade } from "../../../test-utils/bundled-plugin-public-surface.js";
import { createTestRegistry } from "../../../test-utils/channel-plugins.js";
import * as agentScope from "../../agent-scope.js";
import { setPreparedModelFullCatalogAuth } from "../../prepared-model-runtime-auth.js";
import { getPreparedModelRuntimeMocks } from "../../prepared-model-runtime.test-harness.js";
import { installSpawnAccessCodex } from "./subagent-spawn.access-codex.test-support.js";
import {
  createBoundSpawnInvocation,
  type NativePluginSpawnTestOptions,
} from "./subagent-spawn.production-boundary.test-support.js";

export function registerAccessRequestSpawnCases(
  options: NativePluginSpawnTestOptions & { parentSessionKey: string },
) {
  const cases = (["OpenClaw", "Codex"] as const).flatMap((runtimeName) =>
    (["explicit", "inherited"] as const).flatMap((selection) =>
      (["allowed", "unavailable", "revoked", "reassigned"] as const).map((outcome) => ({
        runtimeName,
        selection,
        outcome,
      })),
    ),
  );
  it.each(cases)(
    "$selection child Access at final $runtimeName submission: $outcome",
    async ({ runtimeName, selection, outcome }) => {
      const program = selection === "explicit" ? "daybreak_blue" : "daybreak_red";
      const actualScope = await vi.importActual<typeof agentScope>("../../agent-scope.js");
      const resolver = vi
        .spyOn(agentScope, "resolveSessionAgentIds")
        .mockImplementation(actualScope.resolveSessionAgentIds);
      onTestFinished(() => resolver.mockRestore());
      const bound = await options.createBoundParent();
      await upsertSessionEntryCore(
        { storePath: bound.storePath, sessionKey: options.parentSessionKey },
        { cyberAccessProgram: selection === "inherited" ? program : undefined },
      );
      const scheduler = new GatewayScheduler();
      const sdkHost = new LegacyPluginSdkResourceHost();
      sdkHost.bindScheduler(scheduler);
      bindLegacyPluginSdkResourceHost(bound.resolveGatewayContext, sdkHost);
      onTestFinished(async () => {
        await sdkHost.close();
        await scheduler.stop();
      });
      const runtimeMocks = getPreparedModelRuntimeMocks();
      Object.assign(runtimeMocks.pluginMetadataSnapshot.index, { diagnostics: [] });
      const access = [
        "fixture",
        Buffer.from(
          JSON.stringify({
            "https://api.openai.com/auth": {
              chatgpt_account_id: "account-a",
              chatgpt_user_id: "user-a",
            },
          }),
        ).toString("base64url"),
        "fixture",
      ].join(".");
      const credential = {
        type: "oauth" as const,
        provider: "openai",
        access,
        refresh: "synthetic-refresh",
        expires: Date.now() + 3600000,
        accountId: "account-a",
      };
      const model = {
        api: "openai-chatgpt-responses" as const,
        baseUrl: "https://chatgpt.com/backend-api/codex",
        id: "gpt-6.1-sol",
        name: "Synthetic Sol",
        provider: "openai",
        reasoning: true,
        input: ["text" as const],
        contextWindow: 128000,
        maxTokens: 1024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
      bound.cfg.agents!.defaults!.model = { primary: "openai/gpt-6.1-sol" };
      bound.cfg.models = {
        mode: "replace",
        providers: { openai: { api: model.api, baseUrl: model.baseUrl, models: [model] } },
      };
      bound.cfg.agents!.defaults!.models = {
        "openai/gpt-6.1-sol": runtimeName === "OpenClaw" ? { params: { transport: "sse" } } : {},
      };
      setRuntimeConfigSnapshot(bound.cfg);
      runtimeMocks.preparedAuthStore = { version: 1, profiles: { "openai:default": credential } };
      const { updateAuthProfileStoreWithLock } =
        await import("../../auth-profiles/store-runtime.js");
      expect(
        await updateAuthProfileStoreWithLock({
          agentDir: expectDefined(
            runtimeMocks.configuredAgentDirs.get("main"),
            "parent agent directory",
          ),
          saveOptions: { filterExternalAuthProfiles: false, syncExternalCli: false },
          updater: (store) => {
            store.profiles["openai:default"] = credential;
            return true;
          },
        }),
      ).not.toBeNull();
      runtimeMocks.authStorage.getAll.mockReturnValue({ openai: credential });
      const snapshot = {
        entries: [model],
        routeVariants: [model],
        providerOutcomes: [
          {
            provider: "openai",
            profileId: "openai:default",
            status: "ready" as const,
            modelAccessPrograms: [
              {
                modelId: model.id,
                runtimeId: "openclaw",
                api: model.api,
                baseUrl: model.baseUrl,
                authRequirement: "subscription" as const,
                requestTransportOverrides: "none" as const,
                cyber:
                  outcome === "unavailable"
                    ? ["standard" as const]
                    : ["standard" as const, "daybreak_blue" as const, "daybreak_red" as const],
              },
            ],
          },
        ],
      };
      setPreparedModelFullCatalogAuth(snapshot, {
        authStore: runtimeMocks.preparedAuthStore,
        authModes: { openai: "oauth" },
        providerAuthLabels: new Map(),
      });
      runtimeMocks.buildPreparedModelCatalogSnapshot.mockResolvedValue(snapshot);
      runtimeMocks.runPreparedModelCatalogWorker.mockResolvedValue(snapshot);
      const { buildOpenAIProvider } = await loadBundledPluginFacade<{
        buildOpenAIProvider: () => ProviderPlugin;
      }>({ pluginId: "openai", artifactBasename: "api.js" });
      const registry = createTestRegistry([], { config: bound.cfg });
      let capturedAttempt:
        | Parameters<
            typeof import("../../embedded-agent-runner/run/access-program.js").prepareEmbeddedAccessProgramGuard
          >[0]
        | undefined;
      let accountChanged = false;
      const provider = buildOpenAIProvider();
      const originalWrap = expectDefined(provider.wrapStreamFn, "OpenAI stream wrapper");
      provider.wrapStreamFn = (ctx) => {
        const wrapped = originalWrap(ctx) ?? ctx.streamFn;
        if (!wrapped) {
          throw new Error("OpenAI stream missing");
        }
        return (requestModel, context, streamOptions) =>
          wrapped(requestModel, context, {
            ...streamOptions,
            onPayload: async (payload, payloadModel) => {
              const transformed = await streamOptions?.onPayload?.(payload, payloadModel);
              if (outcome === "revoked") {
                const catalog = expectDefined(
                  capturedAttempt?.preparedModelRuntime?.accountCatalog,
                  "request account catalog",
                );
                catalog.reconcileAuth({ version: 1, profiles: {} }, () => true);
                accountChanged = true;
              } else if (outcome === "reassigned") {
                await expectDefined(
                  capturedAttempt?.preparedModelRuntime?.accountCatalog,
                  "request account catalog",
                ).acquire({
                  profileId: "openai:default",
                  credential: {
                    ...credential,
                    access: [
                      "fixture",
                      Buffer.from(
                        JSON.stringify({
                          "https://api.openai.com/auth": {
                            chatgpt_account_id: "account-b",
                            chatgpt_user_id: "user-b",
                          },
                        }),
                      ).toString("base64url"),
                      "fixture",
                    ].join("."),
                  },
                  allowDiscovery: true,
                  load: async () => [],
                });
                accountChanged = true;
              }
              return transformed ?? payload;
            },
          });
      };
      registry.providers.push({
        pluginId: "openai",
        provider,
        source: "bundled",
      });
      runtimeMocks.loadAgentRuntimePluginRegistryHandle.mockReturnValue(registry);
      const socketFence = vi.spyOn(Socket.prototype, "connect").mockImplementation(() => {
        throw new Error("Access proof forbids physical network connections");
      });
      onTestFinished(() => socketFence.mockRestore());
      const writes: unknown[] = [];
      const physicalFetch: typeof fetch = async (_url, init) => {
        const bytes = init?.body;
        const body =
          new Headers(init?.headers).get("content-encoding") === "zstd"
            ? zstdDecompressSync(
                expectDefined(
                  bytes instanceof Uint8Array ? bytes : undefined,
                  "compressed request body",
                ),
              ).toString("utf8")
            : expectDefined(typeof bytes === "string" ? bytes : undefined, "JSON request body");
        writes.push(JSON.parse(body));
        return new Response(
          "data: " +
            JSON.stringify({
              type: "response.completed",
              response: {
                id: "resp-access",
                status: "completed",
                output: [
                  {
                    type: "message",
                    id: "msg-access",
                    role: "assistant",
                    content: [
                      { type: "output_text", text: "Access child completed", annotations: [] },
                    ],
                  },
                ],
                usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
              },
            }) +
            "\n\n",
          { headers: { "content-type": "text/event-stream" } },
        );
      };
      const rejectedSubmissions: unknown[] = [];
      const originalFetch = fetchGuard.fetchWithSsrFGuard;
      const network = vi.spyOn(fetchGuard, "fetchWithSsrFGuard").mockImplementation((params) =>
        originalFetch({
          ...params,
          lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
          fetchImpl: (input, init) => physicalFetch(input, init),
        }).catch((error: unknown) => {
          rejectedSubmissions.push(error);
          throw error;
        }),
      );
      vi.stubGlobal("fetch", physicalFetch);
      onTestFinished(() => {
        network.mockRestore();
        vi.unstubAllGlobals();
      });
      const native =
        runtimeName === "Codex" ? await installSpawnAccessCodex(bound, outcome) : undefined;
      const { runtime, context } = await options.createBoundGateway(bound);
      await context.loadGatewayModelCatalogSnapshot({
        agentId: "main",
        readOnly: false,
      });
      const guard = await import("../../embedded-agent-runner/run/access-program.js");
      const originalGuard = guard.prepareEmbeddedAccessProgramGuard;
      const guardSpy = vi
        .spyOn(guard, "prepareEmbeddedAccessProgramGuard")
        .mockImplementation(async (params) => {
          capturedAttempt = params;
          if (outcome === "revoked") {
            // Start from a discovered account so removal invalidates its actual
            // catalog lease rather than leaving an already-cold cache unchanged.
            const profileId = expectDefined(params.authProfileId, "request auth profile");
            await expectDefined(
              params.preparedModelRuntime?.accountCatalog,
              "request account catalog",
            ).acquire({
              profileId,
              credential: expectDefined(
                params.authProfileStore?.profiles[profileId],
                "request credential",
              ),
              allowDiscovery: true,
              load: async () => snapshot.providerOutcomes,
            });
          }
          // Observe the real request owner so an async provider hook can revoke
          // its account between the initial Access check and physical submission.
          return originalGuard(params);
        });
      onTestFinished(() => guardSpy.mockRestore());
      const actual = await import("../../embedded-agent-runner/run.js");
      const done = createDeferred<unknown>();
      options.runEmbeddedAgent.mockImplementationOnce(async (params) => {
        try {
          const result = await actual.runEmbeddedAgent(params);
          done.resolve(result);
          return result;
        } catch (error) {
          done.resolve(error);
          throw error;
        }
      });
      let childRunId: string | undefined;
      const failures: unknown[] = [];
      try {
        const result = await createBoundSpawnInvocation(
          bound,
          { cyberAccessProgram: selection === "explicit" ? program : undefined },
          { provider: "openai", model: model.id },
        )();
        expect(result.details).toMatchObject({ status: "accepted" });
        const details = result.details as { runId: string; childSessionKey: string };
        childRunId = details.runId;
        expect(
          loadSessionEntry({ storePath: bound.storePath, sessionKey: details.childSessionKey })
            ?.cyberAccessProgram,
        ).toBe(program);
        const completed = await done.promise;
        if (native) {
          expect(writes, "native child must not fall back to OpenClaw transport").toHaveLength(0);
        }
        const nativeMessages = native?.readMessages();
        const requests =
          nativeMessages
            ?.filter(({ method }) => method === "turn/start")
            .map(({ params }) => params) ?? writes;
        if (outcome !== "allowed") {
          if (!native) {
            expect(accountChanged).toBe(outcome !== "unavailable");
            if (outcome !== "unavailable") {
              expect(rejectedSubmissions.length).toBeGreaterThan(0);
              for (const rejection of rejectedSubmissions) {
                expect(rejection).toMatchObject({ code: "OPENAI_ACCESS_PROGRAM_UNAVAILABLE" });
              }
            }
          }
          expect(requests).toHaveLength(0);
          if (native && outcome !== "unavailable") {
            expect(nativeMessages).toEqual(
              expect.arrayContaining([
                expect.objectContaining({ method: "thread/start" }),
                expect.objectContaining({ method: "account/updated" }),
              ]),
            );
          }
          if (completed instanceof Error) {
            expect(completed.message).toMatch(/Daybreak|account changed/i);
          } else {
            expect(completed).toMatchObject({
              payloads: expect.arrayContaining([
                expect.objectContaining({
                  isError: true,
                  ...(native || outcome === "unavailable"
                    ? { text: expect.stringMatching(/Daybreak|account changed/i) }
                    : {}),
                }),
              ]),
            });
          }
        } else {
          if (completed instanceof Error) {
            throw completed;
          }
          if (native) {
            expect(completed).toMatchObject({
              meta: { agentMeta: { agentHarnessId: "codex" } },
              payloads: expect.arrayContaining([
                expect.objectContaining({ text: "Completed as account-a" }),
              ]),
            });
          }
          expect(requests).toHaveLength(1);
          expect(requests[0]).toMatchObject(
            native
              ? {
                  model: model.id,
                  cyberAccessProgram: program === "daybreak_blue" ? "daybreakBlue" : "daybreakRed",
                }
              : {
                  model: model.id,
                  access_programs: { cyber: program },
                },
          );
        }
      } catch (error) {
        failures.push(error);
      } finally {
        failures.push(...(await options.closeBoundGateway(bound, runtime, childRunId)));
        options.throwBoundFailures(failures);
      }
    },
    60000,
  );
}
