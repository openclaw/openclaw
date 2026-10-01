// Register shared pool mocks before modules that consume them.
// oxfmt-ignore
import { emptyReply, mock, queueTask, source, tempDirs } from "./openclaw-state-read-worker.test-harness.js";
import path from "node:path";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { expect, it, vi } from "vitest";
import { createRetainedOperation } from "../infra/retained-operation.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseByPathAsync } from "./openclaw-state-db-cache.js";
import { executeExistingOpenClawStateRead } from "./openclaw-state-db-readonly.js";
import { closeOpenClawStateDatabaseAsync, openOpenClawStateDatabase } from "./openclaw-state-db.js";
import * as readWorker from "./openclaw-state-read-worker.js";
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

it("services two accepted recovery reads through release from their follower's captured source", async () => {
  const root = tempDirs.make("openclaw-settlement-queued-reader-");
  const options = { path: path.join(root, "source.sqlite"), env: { OPENCLAW_STATE_DIR: root } };
  const profiles = [
    ensureProfileForEmail("first-recovery@example.test", options),
    ensureProfileForEmail("second-recovery@example.test", options),
  ];
  const descriptorMap = new Map(
    selectProfileDisplayEntries(
      openOpenClawStateDatabase(options).db,
      profiles.map((profile) => profile.id),
    ),
  );
  const descriptors = profiles.map((profile) => descriptorMap.get(profile.id)!);
  await closeOpenClawStateDatabaseAsync();
  const context = captureOpenClawStateWorkerContext(options);
  const started = createDeferredCore();
  const replies: OpenClawStateReadReply[] = descriptors.map((profile) => ({
    ok: true,
    type: "userProfiles.reconcile",
    sourceAdmitted: true,
    profile,
    emailBindings: [],
  }));
  let rawReady = false;
  let submissions = 0;
  let released = 0;
  let dispatchFollower: (() => void) | undefined;
  let followerDispatched = false;
  const raw = replies.map((reply) => {
    const completion = createRetainedOperation<OpenClawStateReadReply>(() => {
      if (rawReady) {
        completion.resolve(reply);
      }
    });
    return completion;
  });
  const releases = replies.map(() => {
    const completion = createRetainedOperation<void>(() => {
      if (completion.operation.read().status === "pending") {
        released++;
        completion.resolve(undefined);
      }
    });
    return vi.fn(() => completion.operation);
  });
  const followerRaw = createRetainedOperation<OpenClawStateReadReply>(() => {
    // Receiving raw replies does not release custody held by the recovery owner.
    for (const completion of raw) {
      completion.operation.service();
    }
    if (released === 2 && !followerDispatched) {
      dispatchFollower?.();
      followerDispatched = true;
      followerRaw.resolve(emptyReply);
    }
  });
  mock.runTask.mockImplementation((input) => {
    const index = submissions++;
    const enter = () => {
      const request = typeof input === "function" ? input() : input;
      if (isPromiseLike(request)) {
        throw new Error("The shared-state transport fixture requires synchronous admission");
      }
      expect(request.command).toEqual(
        index < 2
          ? { type: "userProfiles.reconcile", profileId: profiles[index]!.id }
          : { type: "fleet.list" },
      );
    };
    if (index < 2) {
      enter();
      if (submissions === 2) {
        started.resolve();
      }
      return { ...raw[index]!.operation, release: releases[index]! };
    }
    dispatchFollower = enter;
    return {
      ...followerRaw.operation,
      release() {
        const completion = createRetainedOperation<void>(() => {});
        completion.resolve(undefined);
        return completion.operation;
      },
    };
  });
  const publish = profiles.map(() => vi.fn());
  const releasePublication = profiles.map(() => vi.fn());
  const deliveries = profiles.map(
    (_, index) => new Error(`recovery ${index} result delivery failed`),
  );
  const recoveries = profiles.map((profile, index) =>
    withOpenClawStateSettlementRead(context, async (read) => {
      read.bind(
        { type: "userProfiles.reconcile", profileId: profile.id },
        Promise.resolve({ kind: "completed" }),
        publish[index]!,
        releasePublication[index]!,
      );
      const failure = deliveries[index];
      if (!failure) {
        throw new Error("Settlement fixture has no delivery failure");
      }
      throw failure;
    }).catch((error: unknown) => error),
  );
  let follower: ReturnType<typeof executeExistingOpenClawStateRead> | undefined;
  const captureSource = readWorker.captureOpenClawStateReadSource;
  const captured: { source?: ReturnType<typeof captureSource>; released: boolean } = {
    released: false,
  };
  const capture = vi.spyOn(readWorker, "captureOpenClawStateReadSource").mockImplementation(() => {
    const selected = captureSource();
    captured.source = selected;
    return {
      ...selected,
      own(service, close) {
        const unregister = selected.own(service, close);
        return () => {
          unregister();
          captured.released = true;
        };
      },
    };
  });
  try {
    await Promise.race([
      started.promise,
      ...recoveries.map((recovery) =>
        recovery.then(() => {
          throw new Error("Recovery failed before occupying both reader slots");
        }),
      ),
    ]);
    expect(submissions).toBe(2);
    expect(released).toBe(0);
    follower = executeExistingOpenClawStateRead(options, { type: "fleet.list" });
    const followerSource = captured.source;
    if (!followerSource) {
      throw new Error("Follower read source was not captured");
    }
    expect(submissions).toBe(3);
    expect(followerDispatched).toBe(false);
    rawReady = true;
    let microtaskRan = false;
    queueMicrotask(() => {
      microtaskRan = true;
    });
    // No await or direct recovery release: service the actual follower's captured source.
    for (let pass = 0; pass < 4 && !captured.released; pass++) {
      followerSource.service();
    }
    expect(microtaskRan).toBe(false);
    expect(captured.released).toBe(true);
    expect(released).toBe(2);
    expect(followerDispatched).toBe(true);
    for (let index = 0; index < profiles.length; index++) {
      expect(releases[index]).toHaveBeenCalledOnce();
      expect(publish[index]).toHaveBeenCalledExactlyOnceWith(descriptors[index], []);
    }
    expect(await Promise.all(recoveries)).toEqual(deliveries);
    await expect(follower).resolves.toEqual(emptyReply);
    for (const release of releasePublication) {
      expect(release).toHaveBeenCalledOnce();
    }
  } finally {
    // Let ordinary continuations clean up if the synchronous-progress assertion failed.
    raw.forEach((completion, index) => completion.resolve(replies[index]!));
    followerRaw.resolve(emptyReply);
    await Promise.allSettled(recoveries);
    await Promise.allSettled([follower]);
    capture.mockRestore();
  }
});

it("uses completed admission for later resource closes through the same pool owner", async () => {
  const { pathname, options } = source();
  mock.capabilities.mockReturnValue({
    explicitSqliteCloseReleasesNativeResources: false,
    decided: false,
    reason: "admission pending",
  });
  const early = queueTask();
  early.result.resolve(emptyReply);
  await executeExistingOpenClawStateRead(options, { type: "fleet.list" });
  await closeOpenClawStateDatabaseByPathAsync(pathname);
  expect(mock.rotate).toHaveBeenCalledOnce();
  expect(mock.closeResources).not.toHaveBeenCalled();

  mock.capabilities.mockReturnValue({
    explicitSqliteCloseReleasesNativeResources: true,
    decided: true,
    reason: "native close confirmed",
  });
  const admitted = queueTask();
  admitted.result.resolve(emptyReply);
  await executeExistingOpenClawStateRead(options, { type: "fleet.list" });
  const request = await admitted.captured;
  await closeOpenClawStateDatabaseByPathAsync(pathname);
  expect(mock.closeResources).toHaveBeenCalledExactlyOnceWith(request.expectedIdentity);
  expect(mock.rotate).toHaveBeenCalledOnce();
  expect(mock.create).toHaveBeenCalledOnce();
  expect(mock.closePool).not.toHaveBeenCalled();
});
