import "../test-utils/prepare-compiled-subprocesses.js";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import {
  materializeManagedWorktreeFixtures,
  useManagedWorktreeTestRepository,
} from "../agents/worktrees/service.test-support.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { createGatewayMetadataCloseFixture } from "./server-close.metadata.test-support.js";

const initializeRepository = useManagedWorktreeTestRepository();

// mock-isolation: Keep upstream polling and its agent runtime out of this close-order fixture.
vi.mock("../sessions/session-upstream-monitor.js", () => ({
  startSessionUpstreamMonitor: () => ({ stop: () => Promise.resolve() }),
}));

it("joins accepted worktree removals across scheduler cancellation before closing workers", async ({
  signal,
}) => {
  const fixture = await createGatewayMetadataCloseFixture("gateway-worktree-run-end-close");
  const entered = createDeferred();
  const release = createDeferred();
  const parentClosed = createDeferred();
  let closing: Promise<void> | undefined;
  let removing: Promise<unknown> | undefined;
  let restoreWorker: (() => void) | undefined;
  try {
    const port = await fixture.reservePort();
    const server = await fixture.start(port);
    const kernel = expectDefined(fixture.kernels.get(port), "Gateway kernel");
    const repoRoot = await initializeRepository(fixture.state.statePath("run-end-source"));
    const records = await materializeManagedWorktreeFixtures({
      env: fixture.state.env,
      stateDir: fixture.state.statePath(),
      repoRoot,
      now: 1,
      names: ["first", "second"],
    });
    const first = expectDefined(records[0], "First worktree");
    const shared = openOpenClawStateDatabase({ env: fixture.state.env }).db;
    let acceptedSignal: AbortSignal | undefined;
    let claimPaused = false;
    const run = stateWorker.runOpenClawStateWorkerOperation;
    const worker = vi
      .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
      .mockImplementation((context, operation, options) =>
        run(
          context,
          (scope) =>
            operation({
              execute: async (command, executeOptions) => {
                if (command.type === "worktrees.claimRemoval" && !claimPaused) {
                  claimPaused = true;
                  acceptedSignal = getAsyncWorkSignal();
                  entered.resolve();
                  await release.promise;
                }
                return scope.execute(command, executeOptions);
              },
            }),
          options,
        ),
      );
    restoreWorker = () => worker.mockRestore();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    kernel.scheduler.schedule({
      id: "accepted-worktree-removals",
      delayMs: 0,
      async run() {
        removing = Promise.all(
          records.map((record) =>
            managedWorktrees.remove({ id: record.id, reason: "close-proof" }),
          ),
        );
        await removing;
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
    await withinTest(
      awaitGateBeforeSettlement(
        entered.promise,
        expectDefined(removing, "Accepted removals"),
        "Worktree removal settled before its worker command",
      ),
      signal,
    );
    expect(acceptedSignal?.aborted).toBe(false);
    kernel.scheduler.signal.addEventListener("abort", () => parentClosed.resolve(), { once: true });
    closing = server.close({ reason: "worktree settlement close regression" });
    await withinTest(
      awaitGateBeforeSettlement(
        parentClosed.promise,
        closing,
        "Gateway closed before scheduler cancellation",
      ),
      signal,
    );
    expect(acceptedSignal?.aborted).toBe(false);
    expect(shared.isOpen).toBe(true);
    await expect(managedWorktrees.remove({ id: first.id, reason: "late-close" })).rejects.toThrow(
      "run-end admission is closed",
    );
    release.resolve();
    await withinTest(Promise.all([removing, closing]), signal);
    expect(shared.isOpen).toBe(false);
    const database = new DatabaseSync(resolveOpenClawStateSqlitePath(fixture.state.env), {
      readOnly: true,
    });
    try {
      expect(database.prepare("SELECT id, removed_at FROM worktrees ORDER BY id").all()).toEqual(
        records.map((record) => ({ id: record.id, removed_at: expect.any(Number) })),
      );
      expect(
        database
          .prepare("SELECT COUNT(*) AS count FROM state_leases WHERE scope LIKE 'worktree-run:%'")
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  } finally {
    vi.useRealTimers();
    release.resolve();
    await Promise.allSettled([removing, closing]);
    restoreWorker?.();
    await fixture.cleanup();
  }
});
