// Keep the tool's foreign-owner guard and exact-instance real ACP process interrupts.
import fs from "node:fs/promises";
import path from "node:path";
import type { AcpRuntimeEvent } from "@openclaw/acp-core/runtime/types";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import {
  createPluginStateKeyedStoreV2ForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  createTestPluginApi,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, expect, it } from "vitest";
import acpxPlugin from "../../../../extensions/acpx/index.js";
import {
  getAcpSessionManager,
  testing as acpManagerTesting,
} from "../../../../src/acp/control-plane/manager.js";
import type { AcpRunTurnInput } from "../../../../src/acp/control-plane/manager.types.js";
import { prepareSystemAgentRunAdmission } from "../../../../src/agents/admitted-run-context.js";
import {
  getSubagentRunByRunId,
  registerSubagentRun,
} from "../../../../src/agents/subagents/registry/subagent-registry.js";
import { resetSubagentRegistryForTests } from "../../../../src/agents/subagents/registry/subagent-registry.test-helpers.js";
import { createSubagentsTool } from "../../../../src/agents/tools/subagents-tool.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../../../../src/config/config.js";
import { resolveSessionStorePathCore } from "../../../../src/config/sessions/paths.js";
import {
  loadSessionEntry,
  replaceSessionEntrySync,
} from "../../../../src/config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import { resetPluginRuntimeStateForTest } from "../../../../src/plugins/runtime.js";
import { withEnvAsync } from "../../../../src/test-utils/env.js";
import { createDeferred, withinTest } from "../../../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";

const ROUTE_OWNER = "agent:main:native-authority-proof";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(async () => {
  clearConfigCache();
  clearRuntimeConfigSnapshot();
  acpManagerTesting.resetAcpSessionManagerForTests();
  await resetSubagentRegistryForTests({ persist: false });
  resetPluginStateStoreForTests();
  resetPluginRuntimeStateForTest();
});

function writeSession(sessionKey: string, sessionId: string, ownerKey = ROUTE_OWNER) {
  replaceSessionEntrySync(
    {
      sessionKey,
      storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
    },
    { sessionId, updatedAt: Date.now(), spawnedBy: ownerKey, parentSessionKey: ownerKey },
  );
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

function heldElicitation(question: string, onEntered = () => {}) {
  const entered = createDeferred();
  const release = createDeferred();
  return {
    entered: entered.promise,
    release: release.resolve,
    onElicitation: async () => {
      onEntered();
      entered.resolve();
      await release.promise;
      return { action: "accept" as const, content: { question } };
    },
  };
}

it("fences foreign child cancellation and interrupts only the selected native ACP instance", async ({
  signal,
}) => {
  const root = tempDirs.make("openclaw-native-cancellation-authz-");
  const stateDir = path.join(root, "state");
  const acpxStateDir = path.join(root, "acpx-state");
  const acpxTracePath = path.join(root, "acpx-process-trace.jsonl");
  const configPath = path.join(root, "openclaw.json");
  await fs.mkdir(stateDir, { recursive: true });

  const config: OpenClawConfig = {
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
      HOME: root,
      CODEX_PATH: path.resolve("extensions/acpx/test/fixtures/codex-app-server.mjs"),
      OPENCLAW_ACPX_PROCESS_FIXTURE_TRACE: acpxTracePath,
      OPENCLAW_ACPX_RUNTIME_STARTUP_PROBE: "0",
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_HOME: root,
      OPENCLAW_SKIP_ACPX_RUNTIME: undefined,
      OPENCLAW_SKIP_ACPX_RUNTIME_PROBE: "1",
      OPENCLAW_STATE_DIR: stateDir,
    },
    async () => {
      clearConfigCache();
      clearRuntimeConfigSnapshot();
      const acpxServices: Parameters<OpenClawPluginApi["registerService"]>[0][] = [];
      const acpxRuntime = createPluginRuntimeMock({
        state: {
          openKeyedStoreV2: (options) =>
            createPluginStateKeyedStoreV2ForTests("acpx", options, { assertCurrent() {} }),
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
      const scheduler = createTestPluginServiceScheduler();
      const acpxServiceContext = {
        scheduler,
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
        const foreignRunId = "run-native-foreign";
        const foreignChild = "agent:main:subagent:native-foreign";
        const foreignOwner = "agent:main:foreign-owner";
        writeSession(foreignChild, `session-${foreignChild}`, foreignOwner);
        await registerSubagentRun({
          runId: foreignRunId,
          childSessionKey: foreignChild,
          childAgentId: "main",
          sessionEntry: loadSessionEntry({ agentId: "main", sessionKey: foreignChild }),
          controllerSessionKey: foreignOwner,
          requesterSessionKey: foreignOwner,
          requesterDisplayKey: foreignOwner,
          task: "Foreign running child",
          cleanup: "keep",
        });
        const foreign = await ownerTool.execute("foreign-cancel", {
          action: "cancel",
          runId: foreignRunId,
        });
        expect(foreign.details).toMatchObject({ status: "forbidden" });
        expect(getSubagentRunByRunId(foreignRunId)?.execution.status).toBe("running");
        expect(getSubagentRunByRunId(foreignRunId)?.execution.endedAt).toBeUndefined();

        const acpChild = "agent:main:acp:native-replacement";
        const reusedAcpRunId = "run-native-acp-reused";
        const acpManager = getAcpSessionManager();
        async function initializeAcpSession(sessionKey: string, sessionId: string) {
          writeSession(sessionKey, sessionId);
          await acpManager.initializeSession({
            cfg: config,
            sessionKey,
            agent: "codex",
            mode: "persistent",
            backendId: "acpx",
          });
        }
        const traceEntries = async (method: string) =>
          (await readAcpTrace(acpxTracePath)).filter((entry) => entry.method === method);
        const cancelAcp = (
          sessionKey: string,
          runId: string,
          context: AcpRunTurnInput["admittedRunContext"],
        ) =>
          acpManager.cancelSession({
            cfg: config,
            sessionKey,
            expectedRunId: runId,
            expectedInstanceId: context.operationalRunInstance.instanceId,
            expectedOwnerKey: ROUTE_OWNER,
          });
        async function runAcpTurn(
          input: Omit<AcpRunTurnInput, "admittedRunContext" | "cfg" | "provenance" | "mode">,
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
            await acpManager.runTurn({
              cfg: config,
              provenance: "system",
              mode: "prompt",
              ...input,
              admittedRunContext,
            });
            return admittedRunContext;
          } finally {
            admission.close();
          }
        }
        await initializeAcpSession(acpChild, "session-native-acp-replacement");
        const firstAcpAdmission = await runAcpTurn({
          sessionKey: acpChild,
          text: "Complete the first same-id turn before replacement.",
          requestId: reusedAcpRunId,
          onElicitation: async () => ({
            action: "accept",
            content: { question: "complete normally" },
          }),
        });
        const replacement = heldElicitation("complete normally");
        const replacementAcpTurn = runAcpTurn({
          sessionKey: acpChild,
          text: "Keep the same-id replacement active for cancellation fencing proof.",
          requestId: reusedAcpRunId,
          onElicitation: replacement.onElicitation,
        });
        try {
          await replacement.entered;
          await expect(cancelAcp(acpChild, reusedAcpRunId, firstAcpAdmission)).rejects.toThrow();
          const acpxMethodsBeforeRelease = (await readAcpTrace(acpxTracePath)).map(
            (entry) => entry.method,
          );
          expect(acpxMethodsBeforeRelease).toContain("turn/start");
          expect(acpxMethodsBeforeRelease).not.toContain("turn/interrupt");
        } finally {
          replacement.release();
          await replacementAcpTurn;
        }
        const queuedAcpChild = "agent:main:acp:native-queued-successor";
        const queuedAcpRunId = "run-native-acp-queued";
        await initializeAcpSession(queuedAcpChild, "session-native-acp-queued-successor");
        const queuedTargetEntered = createDeferred();
        const queuedTargetSubmitted = createDeferred();
        const queuedTurnOrder: string[] = [];
        const queuedTargetEvents: AcpRuntimeEvent[] = [];
        const queuedAdmission = createDeferred<AcpRunTurnInput["admittedRunContext"]>();
        const queuedTargetTurn = runAcpTurn(
          {
            sessionKey: queuedAcpChild,
            text: "Keep the target active while its same-id successor queues.",
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
        const targetTurnStart = (await traceEntries("turn/start")).at(-1);
        expect(targetTurnStart).toMatchObject({
          threadId: expect.any(String),
          turnId: expect.any(String),
        });
        const interruptsBeforeQueuedCancel = (await traceEntries("turn/interrupt")).length;
        const successor = heldElicitation("complete successor", () =>
          queuedTurnOrder.push("successor-entered"),
        );
        const queuedSuccessorEvents: AcpRuntimeEvent[] = [];
        const queuedSuccessorTurn = runAcpTurn({
          sessionKey: queuedAcpChild,
          text: "Complete the same-id successor without inheriting cancellation.",
          requestId: queuedAcpRunId,
          onElicitation: successor.onElicitation,
          onEvent: (event) => {
            queuedSuccessorEvents.push(event);
          },
        });
        const queuedCancelPromise = cancelAcp(queuedAcpChild, queuedAcpRunId, queuedTargetContext);
        // Cancellation joins the native interrupt and target turn; the fixture traces before replying.
        await withinTest(queuedCancelPromise, signal);
        const interruptsAfterTargetCancel = await traceEntries("turn/interrupt");
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
        await successor.entered;
        expect(queuedTurnOrder).toEqual(["target-cancelled", "successor-entered"]);
        const successorTurnStart = (await traceEntries("turn/start")).at(-1);
        expect(successorTurnStart?.threadId).toBe(targetTurnStart?.threadId);
        expect(successorTurnStart?.turnId).toEqual(expect.any(String));
        expect(successorTurnStart?.turnId).not.toBe(targetTurnStart?.turnId);
        successor.release();
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
        const interruptsAfterSuccessor = await traceEntries("turn/interrupt");
        expect(
          interruptsAfterSuccessor.filter((entry) => entry.turnId === successorTurnStart?.turnId),
        ).toHaveLength(0);
      } finally {
        scheduler.beginClose();
        try {
          await acpxService.stop?.(acpxServiceContext);
        } finally {
          await scheduler.stop();
        }
      }
    },
  );
}, 90_000);
