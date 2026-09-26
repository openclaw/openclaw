// Native cancellation E2E covers child owner/generation fences and real ACP process interrupts.
import fs from "node:fs/promises";
import path from "node:path";
import type { AcpRuntimeEvent } from "@openclaw/acp-core/runtime/types";
import type { OpenClawPluginService } from "openclaw/plugin-sdk/core";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import acpxPlugin from "../../../../extensions/acpx/index.js";
import {
  getAcpSessionManager,
  testing as acpManagerTesting,
} from "../../../../src/acp/control-plane/manager.js";
import type { AcpRunTurnInput } from "../../../../src/acp/control-plane/manager.types.js";
import { prepareSystemAgentRunAdmission } from "../../../../src/agents/admitted-run-context.js";
import { killSubagentRunAdmin } from "../../../../src/agents/subagents/registry/subagent-control.js";
import { getSubagentRunByRunId } from "../../../../src/agents/subagents/registry/subagent-registry.js";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "../../../../src/agents/subagents/registry/subagent-registry.test-helpers.js";
import { createSubagentsTool } from "../../../../src/agents/tools/subagents-tool.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../../../../src/config/config.js";
import { resolveSessionStorePathCore } from "../../../../src/config/sessions/paths.js";
import { replaceSessionEntrySync } from "../../../../src/config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import { startGatewayServer } from "../../../../src/gateway/server.js";
import { getGatewayE2ePortBlock } from "../../../../src/gateway/test-helpers.e2e.js";
import { snapshotGatewayStartupEnv } from "../../../../src/gateway/test-helpers.env.js";
import { resetPluginRuntimeStateForTest } from "../../../../src/plugins/runtime.js";
import { withEnvAsync } from "../../../../src/test-utils/env.js";
import { createDeferred } from "../../../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";

const TOKEN = "native-cancellation-e2e-token";
const ROUTE_OWNER = "agent:main:native-authority-proof";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

vi.mock(
  "../../../../src/agents/subagents/registry/subagent-registry-state.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../../src/agents/subagents/registry/subagent-registry-state.js")
    >()),
    persistSubagentRunsToDisk: () => {},
    persistSubagentRunsToDiskOrThrow: () => {},
    restoreSubagentRunsFromDisk: () => 0,
  }),
);

afterEach(() => {
  clearConfigCache();
  clearRuntimeConfigSnapshot();
  acpManagerTesting.resetAcpSessionManagerForTests();
  resetSubagentRegistryForTests({ persist: false });
  resetPluginStateStoreForTests();
  resetPluginRuntimeStateForTest();
});

function registerRunningSubagent(params: {
  runId: string;
  childSessionKey: string;
  ownerKey: string;
}) {
  replaceSessionEntrySync(
    {
      sessionKey: params.childSessionKey,
      storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
    },
    {
      sessionId: `session-${params.childSessionKey}`,
      updatedAt: Date.now(),
      spawnedBy: params.ownerKey,
      parentSessionKey: params.ownerKey,
    },
  );
  const startedAt = Date.now();
  const generation = (getSubagentRunByRunId(params.runId)?.generation ?? 0) + 1;
  addSubagentRunForTests({
    runId: params.runId,
    childSessionKey: params.childSessionKey,
    controllerSessionKey: params.ownerKey,
    requesterSessionKey: params.ownerKey,
    requesterDisplayKey: params.ownerKey,
    task: `Running child ${params.runId}`,
    cleanup: "keep",
    generation,
    createdAt: startedAt,
    startedAt,
  });
  return generation;
}

type AcpFixtureTraceEntry = {
  method: string;
  threadId?: string;
  turnId?: string;
};

async function readAcpTrace(tracePath: string): Promise<AcpFixtureTraceEntry[]> {
  return (await fs.readFile(tracePath, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AcpFixtureTraceEntry);
}

describe("native child cancellation authority", () => {
  it("allows the owner and rejects foreign or replaced backing runs before termination", async () => {
    const root = tempDirs.make("openclaw-native-cancellation-authz-");
    const stateDir = path.join(root, "state");
    const acpxStateDir = path.join(root, "acpx-state");
    const acpxTracePath = path.join(root, "acpx-process-trace.jsonl");
    const configPath = path.join(root, "openclaw.json");
    await fs.mkdir(stateDir, { recursive: true });

    const config: OpenClawConfig = {
      gateway: {
        mode: "local",
        bind: "loopback",
        auth: { mode: "token", token: TOKEN },
      },
      acp: {
        enabled: true,
        backend: "acpx",
        dispatch: { enabled: true },
        allowedAgents: ["codex"],
      },
    };
    await fs.writeFile(configPath, `${JSON.stringify(config)}\n`, "utf8");

    await withEnvAsync(
      {
        ...snapshotGatewayStartupEnv(),
        HOME: root,
        CODEX_PATH: path.resolve("extensions/acpx/test/fixtures/codex-app-server.mjs"),
        OPENCLAW_ACPX_PROCESS_FIXTURE_TRACE: acpxTracePath,
        OPENCLAW_ACPX_RUNTIME_STARTUP_PROBE: "0",
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_HOME: root,
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_SKIP_ACPX_RUNTIME: undefined,
        OPENCLAW_SKIP_ACPX_RUNTIME_PROBE: "1",
        OPENCLAW_STATE_DIR: stateDir,
      },
      async () => {
        clearConfigCache();
        clearRuntimeConfigSnapshot();
        const port = await getGatewayE2ePortBlock();
        const server = await startGatewayServer(port, {
          auth: { mode: "token", token: TOKEN },
          bind: "loopback",
          controlUiEnabled: false,
          sidecarStartup: "defer",
        });
        await server.startupSettled;
        const acpxServices: OpenClawPluginService[] = [];
        const acpxRuntime = createPluginRuntimeMock({
          state: {
            openKeyedStore: (options) => createPluginStateKeyedStoreForTests("acpx", options),
          },
        });
        acpxPlugin.register(
          createTestPluginApi({
            id: "acpx",
            name: "ACPX Runtime",
            config,
            pluginConfig: {
              cwd: root,
              stateDir: acpxStateDir,
              permissionMode: "deny-all",
              timeoutSeconds: 15,
            },
            runtime: acpxRuntime,
            registerService: (service) => {
              acpxServices.push(service);
            },
          }),
        );
        const acpxService = acpxServices.at(0);
        if (!acpxService) {
          throw new Error("ACPX plugin did not register its runtime service");
        }
        const acpxServiceContext = {
          config,
          workspaceDir: root,
          stateDir,
          logger: { info() {}, warn() {}, error() {}, debug() {} },
        };
        await acpxService.start(acpxServiceContext);
        try {
          const ownerTool = createSubagentsTool({
            config,
            agentSessionKey: ROUTE_OWNER,
            agentId: "main",
          });
          const allowedRunId = "run-native-owned";
          const allowedChild = "agent:main:subagent:native-owned";
          registerRunningSubagent({
            runId: allowedRunId,
            childSessionKey: allowedChild,
            ownerKey: ROUTE_OWNER,
          });
          const allowed = await ownerTool.execute("owned-cancel", {
            action: "cancel",
            runId: allowedRunId,
          });
          expect(allowed.details).toMatchObject({ found: true, killed: true });
          expect(getSubagentRunByRunId(allowedRunId)).toMatchObject({
            endedReason: "subagent-killed",
            execution: { status: "terminal", endedAt: expect.any(Number) },
          });

          const foreignRunId = "run-native-foreign";
          const foreignChild = "agent:main:subagent:native-foreign";
          registerRunningSubagent({
            runId: foreignRunId,
            childSessionKey: foreignChild,
            ownerKey: "agent:main:foreign-owner",
          });
          const foreign = await ownerTool.execute("foreign-cancel", {
            action: "cancel",
            runId: foreignRunId,
          });
          expect(foreign.details).toMatchObject({ status: "forbidden" });
          expect(getSubagentRunByRunId(foreignRunId)?.execution.status).toBe("running");
          expect(getSubagentRunByRunId(foreignRunId)?.execution.endedAt).toBeUndefined();

          for (const sameId of [false, true]) {
            const childSessionKey = `agent:main:subagent:replacement-${sameId}`;
            const runId = `native-original-${sameId}`;
            const generation = registerRunningSubagent({
              runId,
              childSessionKey,
              ownerKey: ROUTE_OWNER,
            });
            const replacementRunId = sameId ? runId : "native-replacement";
            registerRunningSubagent({
              runId: replacementRunId,
              childSessionKey,
              ownerKey: ROUTE_OWNER,
            });
            expect(
              await killSubagentRunAdmin({
                cfg: config,
                sessionKey: childSessionKey,
                expectedRunId: runId,
                expectedGeneration: generation,
                expectedOwnerKey: ROUTE_OWNER,
              }),
            ).toEqual({ found: false, killed: false });
            expect(getSubagentRunByRunId(replacementRunId)?.execution.status).toBe("running");
            expect(getSubagentRunByRunId(replacementRunId)?.execution.endedAt).toBeUndefined();
          }

          const acpChild = "agent:main:acp:native-replacement";
          const reusedAcpRunId = "run-native-acp-reused";
          const acpManager = getAcpSessionManager();
          async function runAcpTurn(
            input: Omit<AcpRunTurnInput, "admittedRunContext">,
            onAdmitted?: (context: AcpRunTurnInput["admittedRunContext"]) => void,
          ) {
            const admission = prepareSystemAgentRunAdmission(
              config,
              input.requestId,
              "main",
              "native-cancellation-fixture",
            );
            try {
              const admittedRunContext = await admission.admit("acp");
              onAdmitted?.(admittedRunContext);
              await acpManager.runTurn({ ...input, admittedRunContext });
              return admittedRunContext;
            } finally {
              admission.close();
            }
          }
          replaceSessionEntrySync(
            {
              sessionKey: acpChild,
              storePath: resolveSessionStorePathCore(config.session?.store, { agentId: "main" }),
            },
            {
              sessionId: "session-native-acp-replacement",
              updatedAt: Date.now(),
              spawnedBy: ROUTE_OWNER,
              parentSessionKey: ROUTE_OWNER,
            },
          );
          await acpManager.initializeSession({
            cfg: config,
            sessionKey: acpChild,
            agent: "codex",
            mode: "persistent",
            backendId: "acpx",
          });
          const firstAcpAdmission = await runAcpTurn({
            cfg: config,
            sessionKey: acpChild,
            provenance: "system",
            text: "Complete the first same-id turn before replacement.",
            mode: "prompt",
            requestId: reusedAcpRunId,
            onElicitation: async () => ({
              action: "accept",
              content: { question: "complete normally" },
            }),
          });
          const elicitationEntered = createDeferred();
          const releaseElicitation = createDeferred();
          const replacementAcpTurn = runAcpTurn({
            cfg: config,
            sessionKey: acpChild,
            provenance: "system",
            text: "Keep the same-id replacement active for cancellation fencing proof.",
            mode: "prompt",
            requestId: reusedAcpRunId,
            onElicitation: async () => {
              elicitationEntered.resolve();
              await releaseElicitation.promise;
              return { action: "accept", content: { question: "complete normally" } };
            },
          });
          let acpxMethodsBeforeRelease: string[] = [];
          try {
            await elicitationEntered.promise;
            await expect(
              acpManager.cancelSession({
                cfg: config,
                sessionKey: acpChild,
                expectedRunId: reusedAcpRunId,
                expectedInstanceId: firstAcpAdmission.operationalRunInstance.instanceId,
                expectedOwnerKey: ROUTE_OWNER,
              }),
            ).rejects.toThrow();
            acpxMethodsBeforeRelease = (await readAcpTrace(acpxTracePath)).map(
              (entry) => entry.method,
            );
            expect(acpxMethodsBeforeRelease).toContain("turn/start");
            expect(acpxMethodsBeforeRelease).not.toContain("turn/interrupt");
          } finally {
            releaseElicitation.resolve();
            await replacementAcpTurn;
          }
          const queuedAcpChild = "agent:main:acp:native-queued-successor";
          const queuedAcpRunId = "run-native-acp-queued";
          replaceSessionEntrySync(
            {
              sessionKey: queuedAcpChild,
              storePath: resolveSessionStorePathCore(config.session?.store, { agentId: "main" }),
            },
            {
              sessionId: "session-native-acp-queued-successor",
              updatedAt: Date.now(),
              spawnedBy: ROUTE_OWNER,
              parentSessionKey: ROUTE_OWNER,
            },
          );
          await acpManager.initializeSession({
            cfg: config,
            sessionKey: queuedAcpChild,
            agent: "codex",
            mode: "persistent",
            backendId: "acpx",
          });
          const queuedTargetEntered = createDeferred();
          const queuedTargetSubmitted = createDeferred();
          const queuedTurnOrder: string[] = [];
          const queuedTargetEvents: AcpRuntimeEvent[] = [];
          const queuedAdmission = createDeferred<AcpRunTurnInput["admittedRunContext"]>();
          const queuedTargetTurn = runAcpTurn(
            {
              cfg: config,
              sessionKey: queuedAcpChild,
              provenance: "system",
              text: "Keep the target active while its same-id successor queues.",
              mode: "prompt",
              requestId: queuedAcpRunId,
              onLifecycle: () => {
                queuedTargetSubmitted.resolve();
              },
              onElicitation: async (_request, context) => {
                queuedTargetEntered.resolve();
                await new Promise<void>((resolve) => {
                  if (context.signal.aborted) {
                    resolve();
                    return;
                  }
                  context.signal.addEventListener("abort", () => resolve(), { once: true });
                });
                return { action: "cancel" };
              },
              onEvent: (event) => {
                queuedTargetEvents.push(event);
                if (event.type === "done" && event.status === "cancelled") {
                  queuedTurnOrder.push("target-cancelled");
                }
              },
            },
            queuedAdmission.resolve,
          );
          await Promise.all([queuedTargetEntered.promise, queuedTargetSubmitted.promise]);
          const queuedTargetContext = await queuedAdmission.promise;
          const targetTurnStart = (await readAcpTrace(acpxTracePath)).findLast(
            (entry) => entry.method === "turn/start",
          );
          expect(targetTurnStart).toMatchObject({
            threadId: expect.any(String),
            turnId: expect.any(String),
          });
          const interruptsBeforeQueuedCancel = (await readAcpTrace(acpxTracePath)).filter(
            (entry) => entry.method === "turn/interrupt",
          ).length;
          const queuedSuccessorEntered = createDeferred();
          const releaseQueuedSuccessor = createDeferred();
          const queuedSuccessorEvents: AcpRuntimeEvent[] = [];
          const queuedSuccessorTurn = runAcpTurn({
            cfg: config,
            sessionKey: queuedAcpChild,
            provenance: "system",
            text: "Complete the same-id successor without inheriting cancellation.",
            mode: "prompt",
            requestId: queuedAcpRunId,
            onElicitation: async () => {
              queuedTurnOrder.push("successor-entered");
              queuedSuccessorEntered.resolve();
              await releaseQueuedSuccessor.promise;
              return { action: "accept", content: { question: "complete successor" } };
            },
            onEvent: (event) => {
              queuedSuccessorEvents.push(event);
            },
          });
          const queuedCancelPromise = acpManager.cancelSession({
            cfg: config,
            sessionKey: queuedAcpChild,
            expectedRunId: queuedAcpRunId,
            expectedInstanceId: queuedTargetContext.operationalRunInstance.instanceId,
            expectedOwnerKey: ROUTE_OWNER,
          });
          await vi.waitFor(
            async () => {
              const interruptCount = (await readAcpTrace(acpxTracePath)).filter(
                (entry) => entry.method === "turn/interrupt",
              ).length;
              expect(interruptCount - interruptsBeforeQueuedCancel).toBeGreaterThan(0);
            },
            { interval: 10, timeout: 10_000 },
          );
          await queuedCancelPromise;
          const interruptsAfterTargetCancel = (await readAcpTrace(acpxTracePath)).filter(
            (entry) => entry.method === "turn/interrupt",
          );
          const targetInterrupts = interruptsAfterTargetCancel.slice(interruptsBeforeQueuedCancel);
          expect(targetInterrupts).toEqual([
            expect.objectContaining({
              threadId: targetTurnStart?.threadId,
              turnId: targetTurnStart?.turnId,
            }),
          ]);
          await queuedTargetTurn;
          expect(queuedTargetEvents.at(-1)).toEqual({
            type: "done",
            status: "cancelled",
            stopReason: "cancelled",
          });
          await queuedSuccessorEntered.promise;
          expect(queuedTurnOrder).toEqual(["target-cancelled", "successor-entered"]);
          const successorTurnStart = (await readAcpTrace(acpxTracePath)).findLast(
            (entry) => entry.method === "turn/start",
          );
          expect(successorTurnStart?.threadId).toBe(targetTurnStart?.threadId);
          expect(successorTurnStart?.turnId).toEqual(expect.any(String));
          expect(successorTurnStart?.turnId).not.toBe(targetTurnStart?.turnId);
          releaseQueuedSuccessor.resolve();
          await queuedSuccessorTurn;
          expect(queuedSuccessorEvents.at(-1)).toEqual({
            type: "done",
            status: "completed",
            stopReason: "end_turn",
          });
          expect(
            queuedSuccessorEvents.filter(
              (event) =>
                event.type === "done" &&
                (event.status === "cancelled" ||
                  event.stopReason === "cancel" ||
                  event.stopReason === "cancelled"),
            ),
          ).toHaveLength(0);
          const interruptsAfterSuccessor = (await readAcpTrace(acpxTracePath)).filter(
            (entry) => entry.method === "turn/interrupt",
          );
          expect(
            interruptsAfterSuccessor.filter((entry) => entry.turnId === successorTurnStart?.turnId),
          ).toHaveLength(0);
        } finally {
          await acpxService.stop?.(acpxServiceContext);
          await server.close();
        }
      },
    );
  }, 90_000);
});
