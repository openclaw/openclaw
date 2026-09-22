/** Shared real SQLite/registry lifetime for cancellation boundary tests. */
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import { settleSubagentRegistryPersistenceWork } from "../../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import { resetSubagentRegistryForTests } from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import { testing as schedulerTesting } from "../../agents/subagents/swarm/swarm-scheduler.test-support.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../../config/config.js";
import { LegacyContextEngine } from "../../context-engine/legacy.js";
import { getActiveGatewayRootWorkCount } from "../../process/gateway-work-admission.js";
import { resetTaskFlowRegistryForTests } from "../../tasks/task-flow-registry.test-support.js";
import { captureTaskDeliveryWork } from "../../tasks/task-registry-delivery.test-support.js";
import { resetTaskRegistryForTests } from "../../tasks/task-registry.test-support.js";
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
  let deliveries: ReturnType<typeof captureTaskDeliveryWork> | undefined;
  const settle = () => settleSubagentRegistryPersistenceWork(deliveries);
  beforeEach(async () => {
    // A failed drain retains its stores; the next case must not replace their owner.
    if (stateDir) {
      throw new Error("Previous chat abort registry fixture cleanup is incomplete");
    }
    stateDir = await realpath(await mkdtemp(path.join(os.tmpdir(), "openclaw-abort-errors-")));
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    setTestEnvValue("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
    await writeFile(
      path.join(stateDir, "openclaw.json"),
      JSON.stringify({
        agents: { defaults: { workspace: stateDir } },
        browser: { enabled: false },
      }),
    );
    clearConfigCache();
    clearRuntimeConfigSnapshot();
    deliveries = captureTaskDeliveryWork();
  });
  afterEach(async () => {
    const failures: unknown[] = [];
    try {
      await settle();
    } catch (error) {
      failures.push(error);
    }
    // Delivery results can settle before their detached root's cleanup tail.
    if (getActiveGatewayRootWorkCount() === 0) {
      try {
        resetSubagentRegistryForTests({ persist: false });
        resetTaskRegistryForTests({ persist: false });
        resetTaskFlowRegistryForTests({ persist: false });
        schedulerTesting.reset();
        await cleanupSessionStateForTest({ stateDir: stateDir || undefined });
        clearConfigCache();
        clearRuntimeConfigSnapshot();
        if (stateDir) {
          // Resource cleanup finished; removal failure must not retain a retired owner.
          try {
            await rm(stateDir, { recursive: true, force: true });
          } catch (error) {
            failures.push(error);
          }
        }
        env.restore();
        deliveries?.[Symbol.dispose]();
        deliveries = undefined;
        stateDir = "";
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "Chat abort registry fixture cleanup failed");
    }
  });

  return {
    settle,
    get stateDir() {
      return stateDir;
    },
  };
}
