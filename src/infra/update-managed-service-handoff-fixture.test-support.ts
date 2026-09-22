import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createManagedServiceManagerBoundary } from "./update-managed-service-handoff-boundary.test-support.js";
import { signalMockManagedUpdateHandoffReady } from "./update-managed-service-handoff.test-support.js";

const { forceKillChildProcessTreeMock, resolvePreferredOpenClawTmpDirMock, spawnMock } = vi.hoisted(
  () => ({
    forceKillChildProcessTreeMock: vi.fn(),
    resolvePreferredOpenClawTmpDirMock: vi.fn(),
    spawnMock: vi.fn(),
  }),
);

type MockHandoffChild = EventEmitter & {
  pid: number;
  exitCode: null;
  signalCode: null;
  stdin: PassThrough;
  stdout: PassThrough;
  unref: ReturnType<typeof vi.fn>;
};
const mockedChildren = new Set<MockHandoffChild>();

export function createSpawnMock(params?: { pid?: number }): MockHandoffChild {
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

vi.mock("node:child_process", async () => {
  const { mockNodeChildProcessModule } =
    await import("../gateway/server-methods/node-child-process.test-support.js");
  return mockNodeChildProcessModule({
    spawn: spawnMock as unknown as typeof import("node:child_process").spawn,
  });
});

vi.mock("../process/child-process-tree.js", async () => {
  const actual = await vi.importActual<typeof import("../process/child-process-tree.js")>(
    "../process/child-process-tree.js",
  );
  return { ...actual, forceKillChildProcessTree: forceKillChildProcessTreeMock };
});

vi.mock("./tmp-openclaw-dir.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tmp-openclaw-dir.js")>()),
  resolvePreferredOpenClawTmpDir: resolvePreferredOpenClawTmpDirMock,
}));

export function useManagedServiceHandoffLifecycleFixture() {
  const tempDirs = new Set<string>();
  const managedProcessCleanups = new Set<() => Promise<void>>();
  const mockedHandoffLeaseCleanups = new Set<() => void>();
  const mockedHandoffs = new Map<string, { handoffId: string }>();

  beforeEach(async () => {
    // Helpers in one fixture share a coordinator without touching the operator's database.
    const coordinatorDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-handoff-coordinator-")),
    );
    tempDirs.add(coordinatorDir);
    resolvePreferredOpenClawTmpDirMock.mockReturnValue(coordinatorDir);
    forceKillChildProcessTreeMock.mockReset();
    spawnMock.mockReset();
    spawnMock.mockImplementation((_command: string, args: string[]) => {
      const child = createSpawnMock();
      const params = JSON.parse(readFileSync(args.at(-1) ?? "", "utf8")) as {
        updateLeaseKey: string;
        handoffId: string;
      };
      mockedHandoffs.set(params.updateLeaseKey, { handoffId: params.handoffId });
      process.nextTick(() => {
        signalMockManagedUpdateHandoffReady({
          child,
          paramsPath: args.at(-1) ?? "",
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
        for (const [installRoot, { handoffId }] of mockedHandoffs) {
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
      closeOpenClawStateDatabaseForTest();
      await Promise.all([...tempDirs].map((dir) => fs.rm(dir, { recursive: true, force: true })));
      tempDirs.clear();
    }
  });

  const runManagedServiceManagerBoundary = createManagedServiceManagerBoundary({
    spawnMock,
    tempDirs,
    cleanups: managedProcessCleanups,
  });
  return { forceKillChildProcessTreeMock, spawnMock, tempDirs, runManagedServiceManagerBoundary };
}
