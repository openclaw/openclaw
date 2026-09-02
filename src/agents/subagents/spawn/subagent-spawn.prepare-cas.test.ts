import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  getRuntimeConfig,
} from "../../../config/config.js";
import { loadSessionEntry } from "../../../config/sessions/session-accessor.js";
import { LegacyContextEngine } from "../../../context-engine/legacy.js";
import { registerChatAbortController } from "../../../gateway/chat-abort.js";
import { createChatAbortContext } from "../../../gateway/server-methods/chat.abort.test-helpers.js";
import { sessionDeleteHandlers } from "../../../gateway/server-methods/sessions-delete.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import { createSyntheticPluginRuntimeClient } from "../../../gateway/server-plugin-runtime-client.js";
import { flushLogger, resetLogger } from "../../../logging/logger.js";
import {
  bindGatewayContextResolver,
  withPluginRuntimeGatewayRequestScope,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import { resetTaskFlowRegistryForTests } from "../../../tasks/task-flow-registry.test-support.js";
import * as taskControlRuntime from "../../../tasks/task-registry-control.runtime.js";
import { findTaskByRunId } from "../../../tasks/task-registry.js";
import {
  resetTaskRegistryControlRuntimeForTests,
  resetTaskRegistryForTests,
  setTaskRegistryControlRuntimeForTests,
} from "../../../tasks/task-registry.test-support.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../../test-utils/session-state-cleanup.js";
import {
  createOperationalRunInstanceRef,
  getAdmittedRunDelegatedAuthority,
  prepareAgentRunAdmission,
} from "../../admitted-run-context.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { prepareCollectorRun, reserveCollectorRun } from "../registry/subagent-registry.js";
import {
  settleSubagentRegistryPersistenceWork,
  writeSubagentSessionEntry,
} from "../registry/subagent-registry.persistence.test-support.js";
import { loadSubagentRegistryFromSqlite } from "../registry/subagent-registry.store.sqlite.js";
import {
  resetSubagentRegistryForTests,
  testing as registryTesting,
} from "../registry/subagent-registry.test-helpers.js";
import { testing as schedulerTesting } from "../swarm/swarm-scheduler.test-support.js";
import { spawnSubagentDirect } from "./subagent-spawn.js";
import { testing as spawnTesting } from "./subagent-spawn.test-support.js";

const parentSessionKey = "agent:main:main";
const parentRunId = "prepare-cas-parent";
const env = captureEnv(["OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"]);
let stateDir = "";

beforeEach(async () => {
  stateDir = await realpath(await mkdtemp(path.join(os.tmpdir(), "openclaw-spawn-cas-")));
  setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
  setTestEnvValue("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
  await writeFile(
    path.join(stateDir, "openclaw.json"),
    JSON.stringify({
      logging: { audit: { enabled: false } },
      tools: { swarm: { enabled: true, maxConcurrent: 1 } },
      agents: { defaults: { workspace: stateDir }, entries: { main: { workspace: stateDir } } },
    }),
  );
  clearConfigCache();
  clearRuntimeConfigSnapshot();
  resetSubagentRegistryForTests({ persist: false });
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  setTaskRegistryControlRuntimeForTests(taskControlRuntime);
  registryTesting.setDepsForTest({
    loadAgentRuntimePluginRegistryHandle: () => undefined,
    callGateway: async () => await new Promise<never>(() => {}),
  });
});

afterEach(async () => {
  await settleSubagentRegistryPersistenceWork();
  resetSubagentRegistryForTests({ persist: false });
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  schedulerTesting.reset();
  resetTaskRegistryControlRuntimeForTests();
  await cleanupSessionStateForTest({ stateDir });
  registryTesting.setDepsForTest();
  spawnTesting.setDepsForTest();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  await flushLogger();
  resetLogger();
  await rm(stateDir, { recursive: true, force: true });
  env.restore();
});

async function createBoundParent() {
  const cfg = getRuntimeConfig();
  const storePath = await writeSubagentSessionEntry({
    stateDir,
    agentId: "main",
    sessionKey: parentSessionKey,
    defaultSessionId: "parent-session",
  });
  const context = createChatAbortContext({
    getRuntimeConfig: () => cfg,
    getSessionEventSubscriberConnIds: () => new Set(),
    broadcastToConnIds: vi.fn(),
  });
  const admission = prepareAgentRunAdmission({
    cfg,
    operationalRunInstance: createOperationalRunInstanceRef(parentRunId),
    facts: {
      runId: parentRunId,
      agentId: "main",
      ingress: { kind: "system", boundary: "spawn-cas-test", state: "present" },
    },
  });
  const parent = registerChatAbortController({
    chatAbortControllers: context.chatAbortControllers,
    runId: parentRunId,
    sessionKey: parentSessionKey,
    sessionId: "parent-session",
    agentId: "main",
    ownerConnId: "owner-connection",
    timeoutMs: 60_000,
    operationalRunInstance: admission.operationalRunInstance,
  });
  const admitted = await admission.admit("embedded");
  bindGatewayContextResolver(admitted, () => context as unknown as GatewayRequestContext);
  parent.bindAgentRunDelegatedAuthority(getAdmittedRunDelegatedAuthority(admitted)!);
  return { storePath, context, admission, parent };
}

describe("collector prepare CAS", () => {
  it("rolls the run CAS back when queued task persistence fails, then retries", async () => {
    const { storePath, admission, parent } = await createBoundParent();
    const providerDispatch = vi.fn(async () => await new Promise<never>(() => {}));
    registryTesting.setDepsForTest({
      loadAgentRuntimePluginRegistryHandle: () => undefined,
      callGateway: providerDispatch as typeof import("../../../gateway/call.js").callGateway,
    });
    const runId = "prepare-task-rollback";
    const childSessionKey = `agent:main:subagent:${runId}`;
    const registration = {
      runId,
      childSessionKey,
      requesterSessionKey: parentSessionKey,
      requesterDisplayKey: parentSessionKey,
      requesterAgentId: "main",
      agentId: "main",
      task: "rollback queued task",
      cleanup: "keep" as const,
      collect: true,
      queued: true,
      swarmRequesterSessionKey: parentSessionKey,
      swarmLaunchIdempotencyKey: runId,
      swarmLaunchReplayKey: runId,
      swarmLaunchRequestFingerprint: "sha256:prepare-task-rollback",
      groupId: "prepare-cas",
      queuedLaunch: {
        request: {
          idempotencyKey: runId,
          sessionKey: childSessionKey,
          message: "rollback queued task",
        },
        timeoutMs: 1_000,
        schedulerGroupKey: "prepare-cas",
        maxConcurrent: 1,
      },
    };

    try {
      const reservation = reserveCollectorRun(registration);
      const database = openOpenClawStateDatabase();
      const eventCountBefore = Number(
        (
          database.db.prepare("SELECT COUNT(*) AS count FROM session_state_events").get() as {
            count: number | bigint;
          }
        ).count,
      );
      database.db.exec(
        "CREATE TEMP TRIGGER fail_collector_task_insert AFTER INSERT ON task_runs BEGIN SELECT RAISE(ABORT, 'injected task persistence failure'); END",
      );
      try {
        expect(() => prepareCollectorRun(reservation, registration)).toThrow(
          "injected task persistence failure",
        );
        expect(subagentRuns.get(runId)).toBe(reservation.expected);
        expect(subagentRuns.get(runId)).toMatchObject({
          collectorLaunchPhase: "reserved",
          execution: { status: "queued" },
        });
        expect(loadSubagentRegistryFromSqlite().get(runId)).toMatchObject({
          collectorLaunchPhase: "reserved",
          execution: { status: "queued" },
        });
        expect(
          database.db
            .prepare("SELECT COUNT(*) AS count FROM task_runs WHERE run_id = ?")
            .get(runId),
        ).toMatchObject({ count: 0 });
        expect(findTaskByRunId(runId)).toBeUndefined();
        expect(loadSessionEntry({ storePath, sessionKey: childSessionKey })).toBeUndefined();
        expect(
          database.db.prepare("SELECT COUNT(*) AS count FROM session_state_events").get(),
        ).toMatchObject({ count: eventCountBefore });
        expect(providerDispatch).not.toHaveBeenCalled();
      } finally {
        database.db.exec("DROP TRIGGER fail_collector_task_insert");
      }

      expect(() => prepareCollectorRun(reservation, registration)).not.toThrow();
      expect(subagentRuns.get(runId)).toMatchObject({
        collectorLaunchPhase: "prepared",
        execution: { status: "queued" },
      });
      expect(loadSubagentRegistryFromSqlite().get(runId)).toMatchObject({
        collectorLaunchPhase: "prepared",
        execution: { status: "queued" },
      });
      expect(findTaskByRunId(runId)).toMatchObject({ runId, status: "queued" });
      expect(
        database.db.prepare("SELECT COUNT(*) AS count FROM task_runs WHERE run_id = ?").get(runId),
      ).toMatchObject({ count: 1 });
      expect(loadSessionEntry({ storePath, sessionKey: childSessionKey })).toBeUndefined();
      expect(providerDispatch).not.toHaveBeenCalled();
    } finally {
      admission.close();
      parent.cleanup();
    }
  });

  it("cleans the provisional session without provider dispatch when the reservation is lost", async () => {
    const { storePath, context, admission, parent } = await createBoundParent();
    const providerDispatch = vi.fn();
    const rollback = vi.fn(async () => {});
    let childSessionKey = "";
    let runId = "";
    spawnTesting.setDepsForTest({
      resolveContextEngine: async () =>
        Object.assign(new LegacyContextEngine(), {
          prepareSubagentSpawn: async (input: { childSessionKey: string }) => {
            childSessionKey = input.childSessionKey;
            const reserved = [...subagentRuns.values()].find(
              (entry) =>
                entry.childSessionKey === childSessionKey &&
                entry.collectorLaunchPhase === "reserved",
            );
            if (!reserved) {
              throw new Error("missing collector reservation");
            }
            runId = reserved.runId;
            expect(registryTesting.failQueuedSubagentRun(runId, "injected CAS conflict")).toBe(
              true,
            );
            return { rollback };
          },
        }),
      dispatchGatewayMethodInProcess: async <T>(
        method: string,
        params: Record<string, unknown>,
      ) => {
        if (method === "agent") {
          providerDispatch();
          return { status: "accepted" } as T;
        }
        if (method !== "sessions.delete") {
          throw new Error(`Unexpected CAS cleanup RPC ${method}`);
        }
        let payload: unknown;
        await sessionDeleteHandlers["sessions.delete"]!({
          req: {} as never,
          params,
          context: context as unknown as GatewayRequestContext,
          client: createSyntheticPluginRuntimeClient(),
          isWebchatConnect: () => false,
          respond: (ok, result, error) => {
            if (!ok) {
              throw new Error(error?.message ?? "delete failed");
            }
            payload = result;
          },
        });
        return payload as T;
      },
    });

    try {
      const result = await withPluginRuntimeGatewayRequestScope(
        { context: context as unknown as GatewayRequestContext, isWebchatConnect: () => false },
        () =>
          spawnSubagentDirect(
            {
              task: "lose prepare CAS",
              collect: true,
              context: "isolated",
              lightContext: false,
              groupId: "prepare-cas",
            },
            { agentSessionKey: parentSessionKey, requesterRunId: parentRunId },
          ),
      );

      expect(runId).not.toBe("");
      expect(result).toMatchObject({
        status: "error",
        error: expect.stringContaining("Failed to register subagent run"),
      });
      expect(providerDispatch).not.toHaveBeenCalled();
      expect(findTaskByRunId(runId)).toBeUndefined();
      await vi.waitFor(() =>
        expect(loadSessionEntry({ storePath, sessionKey: childSessionKey })).toBeUndefined(),
      );
      expect(rollback).toHaveBeenCalledOnce();
    } finally {
      admission.close();
      parent.cleanup();
    }
  });
});
