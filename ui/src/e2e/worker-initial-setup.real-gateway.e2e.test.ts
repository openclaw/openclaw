import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { SKILL_RESOURCE_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/skill-resources.js";
import { installSessionPlacementAdmissionProvider } from "../../../src/agents/session-placement-admission.js";
import { SessionManager } from "../../../src/agents/sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../../../src/agents/test-helpers/agent-message-fixtures.js";
import { createEmbeddedAgentRunnerOpenAiConfig } from "../../../src/agents/test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { createSessionsSendTool } from "../../../src/agents/tools/sessions-send-tool.js";
import { setRuntimeConfigSnapshot } from "../../../src/config/runtime-snapshot.js";
import {
  listSessionPendingInputs,
  upsertSessionEntryCore,
} from "../../../src/config/sessions/session-accessor.js";
import { resolveSessionStorePathForScope } from "../../../src/config/sessions/session-store-path.js";
import type { OpenClawConfig } from "../../../src/config/types.openclaw.js";
import type { GatewayServer } from "../../../src/gateway/server-public.ts";
import { coordinateWorkerPlacementDispatch } from "../../../src/gateway/worker-environments/placement-dispatch-coordinator.js";
import { createCoordinatorTestService } from "../../../src/gateway/worker-environments/placement-dispatch-coordinator.test-support.js";
import { createWorkerSessionPlacementStore } from "../../../src/gateway/worker-environments/placement-store.js";
import { createWorkerSessionPlacementGate } from "../../../src/gateway/worker-environments/placement-worker-gate.js";
import { createWorkerSessionTurnPlacementProvider } from "../../../src/gateway/worker-environments/worker-turn-launcher.js";
import {
  attachedEnvironment,
  createWorkerTurnTunnel,
  credential,
  dispatchInitialWorkerPlacement,
  reconcileUnchangedLocalWorkspace,
  unusedEnvironments,
} from "../../../src/gateway/worker-environments/worker-turn-launcher.test-support.js";
import { createWorkerWorkspaceOperationCoordinator } from "../../../src/gateway/worker-environments/workspace-operation-coordinator.js";
import { runCommandWithTimeout } from "../../../src/process/exec.js";
import { createDeferredCore } from "../../../src/shared/deferred.js";
import { openOpenClawStateDatabase } from "../../../src/state/openclaw-state-db.js";
import { createOpenClawTestState } from "../../../src/test-utils/openclaw-test-state.js";
import { getFreePort } from "../../../src/test-utils/ports.js";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { deviceGatewayEnv } from "./device-gateway.test-support.ts";

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
      env: { ...deviceGatewayEnv, OPENCLAW_TEST_MINIMAL_GATEWAY: "0" },
    });
    let gateway: GatewayServer | undefined;
    let uninstall: (() => void) | undefined;
    const release = createDeferredCore();
    let dispatchOperation: Promise<unknown> | undefined;
    try {
      const workspace = state.path("workspace");
      await mkdir(workspace, { recursive: true });
      const { models } = createEmbeddedAgentRunnerOpenAiConfig(["gpt-4.1"]);
      const provider = models!.providers!.openai!;
      Object.assign(provider, {
        apiKey: "synthetic-fixture-key",
        baseUrl: "http://127.0.0.1:9/v1",
      });
      Object.assign(provider.models[0]!, {
        name: "Synthetic worker model",
        contextWindow: 128000,
        maxTokens: 4096,
      });
      const config: OpenClawConfig = {
        models,
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
        gateway: {
          auth: { mode: "none" },
          controlUi: { allowedOrigins: [new URL(suite.server.baseUrl).origin], enabled: false },
          port,
        },
      };
      await state.writeConfig(config);
      state.applyEnv();
      setRuntimeConfigSnapshot(config);
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
      const database = openOpenClawStateDatabase();
      const placements = createWorkerSessionPlacementStore({ database });
      const syncing = createDeferredCore();
      const dispatch = coordinateWorkerPlacementDispatch(
        createCoordinatorTestService({
          dispatch: async (_request, report) =>
            await dispatchInitialWorkerPlacement({
              database,
              placements,
              identity: { ...scope, executionMode: "worker-turn" },
              workspace,
              onTransition: async (placement) => {
                report?.(placement);
                if (placement.state === "syncing") {
                  syncing.resolve();
                  await release.promise;
                }
              },
            }),
        }),
        (_request, run) => run(),
      );
      const launched: string[] = [];
      const setupWaiters: string[] = [];
      const unexpected = (operation: string) => async () => {
        throw new Error(`unexpected ${operation}`);
      };
      const tunnel = createWorkerTurnTunnel({
        runWorkspaceCommand: async (command) =>
          await runCommandWithTimeout([...command.argv], {
            cwd: workspace,
            input: command.input,
            timeoutMs: 5000,
          }),
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
          await createWorkerSessionPlacementGate(placements).updateAckCursors({
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
        syncWorkspace: unexpected("resync"),
        reconcileWorkspace: reconcileUnchangedLocalWorkspace,
      });
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
                  ],
                },
              };
            },
            acquireTurnCredential: async () => ({ ...credential(), sessionId }),
            acknowledgeCredentialDelivery: async () => true,
            startTunnel: async () => tunnel,
          },
          resolveWorkspace: async () => ({ kind: "local", path: workspace }),
          reconcileActivePlacement: unexpected("recovery"),
          waitForAdmissionNode: unexpected("runtime refresh"),
          redispatchPlacement: unexpected("redispatch"),
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
          const pendingCount = async () => (await listSessionPendingInputs(scope)).items.length;
          const capture = (name: string) =>
            page.screenshot({ path: path.join(suite.artifactDir, name) });
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
            await expect.poll(pendingCount, { timeout: 15000 }).toBe(1);
            expect(launched).toEqual([]);
            await expect.poll(() => setupWaiters.length, { timeout: 30000 }).toBe(1);
            expect((await listSessionPendingInputs(scope)).items).toHaveLength(1);
            await page.getByText("Received · waiting for worker setup", { exact: true }).waitFor();
            await capture("01-held-during-setup.png");
            const sent = await createSessionsSendTool({
              agentSessionKey: "agent:main:main",
              expectedTargetSessionId: sessionId,
            }).execute("setup-send", {
              sessionKey,
              message: "Tool input held for setup",
              timeoutSeconds: 0,
            });
            expect(sent.details).toMatchObject({ status: "accepted", targetDisposition: "queued" });
            await expect.poll(pendingCount).toBe(2);
            expect(launched).toEqual([]);
            const heldInputs = (await listSessionPendingInputs(scope)).items;
            expect(heldInputs.every((input) => input.state === "queued")).toBe(true);
            release.resolve();
            await dispatchOperation;
            const outcomes = await evaluateControlUiContext(
              page,
              (context, runIds) =>
                Promise.all(
                  runIds.map((runId) =>
                    context.gateway.snapshot.client!.request(
                      "agent.wait",
                      { runId, timeoutMs: 30_000 },
                      { timeoutMs: 30_000 },
                    ),
                  ),
                ),
              heldInputs.map((input) => input.runId),
            );
            expect(outcomes).toMatchObject([{ status: "ok" }, { status: "ok" }]);
            expect(launched).toHaveLength(2);
            expect(new Set(launched).size).toBe(2);
            expect(new Set(launched)).toEqual(new Set(heldInputs.map((input) => input.runId)));
            await expect.poll(pendingCount).toBe(0);
            await page
              .getByRole("paragraph")
              .filter({ hasText: /^Worker reply 2$/ })
              .waitFor();
            await capture("02-resumed-on-worker.png");
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
