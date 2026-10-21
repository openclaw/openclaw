import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { expect, it, vi, type Mock } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import type { DomainScope } from "../state/openclaw-state-worker-store.types.js";
import { useStateDatabaseTempDirs } from "../test-utils/state-database-temp-dirs.js";
import { submitGithubIssue, type RunGithubCli } from "./github-issue.js";
import {
  finalizeUpdateFailureReportReceipt,
  markUpdateFailureReportReceiptPending,
  markUpdateFailureReportReceiptPrepared as markPrepared,
  readUpdateFailureReportReceipt,
  reserveUpdateFailureReportReceipt as reserveReceipt,
} from "./restart-sentinel.js";
import { SqliteWorkerError } from "./sqlite-worker-contract.js";
import { prepareUpdateFailureReport } from "./update-failure-report.js";
import {
  expireUpdateFailureReportReceipt,
  submitUpdateFailureReportFixture as submitUpdateFailureReport,
} from "./update-failure-report.test-support.js";

const tempDirs = useStateDatabaseTempDirs();
const issueUrl = "https://github.com/openclaw/openclaw/issues/123";
const authSuccess = { started: true, status: 0, stdout: Buffer.alloc(0) };

function wrapWorkerExecute(wrap: (execute: DomainScope["execute"]) => DomainScope["execute"]) {
  const run = stateWorker.runOpenClawStateWorkerOperation;
  vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation").mockImplementation(
    (context, operation, options) =>
      run(context, (scope) => operation({ execute: wrap(scope.execute) }), options),
  );
}

async function expectUnpublished(fixture: Awaited<ReturnType<typeof setup>>) {
  expect(fixture.createCalls).toHaveLength(0);
  expect(await fixture.receipt()).toBeNull();
  await expect(fs.stat(`${fixture.stateDir}/update-reports`)).rejects.toMatchObject({
    code: "ENOENT",
  });
}

function pauseAuthentication(runGh: Mock<RunGithubCli>) {
  const entered = createDeferredCore();
  const released = createDeferredCore();
  runGh.mockImplementationOnce(async () => {
    entered.resolve();
    await released.promise;
    return authSuccess;
  });
  return { entered: entered.promise, release: () => released.resolve() };
}

async function setup(onPost?: () => void) {
  const stateDir = tempDirs.make("openclaw-report-transport-");
  const prepared = await prepareUpdateFailureReport(
    {
      attemptId: "transport-guard",
      result: {
        mode: "npm",
        status: "error",
        reason: "install-failed",
        steps: [],
        durationMs: 1,
      },
    },
    { stateDir },
  );
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const receipt = () => readUpdateFailureReportReceipt(prepared.attemptId, env);
  const createCalls: string[] = [];
  const runGh = vi.fn<RunGithubCli>(async (args, options) => {
    if (args[0] === "auth") {
      return authSuccess;
    }
    if (args[0] !== "api") {
      throw new Error("unexpected GitHub invocation");
    }
    onPost?.();
    // The observable transport boundary must already have a body-bound durable fence.
    expect(await receipt()).toMatchObject({
      status: "pending",
      previewDigest: prepared.previewDigest,
    });
    expect(JSON.parse(options.input)).toEqual({ body: prepared.body, title: prepared.title });
    createCalls.push(options.input);
    return { started: true, status: 0, stdout: Buffer.from(issueUrl) };
  });
  const submit = (options: Parameters<typeof submitUpdateFailureReport>[2] = {}) =>
    submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue: (issue, hooks) => submitGithubIssue(issue, runGh, hooks),
      stateDir,
      ...options,
    });
  const outcome = (options: Parameters<typeof submit>[0]) =>
    submit(options).catch((error: unknown) => error);
  return { createCalls, prepared, receipt, runGh, stateDir, submit, outcome, env };
}

// Lost replies follow settlement; busy/unknown failures precede the mutation.
it.each([
  ["reserve", "host", "settled"],
  ["markPrepared", "host", "settled"],
  ["markPending", "host", "settled"],
  ["refreshPreparation", "browser", "settled"],
  ["finalizeReceipt", "host", "settled"],
  ["markPrepared", "host", "busy"],
  ["markPrepared", "host", "unknown"],
] as const)("native %s/%s: %s", async (operation, publicationMode, failure) => {
  const fixture = await setup();
  let executions = 0;
  wrapWorkerExecute((execute) => async (command, options) => {
    if (command.type !== `restartSentinel.${operation}`) {
      return execute(command, options);
    }
    executions += 1;
    if (failure === "settled") {
      await execute(command, options);
    } else if (executions > 1) {
      return execute(command, options);
    }
    throw failure === "busy"
      ? Object.assign(new Error("Locked before transaction admission"), { code: "SQLITE_BUSY" })
      : new SqliteWorkerError("Mutation reply unavailable", "outcome-unknown");
  });
  const result = await fixture.submit({ publicationMode });
  const expected =
    failure === "unknown" ? "retryable" : publicationMode === "host" ? "created" : "fallback";
  expect(result.status).toBe(expected);
  expect(executions).toBe(failure === "busy" ? 2 : 1);
  expect(fixture.createCalls).toHaveLength(expected === "created" ? 1 : 0);
  if (failure === "settled") {
    expect(await fixture.receipt()).toMatchObject({ status: expected });
  }
});

it("does not publish when a status check cannot find its prior receipt", async () => {
  const fixture = await setup();
  const result = await fixture.submit({ publicationMode: "reconcile" });
  expect(result).toMatchObject({ status: "pending" });
  expect(result).not.toHaveProperty("fallbackUrl");
  expect(fixture.runGh).not.toHaveBeenCalled();
  expect(await fixture.receipt()).toBeNull();
});

it.each(["attempt", "authority"] as const)("fences %s at persist", async (change) => {
  const fixture = await setup();
  let current = true;
  const finalizeReceipt = vi.fn(
    async (...args: Parameters<typeof finalizeUpdateFailureReportReceipt>) => {
      const finalized = await finalizeUpdateFailureReportReceipt(...args);
      current = false;
      return finalized;
    },
  );
  const result = await fixture.outcome({
    publicationMode: "browser",
    finalizeReceipt,
    hasCurrentAuthority: () => change !== "authority" || current,
    validateCurrentAttempt: () => change !== "attempt" || current,
  });
  if (change === "attempt") {
    expect(result).toMatchObject({ status: "stale" });
  } else {
    expect(result).toBeInstanceOf(Error);
  }
  expect(result).not.toHaveProperty("fallbackUrl");
  expect(await fixture.receipt()).toMatchObject({
    status: "fallback",
    previewDigest: fixture.prepared.previewDigest,
  });
  const recovered = await fixture.submit({ publicationMode: "browser" });
  expect(await fs.readFile(recovered.savedReportPath, "utf8")).toBe(fixture.prepared.body);
  expect(fixture.runGh).not.toHaveBeenCalled();
});

it("permits saved-only finalization from prepared without widening created or stale ownership", async () => {
  const { prepared, receipt, env } = await setup();
  const ownership = [prepared.attemptId, "owner", prepared.previewDigest, env] as const;
  await reserveReceipt(...ownership);
  expect(await markPrepared(...ownership)).toBe(true);
  const finalize = (value: Parameters<typeof finalizeUpdateFailureReportReceipt>[1]) =>
    finalizeUpdateFailureReportReceipt(prepared.attemptId, value, env);
  const retryable = {
    status: "retryable" as const,
    reservationId: "owner",
    previewDigest: prepared.previewDigest,
  };
  expect(await finalize({ ...retryable, status: "created", url: issueUrl })).toBe(false);
  expect(await finalize({ ...retryable, reservationId: "stale-owner" })).toBe(false);
  expect(await finalize({ ...retryable, previewDigest: "f".repeat(64) })).toBe(false);
  expect(await receipt()).toMatchObject({ status: "prepared", reservationId: "owner" });
  expect(await finalize(retryable)).toBe(true);
  expect(await receipt()).toMatchObject(retryable);
});

it.each(["host", "browser"] as const)("binds Unicode body via %s", async (publicationMode) => {
  const stateDir = tempDirs.make("openclaw-report-long-body-");
  const input = {
    attemptId: "long-report-A",
    result: {
      mode: "npm" as const,
      status: "error" as const,
      reason: "🦞".repeat(150),
      steps: Array.from({ length: 3 }, (_, i) => ({
        name: `${i}${"🦞".repeat(150)}`,
        command: "private command must not appear",
        cwd: "/Users/private/report",
        durationMs: 1,
        exitCode: 1,
      })),
      durationMs: 1,
    },
    target: "🦞".repeat(150),
  };
  const prepared = await prepareUpdateFailureReport(input, { stateDir });
  const other = await prepareUpdateFailureReport({ ...input, attemptId: "B" }, { stateDir });
  expect(other.marker).not.toBe(prepared.marker);
  expect(prepared.browserFallback.status).toBe("unavailable");
  expect(prepared.url).toBeUndefined();
  expect(prepared.previewDigest).toBe(createHash("sha256").update(prepared.body).digest("hex"));
  expect(Buffer.byteLength(prepared.body)).toBeLessThanOrEqual(16_000);
  expect(prepared.body).not.toContain("�");
  expect(prepared.body).not.toContain("private");
  const runGh = vi.fn<RunGithubCli>().mockResolvedValue({ ...authSuccess, status: 1 });
  const result = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
    createIssue: (issue, hooks) => submitGithubIssue(issue, runGh, hooks),
    publicationMode,
    stateDir,
  });
  expect(result).toMatchObject({ status: "retryable" });
  expect(result).not.toHaveProperty("fallbackUrl");
  expect(runGh).toHaveBeenCalledTimes(publicationMode === "host" ? 1 : 0);
  expect(await fs.readFile(result.savedReportPath, "utf8")).toBe(prepared.body);
});

it.each([false, true])("guards POST: retire=%s", async (retire) => {
  let current = true;
  const authorityAtPost: boolean[] = [];
  const fixture = await setup(() => authorityAtPost.push(current));
  const result = await fixture.outcome({
    hasCurrentAuthority: () => current,
    markPending: async (...args) => {
      const marked = await markUpdateFailureReportReceiptPending(...args);
      expect(marked).toBe(true);
      if (retire) {
        queueMicrotask(() => {
          current = false;
        });
      }
      return marked;
    },
  });
  expect.soft(authorityAtPost).not.toContain(false);
  if (authorityAtPost.length === 0) {
    expect(retire).toBe(true);
    expect(result).toBeInstanceOf(Error);
    await expectUnpublished(fixture);
  } else {
    expect(authorityAtPost).toHaveLength(1);
    expect(result).toMatchObject({ status: "created", url: issueUrl });
    expect(await fixture.submit()).toMatchObject({ status: "duplicate", url: issueUrl });
    expect(fixture.createCalls).toHaveLength(1);
  }
});

it.each(["preparation", "validation"] as const)("guards %s revocation", async (stage) => {
  const fixture = await setup();
  let current = true;
  let insidePreCreate = false;
  let retireAfterValidation = false;
  const retire = () => {
    current = false;
  };
  const result = await fixture.outcome({
    createIssue: (issue, hooks) =>
      submitGithubIssue(issue, fixture.runGh, {
        ...hooks,
        beforeIssueCreate: () => {
          insidePreCreate = true;
          if (!hooks.beforeIssueCreate) {
            throw new Error("expected a guarded Report submission");
          }
          const pending = hooks.beforeIssueCreate();
          return stage === "validation"
            ? pending
            : Promise.resolve(pending).then((commit) => {
                queueMicrotask(retire);
                return commit;
              });
        },
      }),
    validateCurrentAttempt:
      stage === "validation"
        ? () => {
            retireAfterValidation = insidePreCreate;
            return true;
          }
        : undefined,
    hasCurrentAuthority: () => {
      if (retireAfterValidation) {
        retireAfterValidation = false;
        queueMicrotask(retire);
      }
      return current;
    },
  });
  expect.soft(result).toBeInstanceOf(Error);
  expect(fixture.runGh.mock.calls.map(([args]) => args[0])).toEqual(["auth"]);
  await expectUnpublished(fixture);
});

it.each(["authority", "attempt"] as const)("fences paused-auth %s", async (change) => {
  const fixture = await setup();
  const auth = pauseAuthentication(fixture.runGh);
  let current = true;
  const submission = fixture.submit({
    hasCurrentAuthority: () => change !== "authority" || current,
    validateCurrentAttempt: () => change !== "attempt" || current,
  });
  // Observe rejection immediately, before releasing the asynchronous guard.
  const observed = submission.catch((error: unknown) => error);
  try {
    await auth.entered;
    current = false;
    auth.release();
    const result = await observed;
    if (change === "authority") {
      expect(result).toBeInstanceOf(Error);
    } else {
      expect(result).toMatchObject({ status: "stale" });
    }
    expect(fixture.runGh).toHaveBeenCalledOnce();
    await expectUnpublished(fixture);
  } finally {
    auth.release();
    await observed;
  }
});

it.each([
  { label: "missing", errorCode: "ENOENT", started: false, status: null },
  { label: "unauthenticated", started: true, status: 1 },
])("offers the exact browser body after $label auth without POST", async (failure) => {
  const fixture = await setup();
  fixture.runGh.mockResolvedValueOnce({ ...failure, stdout: Buffer.alloc(0) });
  const result = await fixture.submit();
  expect(result).toMatchObject({ status: "fallback", fallbackUrl: fixture.prepared.url });
  expect(fixture.runGh).toHaveBeenCalledOnce();
  expect(fixture.createCalls).toHaveLength(0);
  expect(new URL(fixture.prepared.url!).searchParams.get("body")).toBe(fixture.prepared.body);
});

it("keeps post-create ambiguity pending when revoked authority prevents reconciliation", async () => {
  const fixture = await setup();
  let current = true;
  fixture.runGh.mockImplementation(async (args) => {
    if (args[0] === "auth") {
      return authSuccess;
    }
    expect(args[0]).toBe("api");
    current = false;
    return { errorCode: "ETIMEDOUT", started: true, status: null, stdout: Buffer.alloc(0) };
  });
  const result = await fixture.submit({ hasCurrentAuthority: () => current });
  expect(result).toMatchObject({ status: "pending" });
  expect(result).not.toHaveProperty("fallbackUrl");
  expect(await fixture.receipt()).toMatchObject({ status: "pending" });
  expect(fixture.runGh).toHaveBeenCalledTimes(2);
  expect((await fs.stat(result.savedReportPath)).mode & 0o777).toBe(0o600);
});

it("lets a successor CAS independently while an expired owner is still authenticating", async () => {
  const fixture = await setup();
  const auth = pauseAuthentication(fixture.runGh);
  const oldSubmission = fixture.submit();
  try {
    await auth.entered;
    expireUpdateFailureReportReceipt(fixture.prepared.attemptId, fixture.stateDir);
    const successor = await fixture.submit();
    expect(successor).toMatchObject({ status: "created", url: issueUrl });
    auth.release();
    expect(await oldSubmission).toMatchObject({ status: "duplicate", url: issueUrl });
    expect(fixture.createCalls).toHaveLength(1);
    expect(fixture.runGh).toHaveBeenCalledTimes(3);
  } finally {
    auth.release();
    await oldSubmission;
  }
});
