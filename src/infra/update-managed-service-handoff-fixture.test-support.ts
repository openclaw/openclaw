import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { createManagedHandoffTestBinding } from "../../test/helpers/managed-handoff-isolation.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
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
  let handoffBinding: ReturnType<typeof createManagedHandoffTestBinding> | undefined;
  const assertHandoffDatabasePath = (databasePath: string) => {
    if (!handoffBinding) {
      throw new Error("Managed handoff fixture has no private database binding");
    }
    handoffBinding.assertPath(databasePath);
  };

  beforeEach(async () => {
    // Helpers in one fixture share a coordinator without touching the operator's database.
    const coordinatorDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-handoff-coordinator-")),
    );
    tempDirs.add(coordinatorDir);
    handoffBinding = createManagedHandoffTestBinding(coordinatorDir);
    resolvePreferredOpenClawTmpDirMock.mockReturnValue(coordinatorDir);
    const { resolveManagedUpdateLeaseDatabasePath } =
      await import("./update-managed-service-handoff-lease.js");
    assertHandoffDatabasePath(resolveManagedUpdateLeaseDatabasePath());
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
          assertDatabasePath: assertHandoffDatabasePath,
        });
      });
      return child;
    });
  });

  const cleanupFixture = async () => {
    vi.useRealTimers();
    await runQaGatewayFixture(
      async () => {},
      ...[...managedProcessCleanups].map((cleanup) => async () => {
        await cleanup();
        managedProcessCleanups.delete(cleanup);
      }),
      ...[...mockedChildren].map((child) => () => child.emit("exit", 0, null)),
      // Exit listeners can fail before deleting their cleanup. Retry every retained
      // owner, but preserve the first failure even if native cleanup now succeeds.
      () => runQaGatewayFixture(async () => {}, ...mockedHandoffLeaseCleanups),
      async () => {
        const { cancelManagedServiceUpdateHandoff } =
          await import("./update-managed-service-handoff.js");
        await runQaGatewayFixture(
          async () => {},
          ...[...mockedHandoffs].map(([installRoot, { handoffId }]) => async () => {
            // Cancellation retires the exited owner only after verifying its lease was released.
            await expect(
              cancelManagedServiceUpdateHandoff({
                kind: "managed-update-handoff",
                installRoot,
                handoffId,
              }),
            ).resolves.toBe("restored-in-process");
            mockedHandoffs.delete(installRoot);
          }),
        );
      },
      async () => {
        for (const child of mockedChildren) {
          child.stdin.destroy();
          child.stdout.destroy();
        }
        mockedChildren.clear();
        closeOpenClawStateDatabaseForTest();
        if (managedProcessCleanups.size || mockedHandoffLeaseCleanups.size || mockedHandoffs.size) {
          throw new Error(
            "Managed handoff fixture retains unsettled resources; keeping its directories",
          );
        }
        await Promise.all(
          [...tempDirs].map(async (dir) => {
            await fs.rm(dir, { recursive: true, force: true });
            tempDirs.delete(dir);
          }),
        );
      },
    );
  };
  afterEach(cleanupFixture);

  const runManagedServiceManagerBoundary = createManagedServiceManagerBoundary({
    spawnMock,
    tempDirs,
    cleanups: managedProcessCleanups,
  });
  return {
    forceKillChildProcessTreeMock,
    spawnMock,
    tempDirs,
    runManagedServiceManagerBoundary,
    assertHandoffDatabasePath,
    cleanupFixture,
  };
}
