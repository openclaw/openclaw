import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { SKILL_RESOURCE_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/skill-resources.js";
import { WORKER_SKILL_WORKSHOP_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-skill-workshop.js";
import { installSessionPlacementAdmissionProvider } from "../../../src/agents/session-placement-admission.js";
import { SessionManager } from "../../../src/agents/sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../../../src/agents/test-helpers/agent-message-fixtures.js";
import { createSessionsSendTool } from "../../../src/agents/tools/sessions-send-tool.js";
import {
  listSessionPendingInputs,
  upsertSessionEntryCore,
} from "../../../src/config/sessions/session-accessor.js";
import { resolveSessionStorePathForScope } from "../../../src/config/sessions/session-store-path.js";
import type { GatewayServer } from "../../../src/gateway/server-public.ts";
import { coordinateWorkerPlacementDispatch } from "../../../src/gateway/worker-environments/placement-dispatch-coordinator.js";
import { createCoordinatorTestService } from "../../../src/gateway/worker-environments/placement-dispatch-coordinator.test-support.js";
import { createWorkerSessionPlacementStore } from "../../../src/gateway/worker-environments/placement-store.js";
import { createWorkerSessionPlacementGate } from "../../../src/gateway/worker-environments/placement-worker-gate.js";
import type { WorkerTurnTunnelHandle } from "../../../src/gateway/worker-environments/tunnel-contract.js";
import { createWorkerSessionTurnPlacementProvider } from "../../../src/gateway/worker-environments/worker-turn-launcher.js";
import {
  attachedEnvironment,
  credential,
  ENVIRONMENT_ID,
  MANIFEST_REF,
  measureLaunchTurn,
  OWNER_EPOCH,
  unusedEnvironments,
} from "../../../src/gateway/worker-environments/worker-turn-launcher.test-support.js";
import { createWorkerWorkspaceOperationCoordinator } from "../../../src/gateway/worker-environments/workspace-operation-coordinator.js";
import { runCommandWithTimeout } from "../../../src/process/exec.js";
import { createDeferredCore } from "../../../src/shared/deferred.js";
import { createOpenClawTestState } from "../../../src/test-utils/openclaw-test-state.js";
import { getFreePort } from "../../../src/test-utils/ports.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Initial setup custody with a real Gateway",
  startServerBeforeBrowser: true,
});
const sessionKey = "agent:main:setup-proof";
const sessionId = "setup-proof-session";

suite.define(() => {
  it("holds browser and sessions_send input during sync, then launches each exactly once", async () => {
    const port = await getFreePort();
    const state = await createOpenClawTestState({
      label: "initial-setup-custody",
      layout: "home",
      env: {
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
        VITEST: "1",
      },
    });
    let gateway: GatewayServer | undefined;
    let uninstall: (() => void) | undefined;
    const release = createDeferredCore();
    let dispatchOperation: Promise<unknown> | undefined;
    try {
      const workspace = state.path("workspace");
      await mkdir(workspace, { recursive: true });
      await state.writeConfig({
        plugins: { enabled: false },
        tools: { sessions: { visibility: "all" } },
        agents: {
          defaults: {
            workspace,
            model: { primary: "openai/gpt-4.1" },
            models: { "openai/gpt-4.1": { agentRuntime: { id: "openclaw" } } },
          },
          entries: { main: { name: "Setup proof", workspace } },
        },
        models: {
          providers: {
            openai: {
              api: "openai-responses",
              apiKey: "synthetic-fixture-key",
              baseUrl: "http://127.0.0.1:9/v1",
              models: [
                {
                  id: "gpt-4.1",
                  name: "Synthetic worker model",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 128000,
                  maxTokens: 4096,
                },
              ],
            },
          },
        },
        gateway: {
          auth: { mode: "none" },
          controlUi: { allowedOrigins: [new URL(suite.server.baseUrl).origin], enabled: false },
          port,
        },
      });
      state.applyEnv();
      const scope = {
        agentId: "main",
        sessionKey,
        sessionId,
        storePath: resolveSessionStorePathForScope({ agentId: "main", sessionKey }),
      };
      await upsertSessionEntryCore(scope, {
        sessionId,
        updatedAt: Date.now(),
        label: "Worker setup proof",
      });
      const { startGatewayServer } = await import("../../../src/gateway/server.js");
      gateway = await startGatewayServer(port, {
        auth: { mode: "none" },
        bind: "loopback",
        controlUiEnabled: false,
        sidecarStartup: "start",
      });
      await gateway.startupSettled;
      const placements = createWorkerSessionPlacementStore();
      const syncing = createDeferredCore();
      const dispatch = coordinateWorkerPlacementDispatch(
        createCoordinatorTestService({
          dispatch: async (_request, report) => {
            let placement = placements.startDispatch({ ...scope, executionMode: "worker-turn" });
            for (const step of [
              { to: "provisioning", patch: { environmentId: ENVIRONMENT_ID } },
              { to: "syncing", patch: { workerBundleHash: "a".repeat(64) } },
              {
                to: "starting",
                patch: { remoteWorkspaceDir: workspace, workspaceBaseManifestRef: MANIFEST_REF },
              },
              { to: "active", patch: { activeOwnerEpoch: OWNER_EPOCH } },
            ] as const) {
              placement = placements.transition({
                sessionId,
                from: placement.state,
                expectedGeneration: placement.generation,
                ...step,
              });
              report?.(placement);
              if (placement.state === "syncing") {
                syncing.resolve();
                await release.promise;
              }
            }
            if (placement.state !== "active") {
              throw new Error("setup fixture did not activate");
            }
            return placement;
          },
        }),
        (_request, run) => run(),
      );
      const launched: string[] = [];
      const setupWaiters: string[] = [];
      const tunnel: WorkerTurnTunnelHandle = {
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: OWNER_EPOCH,
        quiesceWorkspace: async () => ({ assertActive: async () => {}, resume: async () => {} }),
        runWorkspaceCommand: async (command) =>
          await runCommandWithTimeout([...command.argv], {
            cwd: workspace,
            input: command.input,
            timeoutMs: 5000,
          }),
        measureLaunchTurn,
        launchTurn: async (request) => {
          request.onDispatchReady?.();
          launched.push(request.turnClaim.runId);
          const manager = SessionManager.open(scope);
          const leaf = manager.appendMessage(
            makeAgentAssistantMessage({
              content: [{ type: "text", text: `Worker reply ${launched.length}` }],
              timestamp: Date.now(),
            }),
          );
          createWorkerSessionPlacementGate(placements).updateAckCursors({
            claim: request.turnClaim,
            transcriptSeq: launched.length * 2,
            liveSeq: launched.length,
          });
          return {
            stdout: JSON.stringify({
              status: "completed",
              transcriptLeafId: leaf,
              transcriptNextSeq: launched.length * 2 + 1,
            }),
            stderr: "",
            code: 0,
            signal: null,
            killed: false,
            termination: "exit",
          };
        },
        syncWorkspace: async () => {
          throw new Error("unexpected resync");
        },
        reconcileWorkspace: async (request) => {
          if (request.source.kind !== "local") {
            throw new Error("expected local fixture source");
          }
          request.source.journal.commit(MANIFEST_REF);
          return {
            manifestRef: MANIFEST_REF,
            changed: false,
            verifyStable: async () => {},
            verifyLocalStable: async () => {},
          };
        },
        stop: async () => {},
      };
      uninstall = installSessionPlacementAdmissionProvider(
        createWorkerSessionTurnPlacementProvider({
          placements,
          environments: {
            ...unusedEnvironments(),
            get: () => {
              const environment = attachedEnvironment();
              return {
                ...environment,
                attachedSessionIds: [sessionId],
                bootstrapReceipt: {
                  ...environment.bootstrapReceipt!,
                  protocolFeatures: [
                    ...environment.bootstrapReceipt!.protocolFeatures,
                    SKILL_RESOURCE_PROTOCOL_FEATURE,
                    WORKER_SKILL_WORKSHOP_FEATURE,
                  ],
                },
              };
            },
            acquireTurnCredential: async () => ({ ...credential(), sessionId }),
            acknowledgeCredentialDelivery: () => true,
            startTunnel: async () => tunnel,
          },
          resolveWorkspace: async () => ({ kind: "local", path: workspace }),
          reconcileActivePlacement: async () => {
            throw new Error("unexpected recovery");
          },
          redispatchReclaimed: async () => {
            throw new Error("unexpected redispatch");
          },
          workspaceOperations: createWorkerWorkspaceOperationCoordinator(),
          waitForInitialPlacement: async (placement, signal) => {
            setupWaiters.push(placement.sessionId);
            return await dispatch.waitForInitialPlacement(placement, signal);
          },
        }),
      );
      dispatchOperation = dispatch.dispatch({
        ...scope,
        profileId: "development",
        executionMode: "worker-turn",
      });
      await syncing.promise;
      await suite.withPage(
        { locale: "en-US", viewport: { height: 900, width: 1440 }, serviceWorkers: "block" },
        async ({ page }) => {
          const url = new URL(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "chat"));
          url.searchParams.set("gatewayUrl", `ws://127.0.0.1:${port}`);
          await page.goto(url.toString());
          const confirmation = page.locator("openclaw-gateway-url-confirmation");
          await confirmation.waitFor();
          await confirmation
            .getByRole("button", { name: `Switch to 127.0.0.1:${port}`, exact: true })
            .click();
          try {
            const composer = page.locator(".agent-chat__composer-combobox textarea");
            await composer.waitFor({ state: "visible", timeout: 30_000 });
            await composer.fill("Browser input held for setup");
            await page.getByRole("button", { name: "Send message", exact: true }).click();
            await expect
              .poll(() => listSessionPendingInputs(scope).items.length, { timeout: 15000 })
              .toBe(1);
            expect(launched).toEqual([]);
            await expect.poll(() => setupWaiters.length, { timeout: 30000 }).toBe(1);
            expect(listSessionPendingInputs(scope).items).toHaveLength(1);
            await page.getByText("Received · waiting for worker setup", { exact: true }).waitFor();
            await page.screenshot({
              path: path.join(suite.artifactDir, "01-held-during-setup.png"),
            });
            const tool = createSessionsSendTool({
              agentSessionKey: "agent:main:main",
              expectedTargetSessionId: sessionId,
              callGateway: async (request) =>
                await page.evaluate(
                  async ({ method, params }) => {
                    const app = document.querySelector("openclaw-app") as HTMLElement & {
                      runtime: {
                        context: { gateway: { snapshot: { client: GatewayBrowserClient } } };
                      };
                    };
                    return await app.runtime.context.gateway.snapshot.client.request(
                      method,
                      params,
                    );
                  },
                  { method: request.method, params: request.params },
                ),
            });
            const sent = await tool.execute("setup-send", {
              sessionKey,
              message: "Tool input held for setup",
              timeoutSeconds: 0,
            });
            expect(sent.details).toMatchObject({ status: "accepted", targetDisposition: "queued" });
            await expect.poll(() => listSessionPendingInputs(scope).items.length).toBe(2);
            expect(launched).toEqual([]);
            expect(
              listSessionPendingInputs(scope).items.every((input) => input.state === "queued"),
            ).toBe(true);
            release.resolve();
            await dispatchOperation;
            await expect.poll(() => launched.length, { timeout: 30_000 }).toBe(2);
            expect(new Set(launched).size).toBe(2);
            await expect.poll(() => listSessionPendingInputs(scope).items.length).toBe(0);
            await page
              .getByRole("paragraph")
              .filter({ hasText: /^Worker reply 2$/ })
              .waitFor();
            await page.screenshot({
              path: path.join(suite.artifactDir, "02-resumed-on-worker.png"),
            });
          } finally {
            // Release server work before the browser fixture waits for RPC roots.
            release.resolve();
            await dispatchOperation?.catch(() => undefined);
            await gateway?.close({ reason: "isolated setup browser complete" });
            gateway = undefined;
          }
        },
      );
    } finally {
      release.resolve();
      await dispatchOperation?.catch(() => undefined);
      uninstall?.();
      try {
        await gateway?.close({ reason: "isolated setup proof complete" });
      } finally {
        await state.cleanup();
      }
    }
  }, 90_000);
});
