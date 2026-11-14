import "../test-utils/prepare-compiled-subprocesses.js";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import { registerSandboxBackend } from "../agents/sandbox/backend.js";
import { removeSandboxContainer } from "../agents/sandbox/manage.js";
import { updateRegistry } from "../agents/sandbox/registry.js";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { readClosedDatabase } from "./server-close.lifecycle.test-support.js";
import { createGatewayCloseRace } from "./server-close.race.test-support.js";
import * as restartResume from "./session-restart-resume.js";

// mock-isolation: Upstream polling is independent of sandbox removal settlement.
vi.mock("../sessions/session-upstream-monitor.js", () => ({
  startSessionUpstreamMonitor: () => ({ stop: () => Promise.resolve() }),
}));

it("joins accepted sandbox removal across scheduler cancellation after database reopen", async ({
  signal,
}) => {
  const race = await createGatewayCloseRace("gateway-sandbox-registry-close", signal);
  const { fixture, kernel } = race;
  const removeRuntime = vi.fn(async () => {});
  let removing: Promise<void> | undefined;
  const markers = vi
    .spyOn(restartResume, "persistRunningSessionsForRestart")
    .mockImplementation(() => race.block());
  race.onCleanup(() => markers.mockRestore());
  try {
    await closeOpenClawStateDatabaseAsync();
    const backendId = "sandbox-close-fixture";
    const containerName = "accepted-sandbox-removal";
    const unregisterBackend = registerSandboxBackend(backendId, {
      reserveRuntimeId: () => containerName,
      factory: async () => {
        throw new Error("Removal must not provision a backend");
      },
      manager: {
        describeRuntime: async () => ({ running: false, configLabelMatch: true }),
        removeRuntime,
      },
    });
    race.onCleanup(unregisterBackend);
    await updateRegistry({
      containerName,
      backendId,
      sessionKey: "agent:main:sandbox-close",
      createdAtMs: 1,
      lastUsedAtMs: 1,
      image: "synthetic-image",
      runtimeState: "ready",
    });
    const shared = openOpenClawStateDatabase({ env: fixture.state.env }).db;
    let acceptedSignal: AbortSignal | undefined;
    let paused = false;
    const worker = probe.command(stateWorker, async (command, executeOptions, scope) => {
      if (command.type === "sandboxRegistry.beginRemoval" && !paused) {
        paused = true;
        acceptedSignal = getAsyncWorkSignal();
        await race.block();
      }
      return scope.execute(command, executeOptions);
    });
    race.onCleanup(() => worker.mockRestore());
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    kernel.scheduler.schedule({
      id: "accepted-sandbox-removal",
      delayMs: 0,
      async run() {
        removing = removeSandboxContainer(containerName);
        await removing;
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
    await race.waitForEntry(
      expectDefined(removing, "Accepted sandbox removal"),
      "Sandbox removal settled before its worker command",
    );
    expect(acceptedSignal?.aborted).toBe(false);
    await race.close(kernel.scheduler.signal, undefined, { reason: "sandbox close" });
    expect(acceptedSignal?.aborted).toBe(false);
    expect(shared.isOpen).toBe(true);
    expect(removeRuntime).not.toHaveBeenCalled();
    await expect(removeSandboxContainer(containerName)).rejects.toThrow(
      "Sandbox registry admission is closed",
    );
    expect([markers.mock.calls.length, removeRuntime.mock.calls.length]).toEqual([1, 0]);
    await race.finish(removing);
    expect(removeRuntime).toHaveBeenCalledOnce();
    expect(shared.isOpen).toBe(false);
    const databasePath = resolveOpenClawStateSqlitePath(fixture.state.env);
    const rows = readClosedDatabase(
      databasePath,
      "SELECT container_name FROM sandbox_registry_entries",
    );
    expect(rows).toEqual([]);
  } finally {
    vi.useRealTimers();
    await race.dispose();
  }
});
