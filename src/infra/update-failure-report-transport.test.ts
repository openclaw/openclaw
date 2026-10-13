import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { useStateDatabaseTempDirs } from "../test-utils/state-database-temp-dirs.js";
import { submitGithubIssue, type RunGithubCli } from "./github-issue.js";
import {
  finalizeUpdateFailureReportReceipt,
  markUpdateFailureReportReceiptPending,
  markUpdateFailureReportReceiptPrepared,
  readUpdateFailureReportReceipt,
  reserveUpdateFailureReportReceipt,
} from "./restart-sentinel.js";
import { SqliteWorkerError } from "./sqlite-worker-contract.js";
import { prepareUpdateFailureReport, submitUpdateFailureReport } from "./update-failure-report.js";
import { expireUpdateFailureReportReceipt } from "./update-failure-report.test-support.js";

const tempDirs = useStateDatabaseTempDirs();
const issueUrl = "https://github.com/openclaw/openclaw/issues/123";
const authSuccess: Awaited<ReturnType<RunGithubCli>> = {
  started: true,
  status: 0,
  stdout: Buffer.alloc(0),
};

async function setup() {
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
        before: { version: "2026.8.1" },
      },
    },
    { stateDir },
  );
  const receipt = async () =>
    await readUpdateFailureReportReceipt(prepared.attemptId, { OPENCLAW_STATE_DIR: stateDir });
  const createCalls: string[] = [];
  const runGh = vi.fn<RunGithubCli>(async (args, options) => {
    if (args[0] === "auth") {
      return authSuccess;
    }
    if (args[0] !== "api") {
      throw new Error("unexpected GitHub invocation");
    }
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
  return { createCalls, prepared, receipt, runGh, stateDir, submit };
}

describe("update report shared transport boundary", () => {
  it.each([
    { operation: "restartSentinel.reserve", publicationMode: "host" as const },
    { operation: "restartSentinel.markPrepared", publicationMode: "host" as const },
    { operation: "restartSentinel.markPending", publicationMode: "host" as const },
    { operation: "restartSentinel.refreshPreparation", publicationMode: "browser" as const },
    { operation: "restartSentinel.finalizeReceipt", publicationMode: "host" as const },
  ])(
    "recovers $operation from its native commit receipt without replay",
    async ({ operation, publicationMode }) => {
      const fixture = await setup();
      const run = stateWorker.runOpenClawStateWorkerOperation;
      let executions = 0;
      vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation").mockImplementation(
        (context, operationBody, options) =>
          run(
            context,
            (scope) =>
              operationBody({
                execute: async (command, executeOptions) => {
                  const result = await scope.execute(command, executeOptions);
                  if (command.type === operation) {
                    executions += 1;
                    throw new SqliteWorkerError(
                      "Ordinary reply lost after native settlement",
                      "outcome-unknown",
                    );
                  }
                  return result;
                },
              }),
            options,
          ),
      );
      const result = await fixture.submit({ publicationMode });
      expect(result.status).toBe(publicationMode === "host" ? "created" : "fallback");
      expect(executions).toBe(1);
      expect(fixture.createCalls).toHaveLength(publicationMode === "host" ? 1 : 0);
      expect(await fixture.receipt()).toMatchObject({
        status: publicationMode === "host" ? "created" : "fallback",
      });
    },
  );

  it.each(["busy-before-admission", "unknown"] as const)(
    "retries only a proven lock refusal before mutation (%s)",
    async (failure) => {
      const fixture = await setup();
      const run = stateWorker.runOpenClawStateWorkerOperation;
      let preparations = 0;
      vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation").mockImplementation(
        (context, operation, options) =>
          run(
            context,
            (scope) =>
              operation({
                execute: async (command, executeOptions) => {
                  if (command.type === "restartSentinel.markPrepared") {
                    preparations += 1;
                    if (preparations === 1) {
                      throw failure === "unknown"
                        ? new SqliteWorkerError("Mutation outcome unavailable", "outcome-unknown")
                        : Object.assign(new Error("Database locked before transaction admission"), {
                            code: "SQLITE_BUSY",
                          });
                    }
                  }
                  return scope.execute(command, executeOptions);
                },
              }),
            options,
          ),
      );
      const result = await fixture.submit();
      expect(result.status).toBe(failure === "unknown" ? "retryable" : "created");
      expect(preparations).toBe(failure === "unknown" ? 1 : 2);
      expect(fixture.createCalls).toHaveLength(failure === "unknown" ? 0 : 1);
    },
  );

  it("reconciles its exact pending row when no commit result reaches the caller", async () => {
    const fixture = await setup();
    const markPending = vi.fn(
      async (...args: Parameters<typeof markUpdateFailureReportReceiptPending>) => {
        await markUpdateFailureReportReceiptPending(...args);
        throw new SqliteWorkerError("Both pending acknowledgements lost", "outcome-unknown");
      },
    );
    expect(await fixture.submit({ markPending })).toMatchObject({
      status: "created",
      url: issueUrl,
    });
    expect(markPending).toHaveBeenCalledOnce();
    expect(fixture.createCalls).toHaveLength(1);
    expect(await fixture.submit()).toMatchObject({ status: "duplicate", url: issueUrl });
    expect(fixture.createCalls).toHaveLength(1);
  });

  it("does not publish when a status check cannot find its prior receipt", async () => {
    const fixture = await setup();
    const result = await fixture.submit({ publicationMode: "reconcile" });
    expect(result).toMatchObject({ status: "pending" });
    expect(result).not.toHaveProperty("fallbackUrl");
    expect(fixture.runGh).not.toHaveBeenCalled();
    expect(await fixture.receipt()).toBeNull();
  });

  it.each(["attempt", "authority"] as const)(
    "withholds browser handoff when %s retires during receipt persistence",
    async (change) => {
      const fixture = await setup();
      let current = true;
      const finalizeReceipt = vi
        .fn(finalizeUpdateFailureReportReceipt)
        .mockImplementationOnce(async () => {
          current = false;
          return false;
        });
      const result = await fixture
        .submit({
          publicationMode: "browser",
          finalizeReceipt,
          hasCurrentAuthority: () => change !== "authority" || current,
          validateCurrentAttempt: () => change !== "attempt" || current,
        })
        .catch((error: unknown) => error);
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
    },
  );

  it("permits saved-only finalization from prepared without widening created or stale ownership", async () => {
    const { prepared, stateDir, receipt } = await setup();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    await reserveUpdateFailureReportReceipt(
      prepared.attemptId,
      "owner",
      prepared.previewDigest,
      env,
    );
    expect(
      await markUpdateFailureReportReceiptPrepared(
        prepared.attemptId,
        "owner",
        prepared.previewDigest,
        env,
      ),
    ).toBe(true);
    const retryable = {
      status: "retryable" as const,
      reservationId: "owner",
      previewDigest: prepared.previewDigest,
    };
    expect(
      await finalizeUpdateFailureReportReceipt(
        prepared.attemptId,
        { ...retryable, status: "created", url: issueUrl },
        env,
      ),
    ).toBe(false);
    expect(
      await finalizeUpdateFailureReportReceipt(
        prepared.attemptId,
        { ...retryable, reservationId: "stale-owner" },
        env,
      ),
    ).toBe(false);
    expect(
      await finalizeUpdateFailureReportReceipt(
        prepared.attemptId,
        { ...retryable, previewDigest: "f".repeat(64) },
        env,
      ),
    ).toBe(false);
    expect(await receipt()).toMatchObject({ status: "prepared", reservationId: "owner" });
    expect(await finalizeUpdateFailureReportReceipt(prepared.attemptId, retryable, env)).toBe(true);
    expect(await receipt()).toMatchObject(retryable);
  });

  it.each(["host", "browser"] as const)(
    "binds saved-only Unicode reports to the exact shared body and distinct update attempts via %s",
    async (publicationMode) => {
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
      const otherAttempt = await prepareUpdateFailureReport(
        { ...input, attemptId: "long-report-B" },
        { stateDir },
      );
      expect(otherAttempt.marker).not.toBe(prepared.marker);
      expect(prepared.browserFallback.status).toBe("unavailable");
      expect(prepared.url).toBeUndefined();
      expect(prepared.previewDigest).toBe(createHash("sha256").update(prepared.body).digest("hex"));
      expect(Buffer.byteLength(prepared.body)).toBeLessThanOrEqual(16_000);
      expect(prepared.body).not.toContain("�");
      expect(prepared.body).not.toContain("private");
      const runGh = vi
        .fn<RunGithubCli>()
        .mockResolvedValue({ started: true, status: 1, stdout: Buffer.alloc(0) });
      const result = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
        createIssue: (issue, hooks) => submitGithubIssue(issue, runGh, hooks),
        publicationMode,
        stateDir,
      });
      expect(result).toMatchObject({ status: "retryable" });
      expect(result).not.toHaveProperty("fallbackUrl");
      expect(runGh).toHaveBeenCalledTimes(publicationMode === "host" ? 1 : 0);
      expect(await fs.readFile(result.savedReportPath, "utf8")).toBe(prepared.body);
    },
  );

  it.each([false, true])(
    "does not start POST with retired authority after pending, retire=%s",
    async (retire) => {
      const fixture = await setup();
      let current = true;
      const authorityAtPost: boolean[] = [];
      const result = await fixture
        .submit({
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
          createIssue: (issue, hooks) =>
            submitGithubIssue(
              issue,
              (args, options) => {
                if (args[0] === "api") {
                  authorityAtPost.push(current);
                }
                return fixture.runGh(args, options);
              },
              hooks,
            ),
        })
        .catch((error: unknown) => error);
      expect.soft(authorityAtPost).not.toContain(false);
      if (authorityAtPost.length === 0) {
        expect(retire).toBe(true);
        expect(result).toBeInstanceOf(Error);
        expect(await fixture.receipt()).toBeNull();
        await expect(fs.stat(`${fixture.stateDir}/update-reports`)).rejects.toMatchObject({
          code: "ENOENT",
        });
      } else {
        expect(authorityAtPost).toHaveLength(1);
        expect(result).toMatchObject({ status: "created", url: issueUrl });
        expect(await fixture.submit()).toMatchObject({ status: "duplicate", url: issueUrl });
        expect(fixture.createCalls).toHaveLength(1);
      }
    },
  );

  it("rejects retired authority after async preparation returns", async () => {
    const fixture = await setup();
    let current = true;
    const result = await fixture
      .submit({
        hasCurrentAuthority: () => current,
        createIssue: (issue, hooks) =>
          submitGithubIssue(issue, fixture.runGh, {
            ...hooks,
            beforeIssueCreate: async () => {
              if (!hooks.beforeIssueCreate) {
                throw new Error("expected a guarded Report submission");
              }
              const commit = await hooks.beforeIssueCreate();
              queueMicrotask(() => {
                current = false;
              });
              return commit;
            },
          }),
      })
      .catch((error: unknown) => error);
    expect.soft(result).toBeInstanceOf(Error);
    expect.soft(fixture.createCalls).toHaveLength(0);
    expect.soft(await fixture.receipt()).toBeNull();
    await expect(fs.stat(`${fixture.stateDir}/update-reports`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each(["authority", "attempt"] as const)(
    "refuses %s lost while authentication is paused before pending or POST",
    async (change) => {
      const fixture = await setup();
      const entered = createDeferredCore();
      const released = createDeferredCore();
      fixture.runGh.mockImplementationOnce(async () => {
        entered.resolve();
        await released.promise;
        return authSuccess;
      });
      let current = true;
      const submission = fixture.submit({
        hasCurrentAuthority: () => change !== "authority" || current,
        validateCurrentAttempt: () => change !== "attempt" || current,
      });
      // Observe rejection immediately, before releasing the asynchronous guard.
      const observed = submission.then(
        (value) => value,
        (error: unknown) => error,
      );
      await entered.promise;
      current = false;
      released.resolve();
      const result = await observed;
      if (change === "authority") {
        expect(result).toBeInstanceOf(Error);
      } else {
        expect(result).toMatchObject({ status: "stale" });
      }
      expect(fixture.runGh).toHaveBeenCalledOnce();
      expect(fixture.createCalls).toHaveLength(0);
      expect(await fixture.receipt()).toBeNull();
      await expect(fs.stat(`${fixture.stateDir}/update-reports`)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("checks retired authority at the pending commit after attempt validation", async () => {
    const fixture = await setup();
    let current = true;
    let insidePreCreate = false;
    let retireAfterValidation = false;
    const result = await fixture
      .submit({
        createIssue: (issue, hooks) =>
          submitGithubIssue(issue, fixture.runGh, {
            ...hooks,
            beforeIssueCreate: () => {
              insidePreCreate = true;
              if (!hooks.beforeIssueCreate) {
                throw new Error("expected a guarded Report submission");
              }
              return hooks.beforeIssueCreate();
            },
          }),
        validateCurrentAttempt: () => {
          retireAfterValidation = insidePreCreate;
          return true;
        },
        hasCurrentAuthority: () => {
          if (retireAfterValidation) {
            retireAfterValidation = false;
            queueMicrotask(() => {
              current = false;
            });
          }
          return current;
        },
      })
      .catch((error: unknown) => error);
    expect({
      rejected: result instanceof Error,
      invocations: fixture.runGh.mock.calls.map(([args]) => args[0]),
      creates: fixture.createCalls.length,
      receipt: await fixture.receipt(),
    }).toEqual({ rejected: true, invocations: ["auth"], creates: 0, receipt: null });
    await expect(fs.stat(`${fixture.stateDir}/update-reports`)).rejects.toMatchObject({
      code: "ENOENT",
    });
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
    const entered = createDeferredCore();
    const released = createDeferredCore();
    fixture.runGh.mockImplementationOnce(async () => {
      entered.resolve();
      await released.promise;
      return authSuccess;
    });
    const oldSubmission = fixture.submit();
    try {
      await entered.promise;
      expireUpdateFailureReportReceipt(fixture.prepared.attemptId, fixture.stateDir);
      const successor = await fixture.submit();
      expect(successor).toMatchObject({ status: "created", url: issueUrl });
      released.resolve();
      expect(await oldSubmission).toMatchObject({ status: "duplicate", url: issueUrl });
      expect(fixture.createCalls).toHaveLength(1);
      expect(fixture.runGh).toHaveBeenCalledTimes(3);
    } finally {
      released.resolve();
      await oldSubmission;
    }
  });
});
