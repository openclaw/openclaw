import fs from "node:fs";
import http from "node:http";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.js";
import { acquireAgentRunPreparedModelRuntime } from "../../agents/prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../../agents/prepared-model-runtime.test-support.js";
import { AuthStorage } from "../../agents/sessions/auth-storage.js";
import { createToolSurfacePresentationForTest } from "../../agents/tool-surface-plan.test-support.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  claimAgentRunDelegatedAuthority,
  registerAgentRunContext,
  releaseAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
  resetAgentRunRegistryForTest,
} from "../../infra/agent-run-registry.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { clearActivePluginRegistry } from "../../plugins/runtime.js";
import { createColdPluginFixture } from "../../plugins/test-helpers/cold-plugin-fixtures.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../../test-utils/port-claims.js";
import { executeWorkerInference } from "./inference-runtime.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { advancePlacementFixtureToActive } from "./placement-test-fixtures.js";
import { bindWorkerTurnCapabilities, bindWorkerTurnOwner } from "./placement-turn-claim-events.js";
import { createWorkerGatewayToolRuntime } from "./worker-gateway-tool-runtime.js";
import { prepareWorkerTurnModel } from "./worker-turn-model.js";

// This release-tier composition protects the authority-to-provider boundary that
// isolated auth-hook tests cannot prove. No runtime, credentials, or claim owner is mocked.
it("fences real admitted worker credential exchange and inference I/O", async ({ signal }) => {
  await withOpenClawTestState({ label: "worker-auth-boundary" }, async (state) => {
    const provider = "authority-proof";
    const key = "synthetic-admission-key";
    const exchanged = "synthetic-exchanged-key";
    const effects: { path: string; authorized: boolean }[] = [];
    let exchangeArrived = createDeferred();
    let finishExchange = createDeferred();
    let holdExchange = false;
    const handleProviderRequest = async (
      request: http.IncomingMessage,
      response: http.ServerResponse,
    ) => {
      effects.push({
        path: request.url ?? "",
        authorized:
          request.headers.authorization === `Bearer ${request.url === "/auth" ? key : exchanged}`,
      });
      if (request.url === "/auth") {
        exchangeArrived.resolve();
        if (holdExchange) {
          await finishExchange.promise;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ apiKey: exchanged }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = {
        id: "synthetic",
        object: "chat.completion.chunk",
        created: 1,
        model: "model",
      };
      response.end(
        [
          `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { role: "assistant", content: "allowed worker response" }, finish_reason: null }] })}\n\n`,
          `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
          "data: [DONE]\n\n",
        ].join(""),
      );
    };
    const server = http.createServer((request, response) => {
      void handleProviderRequest(request, response).catch((error: unknown) => {
        response.destroy(error instanceof Error ? error : new Error("Synthetic provider failed"));
      });
    });
    const reservation = await reserveTestPortListener({
      offsets: [0],
      createListener: () => server,
    });
    await runQaGatewayFixture(
      async () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("Missing loopback provider address");
        }
        const endpoint = `http://127.0.0.1:${address.port}`;
        const pluginDir = state.path("provider");
        fs.mkdirSync(pluginDir);
        const plugin = createColdPluginFixture({
          rootDir: pluginDir,
          pluginId: provider,
          providerId: provider,
          manifest: {
            providers: [provider],
            channels: [],
            channelConfigs: {},
            providerAuthChoices: [],
          },
        });
        fs.writeFileSync(
          plugin.runtimeSource,
          `module.exports = { id: ${JSON.stringify(provider)}, register(api) {
      api.registerProvider({ id: ${JSON.stringify(provider)}, label: "Synthetic boundary provider", auth: [],
        async prepareRuntimeAuth(context) {
          const response = await fetch(${JSON.stringify(`${endpoint}/auth`)}, { method: "POST", headers: { authorization: "Bearer " + context.apiKey } });
          return await response.json();
        }
      });
    } };`,
        );
        const config: OpenClawConfig = {
          cloudWorkers: { requiredProfile: "development" },
          agents: {
            defaults: {
              workspace: state.workspaceDir,
              model: `${provider}/model`,
              models: { [`${provider}/model`]: {} },
            },
            entries: { main: {} },
          },
          models: {
            mode: "replace",
            providers: {
              [provider]: {
                api: "openai-completions",
                apiKey: key,
                baseUrl: `${endpoint}/v1`,
                models: [
                  {
                    id: "model",
                    name: "Boundary model",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 8192,
                    maxTokens: 128,
                  },
                ],
              },
            },
          },
          plugins: {
            allow: [provider],
            load: { paths: [pluginDir] },
            entries: { [provider]: { enabled: true } },
            slots: { memory: "none" },
          },
        };
        await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
          const database = openOpenClawStateDatabase();
          const placements = createWorkerSessionPlacementStore({ database });
          await resetPreparedModelRuntimeSnapshotsForTest();
          clearPluginMetadataLifecycleCaches();
          try {
            await using lease = await acquireAgentRunPreparedModelRuntime({
              config,
              agentId: "main",
              agentDir: state.agentDir(),
              workspaceDir: state.workspaceDir,
            });
            for (const mode of [
              "allowed",
              "wrong-session",
              "revoked-claim",
              "revoked-run",
              "revoked-exchange",
              "revoked-prepared-claim",
              "revoked-prepared-run",
            ] as const) {
              effects.length = 0;
              exchangeArrived = createDeferred();
              finishExchange = createDeferred();
              holdExchange = mode === "revoked-exchange";
              const session = {
                sessionId: `session-${mode}`,
                agentId: "main",
                sessionKey: `agent:main:${mode}`,
              };
              const target = {
                ...session,
                storePath: state.statePath("agents", "main", "sessions", "sessions.sqlite"),
              };
              await upsertSessionEntryCore(target, { sessionId: session.sessionId, updatedAt: 1 });
              const active = await advancePlacementFixtureToActive(placements, database, {
                ...session,
                executionMode: "worker-turn",
              });
              const claim = await placements.claimTurn({
                ...session,
                claimId: `claim-${mode}`,
                runId: `run-${mode}`,
                owner: {
                  kind: "worker",
                  environmentId: active.environmentId,
                  ownerEpoch: active.activeOwnerEpoch,
                },
              });
              const claimAuthority = await placements.prepareTurnClaimAuthority(claim);
              const instance = { runId: claim.runId, instanceId: `instance-${mode}` };
              registerAgentRunContext(claim.runId, session);
              const runAuthority = claimAgentRunDelegatedAuthority(instance, () => {
                if (!claimAuthority.isCurrent()) {
                  throw new Error("Persisted worker claim revoked");
                }
              });
              await bindWorkerTurnOwner(
                placements,
                claim,
                undefined,
                instance,
                target,
                () => {
                  if (!validateAgentRunDelegatedAuthority(runAuthority)) {
                    throw new Error("Admitted run revoked");
                  }
                },
                undefined,
                undefined,
                undefined,
                { boundaryCount: 0 },
              );
              if (mode === "revoked-claim") {
                await placements.releaseTurn(claim);
              } else if (mode === "revoked-run") {
                releaseAgentRunDelegatedAuthority(runAuthority);
              }
              const installed = vi.spyOn(AuthStorage.prototype, "setRuntimeApiKey");
              const isCurrent = () =>
                claimAuthority.isCurrent() && validateAgentRunDelegatedAuthority(runAuthority);
              const toolSurface = createWorkerGatewayToolRuntime({
                assertCurrent() {},
                signal,
                prepare: async () => ({
                  tools: [],
                  presentation: createToolSurfacePresentationForTest(),
                  policy: {
                    workspaceOnly: true,
                    readOnly: true,
                    applyPatchEnabled: false,
                    applyPatchWorkspaceOnly: true,
                    imageSanitization: {},
                  },
                }),
              });
              try {
                const pending = (async () => {
                  if (isCurrent() && mode !== "wrong-session") {
                    const { inference } = await prepareWorkerTurnModel({
                      target,
                      modelRef: { provider, model: "model" },
                      runtimeSnapshot: lease.snapshot,
                      inferencePlacement: "gateway",
                      turn: { abortSignal: signal, workspaceDir: state.workspaceDir },
                      assertCurrent: () => {
                        if (!isCurrent()) {
                          throw new Error("Worker inference source is no longer current");
                        }
                      },
                    });
                    bindWorkerTurnCapabilities(placements, claim, { inference, toolSurface });
                    if (mode === "revoked-prepared-claim") {
                      await placements.releaseTurn(claim);
                    } else if (mode === "revoked-prepared-run") {
                      releaseAgentRunDelegatedAuthority(runAuthority);
                    }
                  }
                  return executeWorkerInference({
                    identity: {
                      environmentId: active.environmentId,
                      credentialHash: "synthetic-worker-hash",
                      bundleHash: "synthetic-bundle-hash",
                      sessionId: session.sessionId,
                      runId: claim.runId,
                      turnClaim: claim,
                      ownerEpoch: active.activeOwnerEpoch,
                      rpcSetVersion: 1,
                      protocolFeatures: ["worker-inference-v1"],
                      credentialExpiresAtMs: Date.now() + 60_000,
                    },
                    request: {
                      sessionId: mode === "wrong-session" ? "foreign-session" : session.sessionId,
                      runId: claim.runId,
                      turnId: `turn-${mode}`,
                      runEpoch: active.activeOwnerEpoch,
                      modelRef: { provider, model: "model" },
                      context: {
                        messages: [{ role: "user", content: "Say allowed", timestamp: 1 }],
                      },
                      options: { maxTokens: 16 },
                    },
                    sessionTarget: target,
                    signal,
                    isCurrent,
                    emit: () => {},
                  });
                })();
                // Attach immediately so a rejected asynchronous exchange cannot become unhandled.
                const settled = pending.then(
                  (value) => ({ value }),
                  (error: unknown) => ({ error }),
                );
                if (holdExchange) {
                  await withinTest(
                    awaitGateBeforeSettlement(
                      exchangeArrived.promise,
                      settled,
                      "Worker did not reach real credential exchange",
                    ),
                    signal,
                  );
                  await placements.releaseTurn(claim);
                  expect(claimAuthority.isCurrent()).toBe(false);
                  finishExchange.resolve();
                }
                const outcome = await withinTest(settled, signal);
                // Claim/run denial must not be mistaken for an expired model generation.
                expect(lease.snapshot.isCurrent()).toBe(true);
                if (mode === "allowed") {
                  expect(outcome).toMatchObject({
                    value: {
                      type: "done",
                      message: { content: [{ type: "text", text: "allowed worker response" }] },
                    },
                  });
                  expect(effects).toEqual([
                    { path: "/auth", authorized: true },
                    { path: "/v1/chat/completions", authorized: true },
                  ]);
                  expect(installed.mock.calls.some(([id]) => id === provider)).toBe(true);
                } else {
                  if (holdExchange) {
                    expect(outcome).toMatchObject({
                      error: { message: "Worker inference source is no longer current" },
                    });
                  } else {
                    expect(outcome).toMatchObject({
                      value: {
                        type: "error",
                        reason: mode === "wrong-session" ? "session-not-attached" : "cancelled",
                      },
                    });
                  }
                  expect(effects).toEqual(
                    holdExchange || mode.startsWith("revoked-prepared-")
                      ? [{ path: "/auth", authorized: true }]
                      : [],
                  );
                  if (!mode.startsWith("revoked-prepared-")) {
                    expect(installed.mock.calls.length).toBe(0);
                  }
                }
                console.info(
                  `authority-boundary ${mode}: auth=${effects.filter((effect) => effect.path === "/auth").length} inference=${effects.filter((effect) => effect.path !== "/auth").length} installed=${installed.mock.calls.length} ${mode === "allowed" ? "success" : "rejected"}`,
                );
              } finally {
                finishExchange.resolve();
                installed.mockRestore();
                await toolSurface.close();
                releaseAgentRunDelegatedAuthority(runAuthority);
                claimAuthority.release();
                if (placements.get(session.sessionId)?.turnClaim) {
                  await placements.releaseTurn(claim);
                }
              }
            }
          } finally {
            vi.restoreAllMocks();
            await resetPreparedModelRuntimeSnapshotsForTest();
            await clearActivePluginRegistry();
            clearPluginMetadataLifecycleCaches();
            resetAgentRunRegistryForTest();
            await closeStateDatabaseForTest();
          }
        });
      },
      async () => {
        finishExchange.resolve();
        server.closeAllConnections();
        await reservation.releaseListener();
      },
      reservation.claim.release,
    );
  });
});
