import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import * as artifacts from "./update-managed-service-handoff-artifacts.test-support.js";
import { createManagedServiceManagerBoundary as managerBoundary } from "./update-managed-service-handoff-boundary.test-support.js";
import { createManagedServiceChildMock as childMock } from "./update-managed-service-handoff-command.test-support.js";
import { signalMockManagedUpdateHandoffReady as signalReady } from "./update-managed-service-handoff.test-support.js";

const { kill, tmp, spawn } = vi.hoisted(() => ({
  kill: vi.fn(),
  tmp: vi.fn(),
  spawn: vi.fn(),
}));

const mockedChildren = new Set<ReturnType<typeof createSpawnMock>>();

export function createSpawnMock(params?: { pid?: number }) {
  const child = childMock(params);
  mockedChildren.add(child);
  return child;
}

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn,
}));

vi.mock("../process/child-process-tree.js", async (original) => ({
  ...(await original<typeof import("../process/child-process-tree.js")>()),
  forceKillChildProcessTree: kill,
}));

vi.mock("./tmp-openclaw-dir.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tmp-openclaw-dir.js")>()),
  resolvePreferredOpenClawTmpDir: tmp,
}));

export function useManagedServiceHandoffLifecycleFixture() {
  const tempDirs = artifacts.createManagedHandoffTempDirTracker();
  const processCleanups = new Set<() => Promise<void>>();
  const leaseCleanups = new Set<() => void>();
  const handoffs = new Map<string, string>();

  beforeEach(() => {
    // Helpers in one fixture share a coordinator without touching the operator's database.
    tmp.mockReturnValue(tempDirs.make("openclaw-handoff-coordinator-"));
    kill.mockReset();
    spawn.mockReset();
    spawn.mockImplementation((_command: string, args: string[]) => {
      const child = createSpawnMock();
      const { paramsPath } = artifacts.readManagedHandoffArtifacts(args);
      const params: { updateLeaseKey: string; handoffId: string } = JSON.parse(
        readFileSync(paramsPath, "utf8"),
      );
      handoffs.set(params.updateLeaseKey, params.handoffId);
      process.nextTick(() => signalReady({ child, paramsPath, cleanups: leaseCleanups }));
      return child;
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all([...processCleanups].map((cleanup) => cleanup()));
    processCleanups.clear();
    for (const child of mockedChildren) {
      child.emit("exit", 0, null);
    }
    for (const cleanup of leaseCleanups) {
      cleanup();
    }
    try {
      const { cancelManagedServiceUpdateHandoff: cancel } =
        await import("./update-managed-service-handoff.js");
      for (const [installRoot, handoffId] of handoffs) {
        // Cancellation retires the exited owner only after verifying its lease was released.
        await expect(
          cancel({ kind: "managed-update-handoff", installRoot, handoffId }),
        ).resolves.toBe("restored-in-process");
      }
    } finally {
      handoffs.clear();
      for (const child of mockedChildren) {
        child.stdin.destroy();
        child.stdout.destroy();
      }
      mockedChildren.clear();
      await closeStateDatabaseForTest();
      await tempDirs.cleanup();
    }
  });

  return {
    forceKillChildProcessTreeMock: kill,
    resolvePreferredOpenClawTmpDirMock: tmp,
    spawnMock: spawn,
    tempDirs,
    runManagedServiceManagerBoundary: managerBoundary({
      spawnMock: spawn,
      tempDirs,
      cleanups: processCleanups,
    }),
  };
}
