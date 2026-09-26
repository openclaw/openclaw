// Register shared pool mocks before modules that consume them.
// oxfmt-ignore
import { emptyReply, mock, queueTask, source, tempDirs } from "./openclaw-state-read-worker.test-harness.js";
import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createWorkspaceStateIdentity } from "../agents/workspace-state-identity.js";
import type { ExecutionIdentityInspectionQuery } from "../audit/execution-identity-inspection.types.js";
import { acquireStateDatabaseHandleExclusion } from "../infra/state-database-coordinator.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  registerOpenClawStateDatabaseAsyncResource,
} from "./openclaw-state-db-cache.js";
import { executeExistingOpenClawStateRead } from "./openclaw-state-db-readonly.js";
import { closeOpenClawStateDatabaseAsync, openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { createOpenClawStateReadTransport } from "./openclaw-state-read-worker.js";
import type { OpenClawStateReadReply } from "./openclaw-state-read.types.js";
import { withOpenClawStateSettlementRead } from "./openclaw-state-settlement-read.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import { encodeOpenClawStateWorkerError } from "./openclaw-state-worker-error.js";
import { selectProfileDisplayEntries } from "./user-profiles-internal.js";
import { ensureProfileForEmail } from "./user-profiles.js";

it("retains the shared pool after a resource drain fails until canonical retry", async () => {
  const { options } = source();
  const warm = queueTask();
  warm.result.resolve(emptyReply);
  await executeExistingOpenClawStateRead(options, { type: "fleet.list" });
  const failure = new Error("accepted resource cleanup failed");
  const close = vi.fn<() => Promise<void>>().mockRejectedValueOnce(failure).mockResolvedValue();
  const unregister = registerOpenClawStateDatabaseAsyncResource({ close });
  try {
    await expect(closeOpenClawStateDatabaseAsync()).rejects.toBe(failure);
    expect(mock.closePool).not.toHaveBeenCalled();
    expect(() => captureOpenClawStateWorkerContext(options)).toThrow(/closed/i);
    await closeOpenClawStateDatabaseAsync();
    expect(close).toHaveBeenCalledTimes(2);
    expect(mock.closePool).toHaveBeenCalledOnce();
    expect(close.mock.invocationCallOrder[1]).toBeLessThan(
      mock.closePool.mock.invocationCallOrder[0]!,
    );
  } finally {
    unregister();
  }
});

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
    poolStopped.resolve();
    await closing;
    const exclusion = acquireStateDatabaseHandleExclusion({ databasePath: pathname });
    exclusion.release();
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
    expect(() =>
      acquireStateDatabaseHandleExclusion({ databasePath: pathname, busyTimeoutMs: 0 }),
    ).toThrow();
    if (retryFails) {
      await expect(closeOpenClawStateDatabaseByPathAsync(pathname)).rejects.toBe(retryFailure);
      expect(publish).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();
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
    const exclusion = acquireStateDatabaseHandleExclusion({ databasePath: pathname });
    exclusion.release();
  },
);

it.each([false, true])(
  "preserves task and cleanup errors across explicit retirement retries (retry fails=%s)",
  async (retryFails) => {
    const { pathname, options } = source();
    const task = queueTask();
    const original = new Error("original worker task failed");
    const retirement = new Error("first worker stop failed");
    const retryFailure = new Error("second worker stop failed");
    task.close.mockRejectedValueOnce(retirement);
    if (retryFails) {
      task.close.mockRejectedValueOnce(retryFailure);
    }
    const result = executeExistingOpenClawStateRead(options, { type: "fleet.list" });
    const assertion = expect(result).rejects.toMatchObject({
      cause: original,
      errors: [original, retirement],
    });
    await task.captured;
    task.result.reject(original);
    await assertion;
    expect(task.close).toHaveBeenCalledExactlyOnceWith({ retire: true });
    expect(mock.closePool).not.toHaveBeenCalled();

    // Result and native settlement are separate: the initial close reports the
    // cached first stop failure; only a later lifecycle close retries that stop.
    if (retryFails) {
      await expect(closeOpenClawStateDatabaseByPathAsync(pathname)).rejects.toBe(retryFailure);
      expect(task.close).toHaveBeenCalledTimes(2);
    }
    await closeOpenClawStateDatabaseByPathAsync(pathname);
    expect(task.close).toHaveBeenCalledTimes(retryFails ? 3 : 2);
    await closeOpenClawStateDatabaseByPathAsync(pathname);
    expect(task.close).toHaveBeenCalledTimes(retryFails ? 3 : 2);
    expect(mock.closePool).not.toHaveBeenCalled();
    expect(mock.runTask).toHaveBeenCalledOnce();
    await expect(result).rejects.toMatchObject({ cause: original, errors: [original, retirement] });
  },
);

it("reads externally created state after an absent read without allocating a worker first", async () => {
  const root = tempDirs.make("openclaw-read-first-creation-");
  const pathname = path.join(root, "source.sqlite");
  const options = { path: pathname, env: { OPENCLAW_STATE_DIR: root } };
  const command = { type: "fleet.list" } as const;
  expect(await executeExistingOpenClawStateRead(options, command)).toBeUndefined();
  expect(fs.existsSync(pathname)).toBe(false);
  expect(mock.create).not.toHaveBeenCalled();
  expect(mock.runTask).not.toHaveBeenCalled();
  expect(mock.selectSqlite).not.toHaveBeenCalled();

  fs.writeFileSync(pathname, "mock worker source");
  const task = queueTask();
  task.result.resolve(emptyReply);
  expect(await executeExistingOpenClawStateRead(options, command)).toEqual(emptyReply);
  expect(mock.selectSqlite).toHaveBeenCalledOnce();
  expect(task.close).toHaveBeenCalledExactlyOnceWith(
    process.versions.bun ? { retire: true } : undefined,
  );
  expect(mock.closePool).not.toHaveBeenCalled();
});

it.each(["query failed", "native reader close failed"])(
  "retires an encoded %s reply and retains operation custody until stop",
  async (message) => {
    const { options } = source();
    const task = queueTask();
    const stopping = createDeferredCore();
    const stopped = createDeferredCore();
    task.close.mockImplementationOnce(() => {
      stopping.resolve();
      return stopped.promise;
    });
    const result = executeExistingOpenClawStateRead(options, { type: "fleet.list" });
    const assertion = expect(result).rejects.toThrow(message);
    let settled = false;
    void result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await task.captured;
    task.result.resolve({
      ok: false,
      sourceAdmitted: true,
      message,
      error: encodeOpenClawStateWorkerError(new Error(message), { includeOrdinary: true }),
    });
    try {
      await stopping.promise;
      expect(task.close).toHaveBeenCalledExactlyOnceWith({ retire: true });
      expect(settled).toBe(false);
      expect(mock.closePool).not.toHaveBeenCalled();
    } finally {
      stopped.resolve();
      await assertion;
    }
  },
);

it.each(["cleanup-fact", "bun"] as const)(
  "preserves a successful read only after required retirement (%s)",
  async (reason) => {
    const { options } = source();
    const task = queueTask();
    const stopping = createDeferredCore();
    const stopped = createDeferredCore();
    task.close.mockImplementationOnce(() => {
      stopping.resolve();
      return stopped.promise;
    });
    if (reason === "bun") {
      // Policy-only control: the task and its native retirement are both mocked.
      vi.stubGlobal("process", {
        ...process,
        versions: { ...process.versions, bun: "1.4.2" },
      });
    }
    try {
      const result = executeExistingOpenClawStateRead(options, { type: "fleet.list" });
      let settled = false;
      void result.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await task.captured;
      task.result.resolve(
        reason === "cleanup-fact"
          ? { ...emptyReply, nativeCleanupFailure: { error: undefined } }
          : emptyReply,
      );
      try {
        await stopping.promise;
        expect(task.close).toHaveBeenCalledExactlyOnceWith({ retire: true });
        expect(mock.selectSqlite).toHaveBeenCalledOnce();
        expect(mock.selectSqlite.mock.invocationCallOrder[0]).toBeLessThan(
          mock.create.mock.invocationCallOrder[0]!,
        );
        expect(settled).toBe(false);
        expect(mock.closePool).not.toHaveBeenCalled();
      } finally {
        stopped.resolve();
      }
      await expect(result).resolves.toMatchObject({ ok: true, type: "fleet.list", cells: [] });
      expect(task.close).toHaveBeenCalledOnce();
    } finally {
      stopped.resolve();
      if (reason === "bun") {
        vi.unstubAllGlobals();
      }
    }
  },
);

it.each([false, true])(
  "preserves the quarantine cleanup graph and stop failure (source fails=%s)",
  async (sourceFails) => {
    const { pathname, options } = source();
    const task = queueTask();
    const metadata = new Error("quarantine metadata read failed");
    const nativeClose = new Error("quarantine reader close failed");
    const quarantine = new AggregateError([metadata, nativeClose], "quarantine read and cleanup", {
      cause: metadata,
    });
    const primary = new Error("source query failed");
    const stop = new Error("worker native exit not confirmed");
    task.close.mockRejectedValueOnce(stop);
    const result = executeExistingOpenClawStateRead(options, { type: "fleet.list" });
    const outcome = result.catch((error: unknown) => error);
    await task.captured;
    const reply: OpenClawStateReadReply = sourceFails
      ? {
          ok: false,
          sourceAdmitted: true,
          message: primary.message,
          error: encodeOpenClawStateWorkerError(primary, { includeOrdinary: true }),
        }
      : emptyReply;
    task.result.resolve({
      ...reply,
      nativeCleanupFailure: {
        error: encodeOpenClawStateWorkerError(quarantine, { includeOrdinary: true }),
      },
    });
    const failure = await outcome;
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) {
      throw new Error("Read cleanup did not retain its error graph");
    }
    expect(failure.cause).toBe(failure.errors[0]);
    expect(failure.errors).toHaveLength(2);
    if (sourceFails) {
      expect(failure.cause).toMatchObject({ message: primary.message });
    }
    const cleanup: unknown = sourceFails ? failure.errors[1] : failure;
    expect(cleanup).toBeInstanceOf(AggregateError);
    if (!(cleanup instanceof AggregateError)) {
      throw new Error("Worker stop replaced the quarantine cleanup graph");
    }
    expect(cleanup.cause).toBe(cleanup.errors[0]);
    expect(cleanup.errors).toHaveLength(2);
    expect(cleanup.errors[1]).toBe(stop);
    const decoded: unknown = cleanup.errors[0];
    expect(decoded).toBeInstanceOf(AggregateError);
    if (!(decoded instanceof AggregateError)) {
      throw new Error("Encoded quarantine failures were not retained");
    }
    expect(decoded.message).toBe(quarantine.message);
    expect(decoded.errors).toMatchObject([
      { message: metadata.message },
      { message: nativeClose.message },
    ]);
    expect(decoded.cause).toBe(decoded.errors[0]);
    expect(task.close).toHaveBeenCalledExactlyOnceWith({ retire: true });
    expect(mock.closePool).not.toHaveBeenCalled();

    await closeOpenClawStateDatabaseByPathAsync(pathname);
    expect(task.close).toHaveBeenCalledTimes(2);
    await expect(result).rejects.toBe(failure);
  },
);

it("releases one completed read without closing the shared pool or aborting another read", async () => {
  const { options } = source();
  const first = queueTask();
  const sibling = queueTask();
  const firstRead = executeExistingOpenClawStateRead(options, { type: "fleet.list" });
  const siblingRead = executeExistingOpenClawStateRead(options, { type: "fleet.list" });
  await Promise.all([first.captured, sibling.captured]);
  const siblingOptions = await sibling.submitted;
  first.result.resolve(emptyReply);
  expect(await firstRead).toEqual(emptyReply);
  expect(first.close).toHaveBeenCalledExactlyOnceWith(
    process.versions.bun ? { retire: true } : undefined,
  );
  expect(sibling.close).not.toHaveBeenCalled();
  expect(siblingOptions.signal?.aborted).toBe(false);
  expect(mock.closePool).not.toHaveBeenCalled();
  expect(mock.create).toHaveBeenCalledOnce();

  sibling.result.resolve(emptyReply);
  expect(await siblingRead).toEqual(emptyReply);
  expect(sibling.close).toHaveBeenCalledExactlyOnceWith(
    process.versions.bun ? { retire: true } : undefined,
  );
  await closeOpenClawStateDatabaseAsync();
  expect(mock.closePool).toHaveBeenCalledOnce();
});

it("closes only the operation matching a state path while its sibling finishes normally", async () => {
  const firstSource = source("first.sqlite");
  const siblingSource = source("sibling.sqlite");
  const first = queueTask();
  const sibling = queueTask();
  const firstRead = executeExistingOpenClawStateRead(firstSource.options, { type: "fleet.list" });
  const assertion = expect(firstRead).rejects.toThrow(/read admission (?:is )?closed/i);
  const siblingRead = executeExistingOpenClawStateRead(siblingSource.options, {
    type: "fleet.list",
  });
  await Promise.all([first.captured, sibling.captured]);
  const firstOptions = await first.submitted;
  const siblingOptions = await sibling.submitted;
  await closeOpenClawStateDatabaseByPathAsync(firstSource.pathname);
  await assertion;
  expect(firstOptions.signal?.aborted).toBe(true);
  expect(first.close).toHaveBeenCalledExactlyOnceWith({ retire: true });
  expect(siblingOptions.signal?.aborted).toBe(false);
  expect(sibling.close).not.toHaveBeenCalled();
  expect(mock.closePool).not.toHaveBeenCalled();
  expect(mock.create).toHaveBeenCalledOnce();

  sibling.result.resolve(emptyReply);
  expect(await siblingRead).toEqual(emptyReply);
  await closeOpenClawStateDatabaseAsync();
  expect(mock.closePool).toHaveBeenCalledOnce();
});

it.each([
  "fleet.get",
  "userProfiles.reconcile",
  "onboardingRecommendations.read",
  "workspace.snapshot",
  "pluginBlob.lookup",
  "pluginBlob.entries",
  "sandboxRegistry.get",
  "sandboxRegistry.runtimeIds",
  "updateRuns.get",
] as const)(
  "captures and charges the retained UTF-8 selector while dispatch waits (%s)",
  async (type) => {
    const { options } = source();
    const selector = "租户🦞".repeat(512);
    const command =
      type === "updateRuns.get"
        ? { type, runId: selector }
        : type === "fleet.get"
          ? { type, tenantId: selector }
          : type === "userProfiles.reconcile"
            ? { type, profileId: selector }
            : type === "onboardingRecommendations.read"
              ? { type, configKey: selector }
              : type === "pluginBlob.lookup"
                ? { type, input: { pluginId: selector, namespace: selector, key: selector } }
                : type === "pluginBlob.entries"
                  ? { type, input: { pluginId: selector, namespace: selector } }
                  : type === "workspace.snapshot"
                    ? { type, workspaceDir: selector }
                    : type === "sandboxRegistry.get"
                      ? { type, containerName: selector }
                      : { type, backendId: selector, scopeKey: selector };
    const expected = structuredClone(command);
    const dispatch = createDeferredCore();
    const task = queueTask(dispatch.promise);
    const result = executeExistingOpenClawStateRead(options, command);
    const submitted = await task.submitted;
    const originalRoot = options.env.OPENCLAW_STATE_DIR;
    if (command.type === "updateRuns.get") {
      command.runId = "different run after admission";
    } else if (command.type === "fleet.get") {
      command.tenantId = "different tenant after admission";
    } else if (command.type === "userProfiles.reconcile") {
      command.profileId = "different profile after admission";
    } else if (command.type === "onboardingRecommendations.read") {
      command.configKey = "different key after admission";
    } else if (command.type === "pluginBlob.lookup" || command.type === "pluginBlob.entries") {
      command.input.pluginId = "different plugin after admission";
      command.input.namespace = "different namespace after admission";
      if (command.type === "pluginBlob.lookup") {
        command.input.key = "different key after admission";
      }
    } else if (command.type === "sandboxRegistry.get") {
      command.containerName = "different container after admission";
    } else if (command.type === "sandboxRegistry.runtimeIds") {
      command.backendId = "different backend after admission";
      command.scopeKey = "different scope after admission";
    } else {
      command.workspaceDir = "different workspace after admission";
    }
    options.env.OPENCLAW_STATE_DIR = path.join(originalRoot, "different");
    const returned: OpenClawStateReadReply =
      type === "updateRuns.get"
        ? { ok: true, type, sourceAdmitted: true, run: undefined }
        : type === "fleet.get"
          ? { ok: true, type, sourceAdmitted: true, cell: undefined }
          : type === "userProfiles.reconcile"
            ? { ok: true, type, sourceAdmitted: true, profile: undefined, emailBindings: [] }
            : type === "onboardingRecommendations.read"
              ? { ok: true, type, sourceAdmitted: true, record: null }
              : type === "pluginBlob.lookup"
                ? { ok: true, type, sourceAdmitted: true, value: undefined }
                : type === "pluginBlob.entries"
                  ? { ok: true, type, sourceAdmitted: true, value: [] }
                  : type === "sandboxRegistry.get"
                    ? { ok: true, type, sourceAdmitted: true, entry: null }
                    : type === "sandboxRegistry.runtimeIds"
                      ? { ok: true, type, sourceAdmitted: true, runtimeIds: [] }
                      : {
                          ok: true,
                          type,
                          sourceAdmitted: true,
                          snapshot: {
                            identity: createWorkspaceStateIdentity(selector),
                            setup: { version: 1 },
                            setupExists: false,
                          },
                        };
    try {
      expect(Number.isSafeInteger(submitted.inputBytes)).toBe(true);
      const selectorCount =
        type === "pluginBlob.lookup"
          ? 3
          : type === "pluginBlob.entries" || type === "sandboxRegistry.runtimeIds"
            ? 2
            : 1;
      expect(submitted.inputBytes).toBeGreaterThanOrEqual(
        Buffer.byteLength(selector) * selectorCount,
      );
      dispatch.resolve();
      const request = await task.captured;
      expect(request.command).toEqual(expected);
      expect(request.context.environment.OPENCLAW_STATE_DIR).toBe(originalRoot);
      task.result.resolve(returned);
      expect(await result).toEqual(returned);
    } finally {
      dispatch.resolve();
      task.result.resolve(returned);
      await Promise.allSettled([result]);
    }
  },
);

it("captures update history filters and charges retained selectors before dispatch", async () => {
  const { options } = source();
  const selector = "更新🦞".repeat(512);
  const input = { reason: selector, includeRunId: selector, active: true, limit: 100 };
  const expected = { ...input };
  const dispatch = createDeferredCore();
  const task = queueTask(dispatch.promise);
  const result = executeExistingOpenClawStateRead(options, { type: "updateRuns.list", input });
  const returned: OpenClawStateReadReply = {
    ok: true,
    type: "updateRuns.list",
    sourceAdmitted: true,
    runs: [],
  };
  try {
    const submitted = await task.submitted;
    input.reason = "changed reason";
    input.includeRunId = "changed owner";
    input.active = false;
    input.limit = 1;
    expect(submitted.inputBytes).toBeGreaterThanOrEqual(Buffer.byteLength(selector) * 2 + 9);
    dispatch.resolve();
    expect((await task.captured).command).toEqual({ type: "updateRuns.list", input: expected });
    task.result.resolve(returned);
    expect(await result).toEqual(returned);
  } finally {
    dispatch.resolve();
    task.result.resolve(returned);
    await Promise.allSettled([result]);
  }
});

it.each(["skills.library.descriptions", "skills.library.manifests"] as const)(
  "retains library pins and their byte charge while dispatch waits (%s)",
  async (type) => {
    const { options } = source();
    const input = [{ skillId: "技能🦞".repeat(512), revision: "版本🦞".repeat(512) }];
    const expected = structuredClone(input);
    const dispatch = createDeferredCore();
    const task = queueTask(dispatch.promise);
    const result = executeExistingOpenClawStateRead(options, { type, input });
    const returned: OpenClawStateReadReply = { ok: true, type, sourceAdmitted: true, value: [] };
    try {
      const submitted = await task.submitted;
      input[0]!.skillId = "changed";
      input[0]!.revision = "changed";
      input.push({ skillId: "extra", revision: "extra" });
      expect(submitted.inputBytes).toBeGreaterThanOrEqual(
        Buffer.byteLength(expected[0]!.skillId) + Buffer.byteLength(expected[0]!.revision),
      );
      dispatch.resolve();
      expect((await task.captured).command).toEqual({ type, input: expected });
      task.result.resolve(returned);
      expect(await result).toEqual(returned);
    } finally {
      dispatch.resolve();
      task.result.resolve(returned);
      await Promise.allSettled([result]);
    }
  },
);

it.each(["single", "union"] as const)(
  "captures and charges %s task selectors while retaining original admission",
  async (shape) => {
    const { options } = source();
    const context = captureOpenClawStateWorkerContext(options);
    const admission = context.admission;
    context.admission = {
      ...admission,
      get identity() {
        return admission.identity;
      },
    };
    const selector = "任务🦞".repeat(512);
    const scope = {
      taskId: selector,
      flowId: selector,
      runId: selector,
      childSessionKey: selector,
    };
    const input = shape === "single" ? scope : [scope, { taskId: selector }];
    const expected = structuredClone(input);
    const dispatch = createDeferredCore();
    const task = queueTask(dispatch.promise);
    const result = executeExistingOpenClawStateRead(
      { path: context.admission.databasePath, env: context.environment },
      { type: "tasks.mutationSnapshot", input },
      { context },
    );
    const returned: OpenClawStateReadReply = {
      ok: true,
      type: "tasks.mutationSnapshot",
      sourceAdmitted: true,
      snapshot: { tasks: new Map(), deliveryStates: new Map() },
    };
    try {
      const submitted = await task.submitted;
      scope.taskId = "changed task";
      scope.flowId = "changed flow";
      scope.runId = "changed run";
      scope.childSessionKey = "changed child";
      if (Array.isArray(input)) {
        input.push({ taskId: "added while queued" });
      }
      options.env.OPENCLAW_STATE_DIR = "/changed-after-capture";
      expect(submitted.inputBytes).toBeGreaterThanOrEqual(
        Buffer.byteLength(selector) * (shape === "single" ? 4 : 5),
      );
      dispatch.resolve();
      const request = await task.captured;
      expect(request.command).toEqual({ type: "tasks.mutationSnapshot", input: expected });
      expect(request.databasePath).toBe(context.admission.databasePath);
      expect(request.context.environment).toEqual(context.environment);
      const failure = new Error("Original task admission retired");
      vi.spyOn(context.admission, "assertCurrent").mockImplementation(() => {
        throw failure;
      });
      const rejected = expect(result).rejects.toThrow(failure.message);
      task.result.resolve(returned);
      await rejected;
    } finally {
      dispatch.resolve();
      task.result.resolve(returned);
      await Promise.allSettled([result]);
    }
  },
);

it.each([
  {
    input: {
      runId: "运行🦞",
      now: 0,
      executionOffset: 0,
      executionLimit: 0,
      decisionLimit: 0,
      decisionCursor: "游标🦞",
    },
    numericBytes: 32,
  },
  { input: { runId: "运行🦞", now: 0 }, numericBytes: 8 },
  {
    input: { executionId: "执行🦞", now: 0, decisionLimit: 0, decisionCursor: "游标🦞" },
    numericBytes: 16,
  },
  { input: { executionId: "执行🦞", now: 0 }, numericBytes: 8 },
] satisfies Array<{ input: ExecutionIdentityInspectionQuery; numericBytes: number }>)(
  "captures audit query before preparation and charges queued scalar input: $input",
  async ({
    input,
    numericBytes,
  }: {
    input: ExecutionIdentityInspectionQuery;
    numericBytes: number;
  }) => {
    const { pathname, options } = source();
    const context = captureOpenClawStateWorkerContext(options);
    const location = { context, location: pathname, checkFreshAdmission: false };
    const authority = { signal: new AbortController().signal, assertCurrent: () => {} };
    const expected = { ...input };
    const command = { type: "audit.run.inspect" as const, input };
    const transport = createOpenClawStateReadTransport(command);
    const baseline = createOpenClawStateReadTransport({ type: "fleet.list" });
    // The caller can mutate its input while the owner prepares a read location.
    input.now = 999;
    input.decisionCursor = "changed before read";
    input.decisionLimit = 99;
    if ("executionId" in input) {
      input.executionId = "changed execution";
    } else {
      input.runId = "changed run";
      input.executionOffset = 99;
      input.executionLimit = 99;
    }
    const dispatch = createDeferredCore();
    const baselineTask = queueTask(dispatch.promise);
    const task = queueTask(dispatch.promise);
    const baselineRead = baseline.read(location, authority);
    const read = transport.read(location, authority);
    // A pre-admission failure must surface directly rather than leave this test waiting for dispatch.
    const submitted = Promise.race([
      task.submitted,
      read.then(() => {
        throw new Error("Read completed before dispatch");
      }),
    ]);
    try {
      const [baselineOptions, auditOptions] = await Promise.all([
        baselineTask.submitted,
        submitted,
      ]);
      const selector = "executionId" in expected ? expected.executionId : expected.runId;
      const additionalBytes =
        Buffer.byteLength("audit.run.inspect") -
        Buffer.byteLength("fleet.list") +
        Buffer.byteLength(selector) +
        Buffer.byteLength(expected.decisionCursor ?? "") +
        numericBytes;
      expect(auditOptions.inputBytes).toBe(Number(baselineOptions.inputBytes) + additionalBytes);
      input.now = 1234;
      input.decisionCursor = "changed while queued";
      dispatch.resolve();
      const request = await task.captured;
      expect(request.command).toEqual({ type: "audit.run.inspect", input: expected });
      baselineTask.result.resolve(emptyReply);
      task.result.resolve(emptyReply);
      await Promise.all([baselineRead, read]);
    } finally {
      dispatch.resolve();
      baselineTask.result.resolve(emptyReply);
      task.result.resolve(emptyReply);
      await Promise.allSettled([baselineRead, read]);
      await Promise.all([baseline.close(), transport.close()]);
    }
  },
);

it("does not retain caller context in no-input ingress health reads", async () => {
  const { pathname, options } = source();
  const context = captureOpenClawStateWorkerContext(options);
  const command = {
    type: "channelIngress.failedHealth" as const,
    callerContext: { onClosed: () => {} },
  };
  const transport = createOpenClawStateReadTransport(command);
  const task = queueTask();
  const reply: OpenClawStateReadReply = {
    ok: true,
    type: command.type,
    sourceAdmitted: true,
    result: [],
  };
  const read = transport.read(
    { context, location: pathname, checkFreshAdmission: false },
    { signal: new AbortController().signal, assertCurrent: () => {} },
  );
  try {
    const request = await Promise.race([
      task.captured,
      read.then(() => {
        throw new Error("Read completed before dispatch");
      }),
    ]);
    expect(request.command).toEqual({ type: command.type });
    task.result.resolve(reply);
    await expect(read).resolves.toEqual({ value: reply });
  } finally {
    task.result.resolve(reply);
    await Promise.allSettled([read]);
    await transport.close();
  }
});

it("captures cron recovery markers and charges their retained bytes before dispatch", async () => {
  const { pathname, options } = source();
  const context = captureOpenClawStateWorkerContext(options);
  const location = { context, location: pathname, checkFreshAdmission: false };
  const authority = { signal: new AbortController().signal, assertCurrent: () => {} };
  const command = {
    type: "cron.observeRunRecovery" as const,
    storeKey: "租户🦞",
    proposals: [
      { jobId: "任务雪", queuedAtMs: 1, runningAtMs: 2 },
      { jobId: "运行🌊", runningAtMs: 3 },
    ],
  };
  const expected = structuredClone(command);
  const transport = createOpenClawStateReadTransport(command);
  const baseline = createOpenClawStateReadTransport({ type: "fleet.list" });
  command.storeKey = "changed partition";
  command.proposals[0]!.jobId = "changed before preparation";
  command.proposals[0]!.queuedAtMs = 9;
  const dispatch = createDeferredCore();
  const baselineTask = queueTask(dispatch.promise);
  const task = queueTask(dispatch.promise);
  const baselineRead = baseline.read(location, authority);
  const read = transport.read(location, authority);
  try {
    const [baseOptions, submittedOptions] = await Promise.all([
      baselineTask.submitted,
      task.submitted,
    ]);
    const expectedBytes =
      Buffer.byteLength(expected.type) -
      Buffer.byteLength("fleet.list") +
      Buffer.byteLength(expected.storeKey) +
      expected.proposals.reduce((total, entry) => total + Buffer.byteLength(entry.jobId), 24);
    expect(submittedOptions.inputBytes).toBe(Number(baseOptions.inputBytes) + expectedBytes);
    command.proposals.splice(0);
    dispatch.resolve();
    expect((await task.captured).command).toEqual(expected);
    baselineTask.result.resolve(emptyReply);
    task.result.resolve({
      ok: true,
      type: expected.type,
      sourceAdmitted: true,
      observation: { kind: "observed", proposals: [] },
    });
    await Promise.all([baselineRead, read]);
  } finally {
    dispatch.resolve();
    baselineTask.result.resolve(emptyReply);
    task.result.resolve(emptyReply);
    await Promise.allSettled([baselineRead, read]);
    await Promise.all([baseline.close(), transport.close()]);
  }
});

it("captures and charges independent snapshot and schema paths before queued dispatch", async () => {
  const { root, options } = source();
  const context = { ...captureOpenClawStateWorkerContext(options), existingSchemaPath: undefined };
  const existingSchemaPath = path.join(root, "canonical-schema-根🦞.sqlite");
  const snapshotRoot = path.join(root, "snapshot-根🦞");
  const location = path.join(snapshotRoot, "nested", "reader.sqlite");
  const sourceLocation = { context, location, checkFreshAdmission: true, snapshotRoot };
  const schemaLocation = {
    ...sourceLocation,
    context: { ...context, existingSchemaPath },
  };
  const controller = new AbortController();
  const authority = {
    signal: controller.signal,
    assertCurrent() {
      controller.signal.throwIfAborted();
      context.admission.assertCurrent();
    },
  };
  const dispatch = createDeferredCore();
  const baselineTask = queueTask(dispatch.promise);
  const rootedTask = queueTask(dispatch.promise);
  const schemaTask = queueTask(dispatch.promise);
  const baseline = createOpenClawStateReadTransport({ type: "fleet.list" });
  const rooted = createOpenClawStateReadTransport({ type: "fleet.list" });
  const schema = createOpenClawStateReadTransport({ type: "fleet.list" });
  const baselineRead = baseline.read({ ...sourceLocation, snapshotRoot: undefined }, authority);
  const rootedRead = rooted.read(sourceLocation, authority);
  const schemaRead = schema.read(schemaLocation, authority);
  try {
    const [baselineOptions, rootedOptions, schemaOptions] = await Promise.all([
      baselineTask.submitted,
      rootedTask.submitted,
      schemaTask.submitted,
    ]);
    const baselineBytes = baselineOptions.inputBytes;
    const rootedBytes = rootedOptions.inputBytes;
    const schemaBytes = schemaOptions.inputBytes;
    expect(Number.isSafeInteger(baselineBytes)).toBe(true);
    expect(Number.isSafeInteger(rootedBytes)).toBe(true);
    expect(Number.isSafeInteger(schemaBytes)).toBe(true);
    if (
      typeof baselineBytes !== "number" ||
      typeof rootedBytes !== "number" ||
      typeof schemaBytes !== "number"
    ) {
      throw new Error("Captured worker requests must carry byte admission");
    }
    // Each independently retained path must add at least its own UTF-8 payload.
    expect(rootedBytes).toBeGreaterThanOrEqual(baselineBytes + Buffer.byteLength(snapshotRoot));
    expect(schemaBytes).toBeGreaterThanOrEqual(rootedBytes + Buffer.byteLength(existingSchemaPath));
    sourceLocation.snapshotRoot = path.join(root, "replacement-root");
    sourceLocation.location = path.join(root, "replacement.sqlite");
    schemaLocation.context.existingSchemaPath = path.join(root, "replacement-schema.sqlite");
    dispatch.resolve();
    const [unrootedRequest, rootedRequest, schemaRequest] = await Promise.all([
      baselineTask.captured,
      rootedTask.captured,
      schemaTask.captured,
    ]);
    expect(unrootedRequest.snapshotRoot).toBeUndefined();
    expect(rootedRequest).toMatchObject({ location, snapshotRoot, checkFreshAdmission: true });
    expect(rootedRequest.snapshotRoot).not.toBe(path.dirname(rootedRequest.location));
    expect(schemaRequest).toMatchObject({
      context: { existingSchemaPath },
      location,
      snapshotRoot,
      checkFreshAdmission: true,
    });
    baselineTask.result.resolve(emptyReply);
    rootedTask.result.resolve(emptyReply);
    schemaTask.result.resolve(emptyReply);
    await expect(baselineRead).resolves.toEqual({ value: emptyReply });
    await expect(rootedRead).resolves.toEqual({ value: emptyReply });
    await expect(schemaRead).resolves.toEqual({ value: emptyReply });
  } finally {
    dispatch.resolve();
    baselineTask.result.resolve(emptyReply);
    rootedTask.result.resolve(emptyReply);
    schemaTask.result.resolve(emptyReply);
    await Promise.allSettled([baselineRead, rootedRead, schemaRead]);
    await Promise.all([baseline.close(), rooted.close(), schema.close()]);
  }
});
