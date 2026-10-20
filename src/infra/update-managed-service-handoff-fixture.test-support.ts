import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import {
  createManagedHandoffTempDirTracker,
  readManagedHandoffArtifacts,
} from "./update-managed-service-handoff-artifacts.test-support.js";
import { createManagedServiceManagerBoundary } from "./update-managed-service-handoff-boundary.test-support.js";
import { signalMockManagedUpdateHandoffReady } from "./update-managed-service-handoff.test-support.js";

const { forceKillChildProcessTreeMock, resolvePreferredOpenClawTmpDirMock, spawnMock } = vi.hoisted(
  () => ({
    forceKillChildProcessTreeMock: vi.fn(),
    resolvePreferredOpenClawTmpDirMock: vi.fn(),
    spawnMock: vi.fn(),
  }),
);

const mockedChildren = new Set<ReturnType<typeof createSpawnMock>>();

export function createSpawnMock(params?: { pid?: number }) {
  const child = Object.assign(new EventEmitter(), {
    pid: params?.pid ?? process.pid,
    exitCode: null,
    signalCode: null,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    unref: vi.fn(),
  });
  mockedChildren.add(child);
  return child;
}

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: spawnMock,
}));

vi.mock("../process/child-process-tree.js", async (original) => ({
  ...(await original<typeof import("../process/child-process-tree.js")>()),
  forceKillChildProcessTree: forceKillChildProcessTreeMock,
}));

vi.mock("./tmp-openclaw-dir.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tmp-openclaw-dir.js")>()),
  resolvePreferredOpenClawTmpDir: resolvePreferredOpenClawTmpDirMock,
}));

export function useManagedServiceHandoffLifecycleFixture() {
  const tempDirs = createManagedHandoffTempDirTracker();
  const managedProcessCleanups = new Set<() => Promise<void>>();
  const mockedHandoffLeaseCleanups = new Set<() => void>();
  const mockedHandoffs = new Map<string, string>();

  beforeEach(() => {
    // Helpers in one fixture share a coordinator without touching the operator's database.
    resolvePreferredOpenClawTmpDirMock.mockReturnValue(
      tempDirs.make("openclaw-handoff-coordinator-"),
    );
    forceKillChildProcessTreeMock.mockReset();
    spawnMock.mockReset();
    spawnMock.mockImplementation((_command: string, args: string[]) => {
      const child = createSpawnMock();
      const { paramsPath } = readManagedHandoffArtifacts(args);
      const params = JSON.parse(readFileSync(paramsPath, "utf8")) as {
        updateLeaseKey: string;
        handoffId: string;
      };
      mockedHandoffs.set(params.updateLeaseKey, params.handoffId);
      process.nextTick(() => {
        signalMockManagedUpdateHandoffReady({
          child,
          paramsPath,
          cleanups: mockedHandoffLeaseCleanups,
        });
      });
      return child;
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all([...managedProcessCleanups].map((cleanup) => cleanup()));
    managedProcessCleanups.clear();
    for (const child of mockedChildren) {
      child.emit("exit", 0, null);
    }
    for (const cleanup of mockedHandoffLeaseCleanups) {
      cleanup();
    }
    try {
      if (mockedHandoffs.size > 0) {
        const { cancelManagedServiceUpdateHandoff } =
          await import("./update-managed-service-handoff.js");
        for (const [installRoot, handoffId] of mockedHandoffs) {
          // Cancellation retires the exited owner only after verifying its lease was released.
          await expect(
            cancelManagedServiceUpdateHandoff({
              kind: "managed-update-handoff",
              installRoot,
              handoffId,
            }),
          ).resolves.toBe("restored-in-process");
        }
      }
    } finally {
      mockedHandoffs.clear();
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
    forceKillChildProcessTreeMock,
    resolvePreferredOpenClawTmpDirMock,
    spawnMock,
    tempDirs,
    runManagedServiceManagerBoundary: createManagedServiceManagerBoundary({
      spawnMock,
      tempDirs,
      cleanups: managedProcessCleanups,
    }),
  };
}
