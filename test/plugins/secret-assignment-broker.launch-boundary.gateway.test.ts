/**
 * Real launch-boundary proof for the secret-assignment broker.
 *
 * The authority-chain suite inspects authorization results; this suite drives
 * the real `exec` tool for a Gateway-hosted run against a live process
 * supervisor and observes the real child's outcome. It proves final effect:
 * - an assigned agent's real child receives exactly its assigned entry
 * - an unassigned agent's real child receives none of the store entries
 * - revoking the assignment withholds the entry from the next real launch
 *
 * Only synthetic names and values appear here; no real secrets.
 */
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import brokerPlugin from "../../extensions/secret-assignment-broker/index.js";
import { resetProcessRegistryForTests } from "../../src/agents/bash-process-registry.test-support.js";
import { createExecTool } from "../../src/agents/bash-tools.exec-run.js";
import { saveExecApprovals } from "../../src/infra/exec-approvals.js";
import { createPluginStateKeyedStoreForTests } from "../../src/plugin-sdk/plugin-state-test-runtime.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../src/plugins/hook-runner-global.js";
import { runPluginRegisterSyncInRegistry } from "../../src/plugins/loader-module-runtime.js";
import { createPluginRegistry } from "../../src/plugins/registry.js";
import {
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../src/plugins/runtime.js";
import { createPluginRecord } from "../../src/plugins/status.test-fixtures.js";
import { writeSecretStoreEntry } from "../../src/secrets/store/secret-store.js";
import { closeOpenClawStateDatabaseForTest } from "../../src/state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../../src/test-utils/env.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const boundary = vi.hoisted(() => ({
  spawn: vi.fn<(...args: unknown[]) => unknown>(),
}));

vi.mock("../../src/process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({ spawn: boundary.spawn }),
}));

const PLUGIN_ID = "secret-assignment-broker";
const NAMESPACE = "agent-assignments";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type LiveSupervisor = ReturnType<
  typeof import("../../src/process/supervisor/supervisor.js").createProcessSupervisor
>;

/** Registers the real broker against a host keyed store and installs the hook runner. */
function registerBroker() {
  const keyed = createPluginStateKeyedStoreForTests<unknown>(PLUGIN_ID, {
    namespace: NAMESPACE,
    maxEntries: 10_000,
  });
  const builder = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: { state: { openKeyedStore: () => keyed } } as never,
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({
    id: PLUGIN_ID,
    source: `/source/extensions/${PLUGIN_ID}/index.ts`,
    origin: "bundled",
    enabled: true,
    configSchema: false,
  });
  builder.registry.plugins.push(record);
  const api = builder.createApi(record, { config: {} });
  runPluginRegisterSyncInRegistry(brokerPlugin.register!, api, builder.registry, PLUGIN_ID);
  setActivePluginRegistry(builder.registry);
  initializeGlobalHookRunner(builder.registry);
  return keyed;
}

describe.skipIf(process.platform === "win32")("secret-assignment broker launch boundary", () => {
  let root: string;
  let envSnapshot: ReturnType<typeof captureEnv>;
  let supervisor: LiveSupervisor | undefined;

  beforeEach(async () => {
    envSnapshot = captureEnv([
      "HOME",
      "USERPROFILE",
      "OPENCLAW_HOME",
      "OPENCLAW_STATE_DIR",
      "PATH",
      "SHELL",
      "ZDOTDIR",
    ]);
    resetGlobalHookRunner();
    resetPluginRuntimeStateForTest();
    resetProcessRegistryForTests();
    root = fs.realpathSync(tempDirs.make("broker-launch-boundary-"));
    for (const key of ["HOME", "USERPROFILE", "OPENCLAW_HOME", "ZDOTDIR"]) {
      setTestEnvValue(key, root);
    }
    setTestEnvValue("OPENCLAW_STATE_DIR", `${root}/state`);
    setTestEnvValue("PATH", "/usr/bin:/bin");
    setTestEnvValue("SHELL", "/bin/bash");
    saveExecApprovals({ version: 1, defaults: { security: "full", ask: "off" }, agents: {} });
    writeSecretStoreEntry({
      scope: { kind: "team" },
      name: "DEPLOY_ENV_A",
      value: "synthetic-a",
      kind: "env",
      updatedBy: "test",
    });
    writeSecretStoreEntry({
      scope: { kind: "team" },
      name: "DEPLOY_ENV_B",
      value: "synthetic-b",
      kind: "env",
      updatedBy: "test",
    });
    const { createProcessSupervisor } = await import("../../src/process/supervisor/supervisor.js");
    supervisor = createProcessSupervisor();
    boundary.spawn
      .mockReset()
      .mockImplementation((input: unknown) =>
        (supervisor as NonNullable<typeof supervisor>).spawn(input as never),
      );
  });

  afterEach(async () => {
    await supervisor?.shutdown();
    supervisor = undefined;
    resetProcessRegistryForTests();
    resetGlobalHookRunner();
    resetPluginRuntimeStateForTest();
    closeOpenClawStateDatabaseForTest();
    envSnapshot?.restore();
  });

  function gatewayExec(agentId: string) {
    return createExecTool({
      host: "gateway",
      security: "full",
      ask: "off",
      bypassHostApprovalFloors: true,
      agentId,
      runId: `launch-${agentId}`,
      notifyOnExit: false,
      cwd: root,
    });
  }

  it("delivers only the assigned entry and withholds the sibling from the real child process", async () => {
    const keyed = registerBroker();
    await keyed.register("agent-assigned", { mode: "selected", names: ["DEPLOY_ENV_A"] });

    const result = await gatewayExec("agent-assigned").execute("launch-assigned", {
      // Prints the assigned entry and the unassigned sibling so the real child
      // outcome shows both the delivered and the withheld effect.
      command: 'printf "[%s][%s]" "$DEPLOY_ENV_A" "$DEPLOY_ENV_B"',
      yieldMs: 120_000,
    });

    expect(result.details.status).toBe("completed");
    expect(result.details.aggregated).toBe("[synthetic-a][]");
  });

  it("withholds every store entry from an unassigned agent's real child process", async () => {
    registerBroker();

    const result = await gatewayExec("agent-unassigned").execute("launch-unassigned", {
      command: 'printf "[%s][%s]" "$DEPLOY_ENV_A" "$DEPLOY_ENV_B"',
      yieldMs: 120_000,
    });

    expect(result.details.status).toBe("completed");
    expect(result.details.aggregated).toBe("[][]");
  });

  it("withholds a revoked entry from the next real launch", async () => {
    const keyed = registerBroker();
    await keyed.register("agent-revoked", { mode: "selected", names: ["DEPLOY_ENV_A"] });

    const before = await gatewayExec("agent-revoked").execute("launch-before-revoke", {
      command: 'printf "[%s]" "$DEPLOY_ENV_A"',
      yieldMs: 120_000,
    });
    expect(before.details.status).toBe("completed");
    expect(before.details.aggregated).toBe("[synthetic-a]");

    // Revoke, then run a fresh tool instance; the next real child must not see
    // the revoked entry.
    await keyed.register("agent-revoked", { mode: "none" });
    const after = await gatewayExec("agent-revoked").execute("launch-after-revoke", {
      command: 'printf "[%s]" "$DEPLOY_ENV_A"',
      yieldMs: 120_000,
    });

    expect(after.details.status).toBe("completed");
    expect(after.details.aggregated).toBe("[]");
  });
});
