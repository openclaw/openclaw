import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import { observeRootWork } from "../../agents/subagents/registry/subagent-registry.browser-cleanup.test-support.js";
import { settleSubagentRegistryPersistenceWork } from "../../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import { resetSubagentRegistryForTests } from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import { testing as schedulerTesting } from "../../agents/subagents/swarm/swarm-scheduler.test-support.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../../config/config.js";
import { captureRuntimeConfigAsyncReader } from "../../config/io.runtime.js";
import { LegacyContextEngine } from "../../context-engine/legacy.js";
import { getActiveGatewayRootWorkCount } from "../../process/gateway-work-admission.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";

vi.mock("../server-recovery-runtime-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server-recovery-runtime-context.js")>()),
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
  const settle = (keepObserving = true) =>
    settleSubagentRegistryPersistenceWork(() => settleRootWork(keepObserving));
  beforeEach(async () => {
    // A failed drain retains its stores; the next case must not replace their owner.
    if (stateDir) {
      throw new Error("Previous chat abort registry fixture cleanup is incomplete");
    }
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
    await settle(false).catch(recordFailure);
    // Delivery results can settle before their detached root's cleanup tail.
    if (getActiveGatewayRootWorkCount() === 0) {
      try {
        await resetSubagentRegistryForTests({ persist: false });
        schedulerTesting.reset();
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

  return {
    settle,
    get stateDir() {
      return stateDir;
    },
  };
}
