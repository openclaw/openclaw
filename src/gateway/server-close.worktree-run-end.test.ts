import "../test-utils/prepare-compiled-subprocesses.js";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { prepareWorktreeRegistryGuard } from "../agents/worktrees/registry-read.js";
import { withWorktreeRunEnd } from "../agents/worktrees/run-end-lifecycle.js";
import { acquireWorktreeRunLease } from "../agents/worktrees/run-lease.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import {
  materializeManagedWorktreeFixtures,
  useManagedWorktreeTestRepository,
} from "../agents/worktrees/service.test-support.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
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
  const releaseEntered = createDeferred();
  const releaseLease = createDeferred();
  let closing: Promise<void> | undefined;
  let removing: Promise<unknown> | undefined;
  let runLease: Awaited<ReturnType<typeof acquireWorktreeRunLease>> | undefined;
  let releasing: Promise<void> | undefined;
  let acceptedChild: Promise<void> | undefined;
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
      names: ["first", "second", "third"],
    });
    const running = expectDefined(records[2], "Running worktree");
    runLease = await acquireWorktreeRunLease(running.id, { env: fixture.state.env });
    const first = expectDefined(records[0], "First worktree");
    const assertPreparedEffect = await prepareWorktreeRegistryGuard(
      captureOpenClawStateWorkerContext({ env: fixture.state.env }),
      { predicates: [{ kind: "exact-owner", record: first }] },
    );
    const shared = openOpenClawStateDatabase({ env: fixture.state.env }).db;
    let acceptedSignal: AbortSignal | undefined;
    let claimPaused = false;
    let holdRunLeaseRelease = false;
    const run = stateWorker.runOpenClawStateWorkerOperation;
    const worker = vi
      .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
      .mockImplementation((context, operation, options) =>
        run(
          context,
          (scope) =>
            operation({
              execute: async (command, executeOptions) => {
                if (command.type === "worktrees.releaseRunLease" && holdRunLeaseRelease) {
                  holdRunLeaseRelease = false;
                  releaseEntered.resolve();
                  await releaseLease.promise;
                }
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
          records
            .slice(0, 2)
            .map((record) => managedWorktrees.remove({ id: record.id, reason: "close-proof" })),
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
    acceptedChild = withWorktreeRunEnd(fixture.state.env, async () => {
      await parentClosed.promise;
      const child = await acquireWorktreeRunLease(running.id, { env: fixture.state.env });
      await child.release();
    });
    void acceptedChild.catch(() => {});
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
    expect(assertPreparedEffect).toThrow("owner or lifecycle changed");
    await expect(managedWorktrees.remove({ id: first.id, reason: "late-close" })).rejects.toThrow(
      "run-end admission is closed",
    );
    await expect(acquireWorktreeRunLease(running.id, { env: fixture.state.env })).rejects.toThrow(
      "run-end admission is closed",
    );
    await withinTest(acceptedChild, signal);
    holdRunLeaseRelease = true;
    releasing = runLease.release();
    await withinTest(
      awaitGateBeforeSettlement(
        releaseEntered.promise,
        releasing,
        "Accepted run lease cleanup did not reach its writer",
      ),
      signal,
    );
    release.resolve();
    await withinTest(expectDefined(removing, "Accepted removals"), signal);
    expect(shared.isOpen).toBe(true);
    releaseLease.resolve();
    await withinTest(Promise.all([releasing, closing]), signal);
    expect(shared.isOpen).toBe(false);
    const database = new DatabaseSync(resolveOpenClawStateSqlitePath(fixture.state.env), {
      readOnly: true,
    });
    try {
      expect(database.prepare("SELECT id, removed_at FROM worktrees ORDER BY id").all()).toEqual(
        records.map((record) => ({
          id: record.id,
          removed_at: record.id === running.id ? null : expect.any(Number),
        })),
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
    releaseLease.resolve();
    parentClosed.resolve();
    await Promise.allSettled([removing, acceptedChild, releasing ?? runLease?.release(), closing]);
    restoreWorker?.();
    await fixture.cleanup();
  }
});
