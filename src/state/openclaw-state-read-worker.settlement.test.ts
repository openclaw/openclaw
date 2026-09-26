// Register shared pool mocks before modules that consume them.
// oxfmt-ignore
import { emptyReply, mock, queueTask, tempDirs } from "./openclaw-state-read-worker.test-harness.js";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseByPathAsync } from "./openclaw-state-db-cache.js";
import { executeExistingOpenClawStateRead } from "./openclaw-state-db-readonly.js";
import { closeOpenClawStateDatabaseAsync, openOpenClawStateDatabase } from "./openclaw-state-db.js";
import type { OpenClawStateReadReply } from "./openclaw-state-read.types.js";
import { withOpenClawStateSettlementRead } from "./openclaw-state-settlement-read.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import { selectProfileDisplayEntries } from "./user-profiles-internal.js";
import { ensureProfileForEmail } from "./user-profiles.js";

it("drains accepted settlement before retiring the shared pool during whole-cache close", async () => {
  const root = tempDirs.make("openclaw-settlement-global-close-");
  const pathname = path.join(root, "source.sqlite");
  const options = { path: pathname, env: { OPENCLAW_STATE_DIR: root } };
  const profile = ensureProfileForEmail("global-close@example.test", options);
  const descriptor = selectProfileDisplayEntries(openOpenClawStateDatabase(options).db, [
    profile.id,
  ])[0]![1];
  await closeOpenClawStateDatabaseAsync();
  const warm = queueTask();
  warm.result.resolve(emptyReply);
  await executeExistingOpenClawStateRead(options, { type: "fleet.list" });
  const context = captureOpenClawStateWorkerContext(options);
  const mutationSettled = createDeferredCore();
  const poolStopping = createDeferredCore();
  const poolStopped = createDeferredCore();
  mock.closePool.mockImplementationOnce(() => {
    poolStopping.resolve();
    return poolStopped.promise;
  });
  const delivery = new Error("mutation result delivery failed");
  const publish = vi.fn();
  const release = vi.fn();
  const result = withOpenClawStateSettlementRead(context, async (read) => {
    read.bind(
      { type: "userProfiles.reconcile", profileId: profile.id },
      Promise.resolve({ kind: "completed" }),
      publish,
      release,
    );
    await mutationSettled.promise;
    throw delivery;
  }).catch((error: unknown) => error);
  const recovery = queueTask();
  recovery.result.resolve({
    ok: true,
    type: "userProfiles.reconcile",
    sourceAdmitted: true,
    profile: descriptor,
    emailBindings: [],
  });
  const closing = closeOpenClawStateDatabaseAsync();
  void closing.catch(() => {});
  try {
    // Let the actual resource drain enter while the accepted producer is still held.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    mutationSettled.resolve();
    expect(await result).toBe(delivery);
    expect((await recovery.captured).command).toEqual({
      type: "userProfiles.reconcile",
      profileId: profile.id,
    });
    expect(publish).toHaveBeenCalledExactlyOnceWith(descriptor, []);
    expect(release).toHaveBeenCalledOnce();
    expect(recovery.close).toHaveBeenCalledOnce();
    await poolStopping.promise;
    expect(publish.mock.invocationCallOrder[0]).toBeLessThan(
      mock.closePool.mock.invocationCallOrder[0]!,
    );
    expect(() => captureOpenClawStateWorkerContext(options)).toThrow(/admission is closed/);
    poolStopped.resolve();
    await closing;
    expect(captureOpenClawStateWorkerContext(options).admission.assertCurrent).not.toThrow();
  } finally {
    mutationSettled.resolve();
    poolStopped.resolve();
    await Promise.allSettled([result, closing]);
  }
});

it.each([false, true])(
  "preserves settlement task errors and source custody through canonical retry (retry fails=%s)",
  async (retryFails) => {
    const root = tempDirs.make("openclaw-settlement-task-failure-");
    const pathname = path.join(root, "source.sqlite");
    const options = { path: pathname, env: { OPENCLAW_STATE_DIR: root } };
    const profile = ensureProfileForEmail("settlement@example.test", options);
    const descriptor = selectProfileDisplayEntries(openOpenClawStateDatabase(options).db, [
      profile.id,
    ])[0]![1];
    await closeOpenClawStateDatabaseAsync();
    const context = captureOpenClawStateWorkerContext(options);
    const command = { type: "userProfiles.reconcile", profileId: profile.id } as const;
    const reply: OpenClawStateReadReply = {
      ok: true,
      type: command.type,
      sourceAdmitted: true,
      profile: descriptor,
      emailBindings: [],
    };
    const task = queueTask();
    const delivery = new Error("mutation result delivery failed");
    const query = new Error("interrupted settlement task failed");
    const retirement = new Error("first settlement worker stop failed");
    const retryFailure = new Error("settlement close retry failed");
    task.close.mockRejectedValueOnce(retirement);
    if (retryFails) {
      task.close.mockRejectedValueOnce(retryFailure);
    }
    const mutation = vi.fn();
    const publish = vi.fn();
    const release = vi.fn();
    const result = withOpenClawStateSettlementRead(context, async (read) => {
      mutation();
      read.bind(command, Promise.resolve({ kind: "completed" }), publish, release);
      throw delivery;
    }).catch((error: unknown) => error);
    const firstRequest = await task.captured;
    task.result.reject(query);
    const failure = await result;
    expect(failure).toMatchObject({
      errors: [delivery, expect.objectContaining({ errors: [query, retirement] })],
    });
    expect(publish).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    if (retryFails) {
      await expect(closeOpenClawStateDatabaseByPathAsync(pathname)).rejects.toBe(retryFailure);
      expect(publish).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();
      expect(() => captureOpenClawStateWorkerContext(options)).toThrow(/admission is closed/);
    }
    const retry = queueTask();
    const retryCloseStarted = createDeferredCore();
    const stopped = createDeferredCore();
    retry.close.mockImplementationOnce(() => {
      retryCloseStarted.resolve();
      return stopped.promise;
    });
    const closing = closeOpenClawStateDatabaseByPathAsync(pathname);
    try {
      const retryRequest = await retry.captured;
      for (const request of [firstRequest, retryRequest]) {
        expect(request).toMatchObject({
          command,
          databasePath: pathname,
          location: pathname,
          expectedIdentity: context.admission.identity.key,
          checkFreshAdmission: false,
        });
      }
      retry.result.resolve(reply);
      await retryCloseStarted.promise;
      expect(publish).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();
      expect(() => captureOpenClawStateWorkerContext(options)).toThrow(/admission is closed/);
    } finally {
      retry.result.resolve(reply);
      stopped.resolve();
      await closing;
    }
    expect(publish).toHaveBeenCalledExactlyOnceWith(descriptor, []);
    expect(release).toHaveBeenCalledOnce();
    expect(mutation).toHaveBeenCalledOnce();
    expect(task.close).toHaveBeenCalledTimes(retryFails ? 3 : 2);
    expect(retry.close).toHaveBeenCalledOnce();
    expect(captureOpenClawStateWorkerContext(options).admission.assertCurrent).not.toThrow();
  },
);
