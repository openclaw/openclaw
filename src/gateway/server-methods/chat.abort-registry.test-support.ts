import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import { observeRootWork } from "../../agents/subagents/registry/subagent-registry.browser-cleanup.test-support.js";
import { registerSubagentRun } from "../../agents/subagents/registry/subagent-registry.js";
import {
  settleSubagentRegistryPersistenceWork,
  writeSubagentSessionEntry,
} from "../../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import { resetSubagentRegistryForTests } from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import {
  enqueueSwarmRun,
  observeSwarmSchedulerWork,
} from "../../agents/subagents/swarm/swarm-scheduler.lifecycle.test-support.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../../config/config.js";
import { captureRuntimeConfigAsyncReader } from "../../config/io.runtime.js";
import { loadExactSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import { LegacyContextEngine } from "../../context-engine/legacy.js";
import { getActiveGatewayRootWorkCount } from "../../process/gateway-work-admission.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";

type RegisteredRun = Parameters<typeof registerSubagentRun>[0];
type RunDefaults = "requesterAgentId" | "requesterDisplayKey" | "task" | "cleanup" | "collect";
type FixtureRun = Omit<RegisteredRun, RunDefaults> & Partial<Pick<RegisteredRun, RunDefaults>>;
type QueuedRun = Parameters<typeof enqueueSwarmRun>[0];
type SeedRun = Omit<FixtureRun, "sessionEntry" | "childAgentId" | "requesterSessionKey"> &
  Partial<Pick<FixtureRun, "childAgentId" | "requesterSessionKey">> & {
    sessionId?: string;
    lifecycleRevision?: string;
  };

vi.mock("../server-lifecycle-runtime-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server-lifecycle-runtime-context.js")>()),
  bindGatewayLifecycleRequest:
    () =>
    async ({ method }: { method: string }) => {
      if (method !== "agent.wait") {
        throw new Error(`Unexpected registry RPC ${method}`);
      }
      return await new Promise<never>(() => {});
    },
}));
vi.mock("../../browser-lifecycle-cleanup.js", () => ({
  cleanupBrowserSessionsForLifecycleEnd: async () => {},
}));
vi.mock("../../agents/runtime-plugins.js", async () => {
  const { createEmptyPluginRegistry } = await import("../../plugins/registry-empty.js");
  return { loadAgentRuntimePluginRegistryHandle: createEmptyPluginRegistry };
});
vi.mock("../../context-engine/registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../context-engine/registry.js")>()),
  resolveContextEngine: async () => new LegacyContextEngine(),
}));

export function useChatAbortRegistryFixture() {
  const env = captureEnv(["OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"]);
  let stateDir = "";
  let releaseProfileCatalog: (() => void) | undefined;
  let settleRootWork: ReturnType<typeof observeRootWork>;
  let schedulerWork: ReturnType<typeof observeSwarmSchedulerWork>;
  const settle = (keepObserving = true) =>
    settleSubagentRegistryPersistenceWork(() => settleRootWork(keepObserving));
  beforeEach(async () => {
    // A failed drain retains its stores; the next case must not replace their owner.
    if (stateDir) {
      throw new Error("Previous chat abort registry fixture cleanup is incomplete");
    }
    schedulerWork = observeSwarmSchedulerWork();
    stateDir = await realpath(await mkdtemp(path.join(os.tmpdir(), "openclaw-abort-errors-")));
    const config = { agents: { defaults: { workspace: stateDir } }, browser: { enabled: false } };
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    setTestEnvValue("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
    await writeFile(path.join(stateDir, "openclaw.json"), JSON.stringify(config));
    clearConfigCache();
    clearRuntimeConfigSnapshot();
    await captureRuntimeConfigAsyncReader()();
    releaseProfileCatalog = (await prepareUserProfileCatalog()).release;
    settleRootWork = observeRootWork();
  });
  afterEach(async () => {
    const failures: unknown[] = [];
    const recordFailure = (error: unknown) => {
      failures.push(error);
    };
    let schedulerClosed = false;
    await schedulerWork.close().then(() => {
      schedulerClosed = true;
    }, recordFailure);
    await settle(false).catch(recordFailure);
    // Delivery results can settle before their detached root's cleanup tail.
    if (schedulerClosed && getActiveGatewayRootWorkCount() === 0) {
      try {
        await resetSubagentRegistryForTests({ persist: false });
        releaseProfileCatalog?.();
        releaseProfileCatalog = undefined;
        await cleanupSessionStateForTest({ stateDir: stateDir || undefined });
        clearConfigCache();
        clearRuntimeConfigSnapshot();
        if (stateDir) {
          // Resource cleanup finished; removal failure must not retain a retired owner.
          await rm(stateDir, { recursive: true, force: true }).catch(recordFailure);
        }
        env.restore();
        stateDir = "";
      } catch (error) {
        recordFailure(error);
      }
    }
    if (failures.length) {
      throw failures.length === 1
        ? failures[0]
        : new AggregateError(failures, "Chat abort registry fixture cleanup failed");
    }
  });

  const registerRun = (params: FixtureRun) =>
    registerSubagentRun({
      requesterAgentId: "main",
      requesterDisplayKey: params.requesterSessionKey,
      task: params.runId,
      cleanup: "keep",
      collect: true,
      ...params,
    });
  return {
    settle,
    writeSession: (sessionKey: string, sessionId: string) =>
      writeSubagentSessionEntry({
        stateDir,
        agentId: "main",
        sessionKey,
        defaultSessionId: sessionId,
      }),
    registerRun,
    async seedRun(params: SeedRun) {
      const {
        sessionId = `${params.runId}-session`,
        lifecycleRevision,
        childAgentId = "main",
        requesterSessionKey = "agent:main:main",
        ...run
      } = params;
      const storePath = await writeSubagentSessionEntry({
        stateDir,
        agentId: childAgentId,
        sessionKey: params.childSessionKey,
        defaultSessionId: sessionId,
        lifecycleRevision,
      });
      await registerRun({
        requesterTurnRunId: "parent",
        expectsCompletionMessage: false,
        ...run,
        childAgentId,
        requesterSessionKey,
        sessionEntry: loadExactSessionEntryReadOnly({
          storePath,
          sessionKey: params.childSessionKey,
        })?.entry,
      });
      return storePath;
    },
    queueRun: (params: Omit<QueuedRun, "maxConcurrent" | "onStartFailure">) =>
      enqueueSwarmRun({ maxConcurrent: 1, onStartFailure: () => true, ...params }),
    get stateDir() {
      return stateDir;
    },
  };
}
