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
import { runCronSessionTurn } from "../../../cron/session-run.js";
import * as fetchGuard from "../../../infra/net/fetch-guard.js";
import { withPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import type { ProviderPlugin } from "../../../plugins/types.js";
import { loadBundledPluginFacade } from "../../../test-utils/bundled-plugin-public-surface.js";
import { createTestRegistry } from "../../../test-utils/channel-plugins.js";
import * as agentScope from "../../agent-scope.js";
import { codeModeSwarmHandlers } from "../../code-mode-swarm.runtime.js";
import { applyCodeModeCatalog } from "../../code-mode.js";
import { createCodeModeHarness } from "../../code-mode.test-support.js";
import { createRequestNativeSubagentRuntime } from "../../plugin-native-subagent.js";
import { setPreparedModelFullCatalogAuth } from "../../prepared-model-runtime-auth.js";
import { getPreparedModelRuntimeMocks } from "../../prepared-model-runtime.test-harness.js";
import { resolveToolSearchConfig } from "../../tool-search-config.js";
import { ToolSearchRuntime } from "../../tool-search-runtime.js";
import { createSessionsSpawnTool } from "../../tools/sessions-spawn-tool.js";
import { markSubagentRunTerminated } from "../registry/subagent-registry.js";
import { releaseSwarmRun } from "../swarm/swarm-scheduler.js";
import { installSpawnAccessCodex } from "./subagent-spawn.access-codex.test-support.js";
import { runCronAccessLifecycle } from "./subagent-spawn.cron-access.test-support.js";
import {
  holdNativeCapacity,
  nativeRequestSource,
} from "./subagent-spawn.plugin-native-rewrite.test-support.js";
import {
  createBoundSpawnInvocation,
  createSpawnOperatorSource,
  type NativePluginSpawnTestOptions,
} from "./subagent-spawn.production-boundary.test-support.js";

export function registerAccessRequestSpawnCases(
  options: NativePluginSpawnTestOptions & { parentSessionKey: string },
) {
  const nativeCases = [
    ...(["OpenClaw", "Codex"] as const).flatMap((runtimeName) =>
      (["explicit", "inherited"] as const).flatMap((selection) =>
        (["allowed", "unavailable", "revoked", "reassigned"] as const).map((outcome) => ({
          runtimeName,
          selection,
          outcome,
        })),
      ),
    ),
    { runtimeName: "OpenClaw", selection: "explicit", outcome: "requester-revoked" } as const,
  ];
  const cases = [
    ...nativeCases.map(({ runtimeName, selection, outcome }) => ({
      runtimeName,
      selection,
      outcome,
      adapter: "native" as const,
      queued: false,
    })),
    ...(["code-mode", "plugin"] as const).map((adapter) => ({
      runtimeName: "OpenClaw" as const,
      selection: "standard" as const,
      outcome: "allowed" as const,
      adapter,
      queued: false,
    })),
    ...(["code-mode", "plugin"] as const).flatMap((adapter) =>
      ([false, true] as const).flatMap((queued) =>
        (
          [
            "allowed",
            "unavailable",
            "revoked",
            "reassigned",
            "requester-revoked",
            "role-denied",
          ] as const
        ).map((outcome) => ({
          runtimeName: "OpenClaw" as const,
          selection: "explicit" as const,
          outcome,
          adapter,
          queued,
        })),
      ),
    ),
    ...(["cron", "cron-session"] as const).flatMap((adapter) =>
      (["allowed", "unavailable", "revoked", "reassigned", "role-denied"] as const).map(
        (outcome) => ({
          runtimeName: "OpenClaw" as const,
          selection: "explicit" as const,
          outcome,
          adapter,
          queued: false,
        }),
      ),
    ),
  ];
  it.each<(typeof cases)[number]>(cases)(
    "$adapter queued=$queued $selection child Access at final $runtimeName submission: $outcome",
    async ({ runtimeName, selection, outcome, adapter, queued }) => {
      const program =
        selection === "standard"
          ? "standard"
          : selection === "explicit"
            ? "daybreak_blue"
            : "daybreak_red";
      const actualScope = await vi.importActual<typeof agentScope>("../../agent-scope.js");
      const resolver = vi
        .spyOn(agentScope, "resolveSessionAgentIds")
        .mockImplementation(actualScope.resolveSessionAgentIds);
      onTestFinished(() => resolver.mockRestore());
      const source = createSpawnOperatorSource("access-admin", ["operator.admin"], {
        rolePolicy: {
          sessionAccessCap: "none",
          sandboxRequired: false,
          agents: "*",
          ...(outcome === "role-denied" ? { accessPrograms: { cyber: [] } } : {}),
        },
      });
      const bound = await options.createBoundParent(source.authority);
      await upsertSessionEntryCore(
        { storePath: bound.storePath, sessionKey: options.parentSessionKey },
        {
          cyberAccessProgram:
            selection === "inherited"
              ? program
              : selection === "standard"
                ? "daybreak_blue"
                : undefined,
        },
      );
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
      let requesterRevoked = false;
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
              if (outcome === "requester-revoked" && !requesterRevoked) {
                // The child retains custody after foreground closure; revocation still fences egress.
                bound.admission.close();
                bound.parent.cleanup();
                source.closeRequest();
                expect(source.holds).toBeGreaterThan(0);
                expect(source.authority.assertCurrent).not.toThrow();
                source.revoke();
                requesterRevoked = true;
              } else if (outcome === "revoked") {
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
      const runActual = async (params: Parameters<typeof actual.runEmbeddedAgent>[0]) => {
        try {
          const result = await actual.runEmbeddedAgent(params);
          done.resolve(result);
          return result;
        } catch (error) {
          done.resolve(error);
          throw error;
        }
      };
      if (adapter === "cron" || adapter === "cron-session") {
        options.runEmbeddedAgent.mockImplementation(runActual);
      } else {
        options.runEmbeddedAgent.mockImplementationOnce(runActual);
      }
      if (queued) {
        await holdNativeCapacity(bound, "access-capacity");
        onTestFinished(() => {
          releaseSwarmRun("access-capacity");
        });
      }
      let cronResult: Awaited<ReturnType<typeof runCronSessionTurn>> | undefined;
      let childRunId: string | undefined;
      let childSessionKey: string | undefined;
      const failures: unknown[] = [];
      try {
        if (adapter === "cron" || adapter === "cron-session") {
          const cron = await runCronAccessLifecycle({
            adapter,
            outcome,
            program,
            modelId: model.id,
            bound,
            context,
            options,
            writes,
          });
          if (cron.skipped) {
            return;
          }
          cronResult = cron.result;
        } else {
          const requested = selection === "inherited" ? undefined : program;
          const invoke = createBoundSpawnInvocation(
            bound,
            { cyberAccessProgram: requested },
            { provider: "openai", model: model.id },
          );
          let result;
          if (adapter === "plugin") {
            const accepted = await withPluginRuntimeGatewayRequestScope(
              { context, isWebchatConnect: () => false },
              () =>
                createRequestNativeSubagentRuntime(nativeRequestSource(bound, source), {
                  pluginId: "access-fixture",
                  assertCurrent: source.authority.assertCurrent,
                }).spawn({
                  requestId: "access-proof",
                  task: "bounded child",
                  model: `openai/${model.id}`,
                  cyberAccessProgram: requested,
                }),
            );
            result = { details: { status: "accepted", ...accepted } };
          } else if (adapter === "code-mode") {
            const harness = createCodeModeHarness();
            Object.assign(harness.config.tools, { swarm: { enabled: true } });
            Object.assign(harness.ctx, {
              sessionKey: options.parentSessionKey,
              runId: bound.parentRunId,
            });
            const spawn = createSessionsSpawnTool({
              config: bound.cfg,
              agentSessionKey: options.parentSessionKey,
            });
            // Bind the real tool to the admitted parent; never replace the native spawn owner.
            spawn.execute = async (_id, input) =>
              createBoundSpawnInvocation(
                bound,
                { collect: true },
                { provider: "openai", model: model.id },
              )(undefined, undefined, input);
            applyCodeModeCatalog({
              tools: [...harness.tools, spawn],
              config: harness.config,
              catalogRef: harness.catalogRef,
            });
            result = {
              details: await codeModeSwarmHandlers.agentSpawn({
                runtime: new ToolSearchRuntime(
                  harness.ctx,
                  resolveToolSearchConfig(harness.config),
                ),
                ctx: harness.ctx,
                parentToolCallId: "access-code",
                codeModeRunId: "access-code",
                request: {
                  id: "access-spawn",
                  method: "agentSpawn",
                  args: ["bounded child", { cyberAccessProgram: requested }],
                },
              }),
            };
          } else {
            result = await invoke();
          }
          expect(result.details).toMatchObject({ status: "accepted" });
          const details = result.details as { runId: string; childSessionKey: string };
          childRunId = details.runId;
          childSessionKey = details.childSessionKey;
          expect(
            loadSessionEntry({ storePath: bound.storePath, sessionKey: details.childSessionKey })
              ?.cyberAccessProgram,
          ).toBe(program);
          if (queued) {
            expect(options.runEmbeddedAgent).not.toHaveBeenCalled();
            expect(writes).toHaveLength(0);
            releaseSwarmRun("access-capacity");
          }
        }
        const completed = adapter === "cron-session" ? cronResult : await done.promise;
        if (native) {
          expect(writes, "native child must not fall back to OpenClaw transport").toHaveLength(0);
        }
        const nativeMessages = native?.readMessages();
        const requests =
          nativeMessages
            ?.filter(({ method }) => method === "turn/start")
            .map(({ params }) => params) ?? writes;
        if (outcome === "requester-revoked") {
          expect(requesterRevoked).toBe(true);
          expect(accountChanged).toBe(false);
          expect(requests).toHaveLength(0);
          if (completed instanceof Error) {
            expect(completed.message).toMatch(/operator source revoked|aborted/i);
          } else {
            expect(completed).toMatchObject({ meta: { aborted: true } });
          }
        } else if (outcome !== "allowed") {
          if (!native) {
            expect(accountChanged).toBe(outcome !== "unavailable" && outcome !== "role-denied");
            if (outcome !== "unavailable" && outcome !== "role-denied") {
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
            expect(completed.message).toMatch(/Daybreak|account changed|Access|not allowed/i);
          } else if (adapter !== "cron-session") {
            expect(completed).toMatchObject({
              payloads: expect.arrayContaining([
                expect.objectContaining({
                  isError: true,
                  ...(native || outcome === "unavailable" || outcome === "role-denied"
                    ? {
                        text: expect.stringMatching(/Daybreak|account changed|Access|not allowed/i),
                      }
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
          } else if (adapter !== "cron-session") {
            expect(completed).toMatchObject({
              payloads: expect.arrayContaining([
                expect.objectContaining({ text: "Access child completed" }),
              ]),
            });
          }
          expect(requests).toHaveLength(adapter === "cron" || adapter === "cron-session" ? 3 : 1);
          if (program === "standard") {
            expect(requests[0]).toMatchObject({ access_programs: { cyber: "standard" } });
            console.log(
              JSON.stringify({
                adapter,
                saved: {
                  cyberAccessProgram: loadSessionEntry({
                    storePath: bound.storePath,
                    sessionKey: expectDefined(childSessionKey, "spawned child session"),
                  })?.cyberAccessProgram,
                },
                finalRequest: { elevatedAccess: false, count: requests.length },
              }),
            );
          }
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
        if (
          outcome === "role-denied" &&
          !(error instanceof Error && error.name === "AssertionError")
        ) {
          expect(String(error)).toMatch(/Access|permitted|allowed/i);
          expect(writes).toHaveLength(0);
          expect(options.runEmbeddedAgent).not.toHaveBeenCalled();
        } else {
          failures.push(error);
        }
      } finally {
        if (childRunId) {
          await markSubagentRunTerminated({
            runId: childRunId,
            reason: "Access fixture finished",
            suppressTaskDelivery: true,
            suppressSessionEffects: true,
          });
          releaseSwarmRun(childRunId);
        }
        failures.push(...(await options.closeBoundGateway(bound, runtime, childRunId)));
        options.throwBoundFailures(failures);
      }
    },
    60000,
  );
}
