// Register shared pool mocks before modules that consume them.
// oxfmt-ignore
import { emptyReply, mock, queueTask, source, tempDirs } from "./openclaw-state-read-worker.test-harness.js";
import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { AcpSessionReadInput } from "../acp/runtime/session-meta-read.types.js";
import { createWorkspaceStateIdentity } from "../agents/workspace-state-identity.js";
import type { ExecutionIdentityInspectionQuery } from "../audit/execution-identity-inspection.types.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  registerOpenClawStateDatabaseAsyncResource,
} from "./openclaw-state-db-cache.js";
import { executeExistingOpenClawStateRead } from "./openclaw-state-db-readonly.js";
import { withExistingOpenClawStateSchema } from "./openclaw-state-db-schema-policy.js";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db.js";
import { captureOpenClawStateReadSource } from "./openclaw-state-read-worker.js";
import type {
  OpenClawStateReadCommand,
  OpenClawStateReadReply,
} from "./openclaw-state-read.types.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import { encodeOpenClawStateWorkerError } from "./openclaw-state-worker-error.js";

it("captures queued read routing and schema facts without reading unrelated environment values", async () => {
  const { root, pathname } = source();
  let unrelatedReads = 0;
  const env: NodeJS.ProcessEnv = {
    OPENCLAW_STATE_DIR: root,
    OPENCLAW_SUPERVISOR_MODE: " EXTERNAL ",
    get UNRELATED_INITIALIZATION_VALUE() {
      unrelatedReads += 1;
      return "synthetic initializer input";
    },
  };
  const dispatch = createDeferredCore();
  const task = queueTask(dispatch.promise);
  const result = withExistingOpenClawStateSchema({ path: pathname }, () =>
    executeExistingOpenClawStateRead({ path: pathname, env }, { type: "backup.runs" }),
  );
  try {
    expect((await task.submitted).diagnosticOperation).toBe("backup.runs");
    env.OPENCLAW_STATE_DIR = path.join(root, "changed-after-capture");
    env.OPENCLAW_SUPERVISOR_MODE = "internal";
    dispatch.resolve();
    const request = await task.captured;
    expect(request.context.environment).toEqual({
      OPENCLAW_STATE_DIR: root,
      OPENCLAW_SUPERVISOR_MODE: "external",
    });
    expect(request.context.existingSchemaPath).toBe(pathname);
    // Windows captures case-insensitive environment semantics before selecting these facts.
    if (process.platform !== "win32") {
      expect(unrelatedReads).toBe(0);
    }
    task.result.resolve(emptyReply);
    await expect(result).resolves.toEqual(emptyReply);
  } finally {
    dispatch.resolve();
    task.result.resolve(emptyReply);
    await Promise.allSettled([result]);
  }
});

it("retains the shared pool after a resource drain fails until canonical retry", async () => {
  const { options } = source();
  const warm = queueTask();
  warm.result.resolve(emptyReply);
  await executeExistingOpenClawStateRead(options, { type: "backup.runs" });
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

it("preserves task and cleanup errors across explicit retirement retries", async () => {
  const { pathname, options } = source();
  const task = queueTask();
  const original = new Error("original worker task failed");
  const retirement = new Error("first worker stop failed");
  const retryFailure = new Error("second worker stop failed");
  task.close.mockRejectedValueOnce(retirement);
  task.close.mockRejectedValueOnce(retryFailure);
  const result = executeExistingOpenClawStateRead(options, { type: "backup.runs" });
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
  await expect(closeOpenClawStateDatabaseByPathAsync(pathname)).rejects.toBe(retryFailure);
  expect(task.close).toHaveBeenCalledTimes(2);
  await closeOpenClawStateDatabaseByPathAsync(pathname);
  expect(task.close).toHaveBeenCalledTimes(3);
  await closeOpenClawStateDatabaseByPathAsync(pathname);
  expect(task.close).toHaveBeenCalledTimes(3);
  expect(mock.closePool).not.toHaveBeenCalled();
  expect(mock.runTask).toHaveBeenCalledOnce();
  await expect(result).rejects.toMatchObject({ cause: original, errors: [original, retirement] });
});

it("reads externally created state after an absent read without allocating a worker first", async () => {
  const root = tempDirs.make("openclaw-read-first-creation-");
  const pathname = path.join(root, "source.sqlite");
  const options = { path: pathname, env: { OPENCLAW_STATE_DIR: root } };
  const command = { type: "backup.runs" } as const;
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
  expect(task.close).toHaveBeenCalledExactlyOnceWith(undefined);
  expect(mock.closePool).not.toHaveBeenCalled();
});

it("retains read custody until release and retires failed native cleanup", async () => {
  const { options } = source();
  const task = queueTask();
  const stopping = createDeferredCore();
  const stopped = createDeferredCore();
  task.close.mockImplementationOnce(() => {
    stopping.resolve();
    return stopped.promise;
  });
  const reply: OpenClawStateReadReply = {
    ...emptyReply,
    nativeCleanupFailure: { error: undefined },
  };
  const result = executeExistingOpenClawStateRead(options, { type: "backup.runs" });
  const assertion = expect(result).resolves.toMatchObject({
    ok: true,
    type: "backup.runs",
    runs: [],
  });
  let settled = false;
  const markSettled = () => {
    settled = true;
  };
  void result.then(markSettled, markSettled);
  try {
    await task.captured;
    task.result.resolve(reply);
    await stopping.promise;
    expect(task.close).toHaveBeenCalledExactlyOnceWith({ retire: true });
    expect(mock.selectSqlite).toHaveBeenCalledOnce();
    expect(mock.selectSqlite.mock.invocationCallOrder[0]).toBeLessThan(
      mock.create.mock.invocationCallOrder[0]!,
    );
    expect(settled).toBe(false);
    expect(mock.closePool).not.toHaveBeenCalled();
  } finally {
    task.result.resolve(reply);
    stopped.resolve();
    await assertion;
  }
  expect(task.close).toHaveBeenCalledOnce();
});

it("preserves source, quarantine cleanup, and worker stop failures", async () => {
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
  const result = executeExistingOpenClawStateRead(options, { type: "backup.runs" });
  const outcome = result.catch((error: unknown) => error);
  await task.captured;
  const reply: OpenClawStateReadReply = {
    ok: false,
    sourceAdmitted: true,
    message: primary.message,
    error: encodeOpenClawStateWorkerError(primary, { includeOrdinary: true }),
  };
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
  expect(failure.cause).toMatchObject({ message: primary.message });
  const cleanup: unknown = failure.errors[1];
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
});

it("closes one read path without aborting its sibling", async () => {
  const firstSource = source("first.sqlite");
  const siblingSource = source("sibling.sqlite");
  const first = queueTask();
  const sibling = queueTask();
  const firstRead = executeExistingOpenClawStateRead(firstSource.options, {
    type: "backup.runs",
  });
  const assertion = expect(firstRead).rejects.toThrow(/read admission (?:is )?closed/i);
  const siblingRead = executeExistingOpenClawStateRead(siblingSource.options, {
    type: "backup.runs",
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
  expect(sibling.close).toHaveBeenCalledExactlyOnceWith(undefined);
  await closeOpenClawStateDatabaseAsync();
  expect(mock.closePool).toHaveBeenCalledOnce();
});

function captureCase<T extends OpenClawStateReadCommand>(
  command: T,
  reply: OpenClawStateReadReply,
  bytes: number,
  mutate: (command: T) => void,
  options: {
    exact?: boolean;
    prepared?: boolean;
    expected?: OpenClawStateReadCommand;
    queued?: () => void;
  } = {},
) {
  return { command, reply, bytes, mutate: () => mutate(command), ...options };
}

const selector = "租户🦞".repeat(512);
const selectorBytes = Buffer.byteLength(selector);
const historyInput = { reason: selector, includeRunId: selector, active: true, limit: 100 };
const reconciliationInput = {
  runIds: ["更新🦞".repeat(512), "修复🦞".repeat(512)],
  explicit: true,
  requireAllActive: false,
  legacyOnly: true,
  repairHistorySinceMs: 0,
};
const captures = [
  ...(
    [
      "githubPublication.sharedObservation",
      "onboardingRecommendations.read",
      "workspace.snapshot",
      "pluginBlob.lookup",
      "pluginBlob.entries",
      "sandboxRegistry.get",
      "sandboxRegistry.runtimeIds",
      "updateRuns.get",
    ] as const
  ).map((type) => {
    const command =
      type === "githubPublication.sharedObservation"
        ? {
            type,
            input: {
              kind: "repository" as const,
              session: {
                agentId: selector,
                sessionKey: selector,
                sessionId: selector,
                lifecycleRevision: selector,
              },
              selector: { requestId: selector },
              entry: {
                repositoryWorkspaceId: selector,
                lifecycleRevision: selector,
                worktree: { id: selector, branch: selector, repoRoot: selector },
              },
            },
          }
        : type === "updateRuns.get"
          ? { type, runId: selector }
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
    const returned: OpenClawStateReadReply =
      type === "githubPublication.sharedObservation"
        ? { ok: true, type, sourceAdmitted: true, row: undefined }
        : type === "updateRuns.get"
          ? { ok: true, type, sourceAdmitted: true, run: undefined }
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
    const selectorCount =
      type === "githubPublication.sharedObservation"
        ? 10
        : type === "pluginBlob.lookup"
          ? 3
          : type === "pluginBlob.entries" || type === "sandboxRegistry.runtimeIds"
            ? 2
            : 1;

    return captureCase(command, returned, selectorBytes * selectorCount, () => {
      if (command.type === "githubPublication.sharedObservation") {
        Object.assign(command.input.session, {
          agentId: "changed",
          sessionKey: "changed",
          sessionId: "changed",
          lifecycleRevision: "changed",
        });
        command.input.selector.requestId = "changed";
        command.input.entry.repositoryWorkspaceId = "changed";
        command.input.entry.lifecycleRevision = "changed";
        Object.assign(command.input.entry.worktree, {
          id: "changed",
          branch: "changed",
          repoRoot: "changed",
        });
      } else if (command.type === "updateRuns.get") {
        command.runId = "different run after admission";
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
    });
  }),
  captureCase(
    {
      type: "updateRuns.list",
      input: historyInput,
    },
    { ok: true, type: "updateRuns.list", sourceAdmitted: true, runs: [] },
    selectorBytes * 2 + 9,
    ({ input }) => {
      input.reason = "changed";
      input.includeRunId = "changed";
      input.active = false;
      input.limit = 1;
    },
  ),
  ...(["descendants", "maintenance"] as const).map((kind) => {
    const input = {
      sessionKeys: ["父会话🦞".repeat(256)],
      liveTopology: [
        { childSessionKey: "子会话🦞".repeat(256), requesterSessionKey: "请求者🦞".repeat(256) },
      ],
    };
    return captureCase(
      { type: "subagents.runs", scope: kind === "descendants" ? { kind, ...input } : { kind } },
      kind === "maintenance"
        ? {
            ok: true,
            type: "subagents.runs",
            sourceAdmitted: true,
            projection: "maintenance",
            runs: new Map(),
            maintenanceDigest: "fixture",
          }
        : { ok: true, type: "subagents.runs", sourceAdmitted: true, runs: new Map() },
      kind === "descendants"
        ? Buffer.byteLength(input.sessionKeys[0]!) +
            Buffer.byteLength(input.liveTopology[0]!.childSessionKey) +
            Buffer.byteLength(input.liveTopology[0]!.requesterSessionKey)
        : 0,
      () => {
        input.sessionKeys[0] = "changed";
        input.sessionKeys.push("added after admission");
        input.liveTopology[0]!.childSessionKey = "changed child";
        input.liveTopology[0]!.requesterSessionKey = "changed requester";
        input.liveTopology.push({
          childSessionKey: "added child",
          requesterSessionKey: "added requester",
        });
      },
      { exact: true },
    );
  }),
  captureCase(
    {
      type: "updateRuns.reconciliationCandidates",
      input: reconciliationInput,
    },
    { ok: true, type: "updateRuns.reconciliationCandidates", sourceAdmitted: true, candidates: [] },
    Buffer.byteLength("更新🦞修复🦞".repeat(512)) + 11,
    ({ input }) => {
      input.runIds[0] = "changed";
      input.runIds.push("added after admission");
      input.explicit = false;
      input.requireAllActive = true;
      input.legacyOnly = false;
      input.repairHistorySinceMs = 999;
    },
    { exact: true },
  ),
  captureCase(
    {
      type: "skills.library.manifests",
      input: [{ skillId: "技能🦞".repeat(512), revision: "版本🦞".repeat(512) }],
    },
    { ok: true, type: "skills.library.manifests", sourceAdmitted: true, value: [] },
    selectorBytes * 2,
    ({ input }) => {
      input[0]!.skillId = "changed";
      input[0]!.revision = "changed";
      input.push({ skillId: "extra", revision: "extra" });
    },
  ),
  ...(
    [
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
      { input: { executionId: "执行🦞", now: 0 }, numericBytes: 8 },
    ] satisfies Array<{ input: ExecutionIdentityInspectionQuery; numericBytes: number }>
  ).map(
    ({ input, numericBytes }: { input: ExecutionIdentityInspectionQuery; numericBytes: number }) =>
      captureCase(
        { type: "audit.run.inspect", input },
        emptyReply,
        Buffer.byteLength("executionId" in input ? input.executionId : input.runId) +
          Buffer.byteLength(input.decisionCursor ?? "") +
          numericBytes,
        () => {
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
        },
        {
          exact: true,
          prepared: true,
          queued: () => {
            input.now = 1234;
            input.decisionCursor = "changed while queued";
          },
        },
      ),
  ),
  captureCase(
    { type: "channelIngress.failedHealth", callerContext: { onClosed: () => {} } },
    { ok: true, type: "channelIngress.failedHealth", sourceAdmitted: true, result: [] },
    0,
    () => {},
    { prepared: true, expected: { type: "channelIngress.failedHealth" } },
  ),
  (() => {
    const command = {
      type: "cron.observeRunRecovery" as const,
      storeKey: "租户🦞",
      proposals: [
        { jobId: "任务雪", queuedAtMs: 1, runningAtMs: 2 },
        { jobId: "运行🌊", runningAtMs: 3 },
      ],
    };
    return captureCase(
      command,
      {
        ok: true,
        type: command.type,
        sourceAdmitted: true,
        observation: { kind: "observed", proposals: [] },
      },
      Buffer.byteLength("租户🦞任务雪运行🌊") + 24,
      () => {
        command.storeKey = "changed partition";
        command.proposals[0]!.jobId = "changed before preparation";
        command.proposals[0]!.queuedAtMs = 9;
      },
      {
        exact: true,
        prepared: true,
        queued: () => {
          command.proposals.splice(0);
        },
      },
    );
  })(),
];

it.each(captures)(
  "captures $command.type selectors and byte charges before queued dispatch (%#)",
  async (fixture) => {
    const { pathname, options } = source();
    const expected = fixture.expected ?? structuredClone(fixture.command);
    const originalRoot = options.env.OPENCLAW_STATE_DIR;
    const context = captureOpenClawStateWorkerContext(options);
    const location = { context, location: pathname, checkFreshAdmission: false };
    const authority = { signal: new AbortController().signal, assertCurrent: () => {} };
    const transport = fixture.prepared
      ? captureOpenClawStateReadSource().createTransport(fixture.command)
      : undefined;
    const baselineTransport = fixture.prepared
      ? captureOpenClawStateReadSource().createTransport({ type: "backup.runs" })
      : undefined;
    if (transport) {
      fixture.mutate();
    }
    const dispatch = createDeferredCore();
    const baselineTask = queueTask(dispatch.promise);
    const task = queueTask(dispatch.promise);
    const baseline = baselineTransport
      ? baselineTransport.startRead(location, authority).result
      : executeExistingOpenClawStateRead(options, { type: "backup.runs" });
    const result = transport
      ? transport.startRead(location, authority).result
      : executeExistingOpenClawStateRead(options, fixture.command);
    try {
      const [baselineOptions, submitted] = await Promise.all([
        baselineTask.submitted,
        Promise.race([
          task.submitted,
          result.then(() => {
            throw new Error("Read settled before queued dispatch");
          }),
        ]),
      ]);
      if (!transport) {
        fixture.mutate();
      }
      fixture.queued?.();
      options.env.OPENCLAW_STATE_DIR = path.join(originalRoot, "different");
      expect(Number.isSafeInteger(submitted.inputBytes)).toBe(true);
      if (fixture.exact) {
        expect(submitted.inputBytes).toBe(
          Number(baselineOptions.inputBytes) +
            Buffer.byteLength(expected.type) -
            Buffer.byteLength("backup.runs") +
            fixture.bytes,
        );
      } else {
        expect(submitted.inputBytes).toBeGreaterThanOrEqual(fixture.bytes);
      }
      dispatch.resolve();
      const request = await task.captured;
      expect(request.command).toEqual(expected);
      expect(request.context.environment.OPENCLAW_STATE_DIR).toBe(originalRoot);
      baselineTask.result.resolve(emptyReply);
      task.result.resolve(fixture.reply);
      expect(await result).toEqual(transport ? { value: fixture.reply } : fixture.reply);
      await baseline;
    } finally {
      dispatch.resolve();
      baselineTask.result.resolve(emptyReply);
      task.result.resolve(fixture.reply);
      await Promise.allSettled([baseline, result]);
      await Promise.all([baselineTransport?.startClose().result, transport?.startClose().result]);
    }
  },
);

it.each(["mcpOAuth.statuses", "userPreferences.values", "acpSessions.metadata"] as const)(
  "captures and charges the full %s batch before queued dispatch",
  async (type) => {
    const { options } = source();
    const context = captureOpenClawStateWorkerContext(options);
    const keys = ["principal-根🦞", "second-principal"];
    const expected = [...keys];
    const entry = {
      lifecycleRevision: "revision-根🦞",
      sessionId: "session-根🦞",
      sessionStartedAt: 0,
    };
    const metadata = { keys, entry };
    const entries: AcpSessionReadInput[] = [metadata, { keys: ["entry-without-optionals"] }];
    const expectedEntries: AcpSessionReadInput[] = [
      { ...metadata, keys: [...keys], entry: { ...entry } },
      { keys: ["entry-without-optionals"] },
    ];
    const dispatch = createDeferredCore();
    const baselineTask = queueTask(dispatch.promise);
    const task = queueTask(dispatch.promise);
    const baseline = captureOpenClawStateReadSource().createTransport({ type: "backup.runs" });
    const key = "notification-根🦞";
    const transport = captureOpenClawStateReadSource().createTransport(
      type === "mcpOAuth.statuses"
        ? { type, input: keys }
        : type === "userPreferences.values"
          ? { type, profileIds: keys, key }
          : { type, entries },
    );
    const controller = new AbortController();
    const authority = {
      signal: controller.signal,
      assertCurrent: context.admission.assertCurrent,
    };
    const location = { context, location: options.path, checkFreshAdmission: true };
    const baselineRead = baseline.startRead(location, authority).result;
    const read = transport.startRead(location, authority).result;
    try {
      const [baselineOptions, batchOptions] = await Promise.all([
        baselineTask.submitted,
        task.submitted,
      ]);
      const additionalBytes =
        Buffer.byteLength(type) -
        Buffer.byteLength("backup.runs") +
        (type === "acpSessions.metadata"
          ? expectedEntries.reduce(
              (bytes, input) =>
                bytes +
                input.keys.reduce((total, sessionKey) => total + Buffer.byteLength(sessionKey), 0) +
                Buffer.byteLength(input.entry?.lifecycleRevision ?? "") +
                Buffer.byteLength(input.entry?.sessionId ?? "") +
                (input.entry?.sessionStartedAt === undefined ? 0 : 8),
              0,
            )
          : expected.reduce((bytes, profileId) => bytes + Buffer.byteLength(profileId), 0)) +
        (type === "userPreferences.values" ? Buffer.byteLength(key) : 0);
      expect(batchOptions.inputBytes).toBe(Number(baselineOptions.inputBytes) + additionalBytes);
      keys[0] = "changed-principal";
      keys.push("added-after-admission");
      entry.lifecycleRevision = "changed-revision";
      entry.sessionId = "changed-session";
      entry.sessionStartedAt = 99;
      entries.push({ keys: ["added-entry-after-admission"] });
      dispatch.resolve();
      expect((await task.captured).command).toEqual(
        type === "mcpOAuth.statuses"
          ? { type, input: expected }
          : type === "userPreferences.values"
            ? { type, profileIds: expected, key }
            : { type, entries: expectedEntries },
      );
      baselineTask.result.resolve(emptyReply);
      task.result.resolve(
        type === "mcpOAuth.statuses"
          ? {
              ok: true,
              type,
              sourceAdmitted: true,
              value: expected.map(() => ({ state: "unauthenticated" })),
            }
          : type === "userPreferences.values"
            ? { ok: true, type, sourceAdmitted: true, values: new Map() }
            : { ok: true, type, sourceAdmitted: true, rows: expectedEntries.map(() => null) },
      );
      await Promise.all([baselineRead, read]);
    } finally {
      dispatch.resolve();
      baselineTask.result.resolve(emptyReply);
      task.result.resolve(emptyReply);
      await Promise.allSettled([baselineRead, read]);
      await Promise.all([baseline.startClose().result, transport.startClose().result]);
    }
  },
);
