import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import { useStateDatabaseTempDirs } from "../test-utils/state-database-temp-dirs.js";
import type { GithubIssueSubmitHooks, PreparedGithubIssue } from "./github-issue.js";
import {
  beginStaleUpdateFailureReportReceiptCleanup,
  completeUpdateFailureReportReceiptCleanup,
  readUpdateFailureReportReceipt,
  reserveUpdateFailureReportReceipt,
} from "./restart-sentinel.js";
import { prepareUpdateFailureReport } from "./update-failure-report.js";
import {
  createUpdateFailureReportFixture,
  expectMissing,
  submitUpdateFailureReportFixture as submitUpdateFailureReport,
  expireUpdateFailureReportReceipt,
  savedReportArtifactPath,
  mockCreatedIssue,
  mockFallbackIssue,
  mockFallbackAfterIssueCreateNoStart,
} from "./update-failure-report.test-support.js";
import type { UpdateRunResult } from "./update-runner-types.js";

const tempDirs = useStateDatabaseTempDirs();
const issueUrl = (id = 123) => `https://github.com/openclaw/openclaw/issues/${id}`;

type PreparedReport = Awaited<ReturnType<typeof prepareUpdateFailureReport>>;

async function currentSavedReportArtifactPath(
  prepared: PreparedReport,
  stateDir: string,
): Promise<string> {
  const receipt = await readUpdateFailureReportReceipt(prepared.attemptId, {
    OPENCLAW_STATE_DIR: stateDir,
  });
  if (!receipt) {
    throw new Error("expected an authoritative update report receipt");
  }
  return savedReportArtifactPath(
    prepared,
    receipt.reservationId,
    receipt.previewDigest ?? prepared.previewDigest,
  );
}

async function listSavedReportArtifacts(prepared: PreparedReport): Promise<string[]> {
  const parsed = path.parse(prepared.savedReportPath);
  const entries = await fs.readdir(parsed.dir).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  });
  return entries
    .filter((entry) => entry.startsWith(`${parsed.name}.`) && entry.endsWith(parsed.ext))
    .map((entry) => path.join(parsed.dir, entry));
}

function failedUpdate(overrides: Partial<UpdateRunResult> = {}): UpdateRunResult {
  return {
    status: "error",
    mode: "git",
    reason: "build-failed",
    steps: [],
    durationMs: 20,
    recovery: { serviceRestartSafe: true, version: "2026.8.1" },
    ...overrides,
  };
}

async function prepareFailedReport(attemptId: string) {
  const stateDir = tempDirs.make("openclaw-update-report-");
  const prepared = await prepareUpdateFailureReport(
    { attemptId, result: failedUpdate() },
    { stateDir },
  );
  return createUpdateFailureReportFixture(prepared, stateDir);
}

function pausedValidation() {
  const gate = createDeferred<boolean>();
  const entered = createDeferred();
  const validateCurrentAttempt = vi
    .fn<() => boolean | Promise<boolean>>()
    .mockReturnValueOnce(true)
    .mockImplementationOnce(() => {
      entered.resolve();
      return gate.promise;
    });
  return { entered: entered.promise, finish: () => gate.resolve(false), validateCurrentAttempt };
}

async function expectSaved(report: { savedReportPath: string }, prepared: PreparedReport) {
  expect(await fs.readFile(report.savedReportPath, "utf8")).toBe(prepared.body);
}

function expectIssue(result: unknown, status: "created" | "duplicate", id = 123) {
  expect(result).toMatchObject({ status, url: issueUrl(id) });
}

describe("update failure report", () => {
  it("does not substitute restored post-failure state for an unavailable update target", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-target-");
    const prepared = await prepareUpdateFailureReport(
      {
        attemptId: "attempt-restored-target",
        result: failedUpdate({
          after: { version: "2026.8.1" },
          recovery: {
            packageRollbackVerified: true,
            reason: "runtime-verification-failed",
            serviceRestartSafe: false,
          },
        }),
      },
      { stateDir },
    );

    expect(prepared.body).toContain("Update target: exact target unavailable; mode: git");
    expect(prepared.body).not.toContain("Update target: version 2026.8.1");
    expect(prepared.body).toContain(
      "Recovery outcome: package rollback verified; service restart not verified (runtime-verification-failed)",
    );
  });

  it("returns the fallback when issue creation cannot start after auth preflight", async () => {
    const { prepared, receipt, submit } = await prepareFailedReport("post-auth-no-start");
    const createIssue = mockFallbackAfterIssueCreateNoStart(prepared.url);
    await expectMissing(prepared.savedReportPath);
    const first = await submit({ createIssue });
    const second = await submit({ createIssue });

    expect(first).toMatchObject({ fallbackUrl: prepared.url, status: "fallback" });
    expect(second).toMatchObject({ fallbackUrl: prepared.url, status: "duplicate" });
    expect(createIssue).toHaveBeenCalledOnce();
    expect(await receipt()).toMatchObject({
      fallbackUrl: prepared.url,
      status: "fallback",
    });
    await expectSaved(first, prepared);
    if (process.platform !== "win32") {
      expect((await fs.stat(path.dirname(first.savedReportPath))).mode & 0o777).toBe(0o700);
      expect((await fs.stat(first.savedReportPath)).mode & 0o777).toBe(0o600);
    }
  });

  it("releases the reservation when the post-preflight attempt refresh throws", async () => {
    const { prepared, submit } = await prepareFailedReport("attempt-auth-preflight-refresh-error");
    let issueCreateCalls = 0;
    const validateCurrentAttempt = vi
      .fn<() => boolean>()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockImplementationOnce(() => {
        throw new Error("restart sentinel refresh unavailable");
      });
    const createIssue = mockCreatedIssue(issueUrl(), {
      onCreate: () => issueCreateCalls++,
    });

    await expect(
      submit({
        createIssue,
        validateCurrentAttempt,
      }),
    ).rejects.toThrow("could not be rechecked");
    expect(issueCreateCalls).toBe(0);
    await expect(listSavedReportArtifacts(prepared)).resolves.toEqual([]);

    const retryCreateIssue = mockCreatedIssue(issueUrl(124), {
      onCreate: () => issueCreateCalls++,
    });
    await expect(
      submit({ createIssue: retryCreateIssue, validateCurrentAttempt: () => true }),
    ).resolves.toMatchObject({ status: "created" });
    expect(issueCreateCalls).toBe(1);
  });

  it("rejects an attempt retired between preflight and creation, then permits retry", async () => {
    const { prepared, submit } = await prepareFailedReport("retired-after-preflight");
    let current = true;
    const onCreate = vi.fn();
    const createIssue = mockCreatedIssue(issueUrl(), {
      afterAuth: () => {
        current = false;
      },
      onCreate,
    });
    await expect(
      submit({ createIssue, validateCurrentAttempt: () => current }),
    ).resolves.toMatchObject({ status: "stale" });
    expect(onCreate).not.toHaveBeenCalled();
    await expect(listSavedReportArtifacts(prepared)).resolves.toEqual([]);
    current = true;
    await expect(
      submit({ createIssue: mockCreatedIssue(issueUrl()), validateCurrentAttempt: () => current }),
    ).resolves.toMatchObject({ status: "created" });
  });

  it("does not let a pending-reservation loser delete the winner's fallback report", async ({
    signal,
  }) => {
    const { prepared, stateDir, submit } = await prepareFailedReport("pending-fallback-race");
    const fallbackUrl = prepared.url;
    if (!fallbackUrl) {
      throw new Error("expected an available browser handoff");
    }
    const validationGate = createDeferred<boolean>();
    const fallbackEntered = createDeferred();
    const fallbackGate = createDeferred();
    const delayedCreateIssue = vi.fn();
    const delayed = submit({
      createIssue: delayedCreateIssue,
      validateCurrentAttempt: () => validationGate.promise,
    });
    const createIssue = vi.fn(
      async (_issue: PreparedGithubIssue, hooks: GithubIssueSubmitHooks) => {
        await hooks.afterAuthPreflight?.();
        fallbackEntered.resolve();
        await fallbackGate.promise;
        return {
          url: fallbackUrl,
          reason: "cli-unavailable" as const,
          status: "browser-fallback" as const,
        };
      },
    );
    const winner = submit({ createIssue });
    try {
      await withinTest(
        awaitGateBeforeSettlement(
          fallbackEntered.promise,
          winner,
          "Winner did not reach fallback transport",
        ),
        signal,
      );
      expect(createIssue).toHaveBeenCalledOnce();
      const winnerReportPath = await currentSavedReportArtifactPath(prepared, stateDir);
      expect(await fs.readFile(winnerReportPath, "utf8")).toBe(prepared.body);

      validationGate.resolve(true);
      const delayedResult = await withinTest(delayed, signal);
      expect(delayedResult).toMatchObject({ status: "retryable" });
      expect(delayedResult).not.toHaveProperty("fallbackUrl");
      expect(delayedCreateIssue).not.toHaveBeenCalled();
      fallbackGate.resolve();
      const winnerResult = await withinTest(winner, signal);
      expect(winnerResult).toMatchObject({ status: "fallback", fallbackUrl });
      expect(winnerResult.savedReportPath).toBe(winnerReportPath);
      expect(await fs.readFile(winnerReportPath, "utf8")).toBe(prepared.body);
    } finally {
      validationGate.resolve(true);
      fallbackGate.resolve();
      await Promise.allSettled([delayed, winner]);
    }
  });

  it.each([false, true])(
    "preserves a replacement fallback after expired validation (new preview: %s)",
    async (changed) => {
      const { prepared, stateDir, submit } = await prepareFailedReport("expired-validation");
      const next = changed
        ? await prepareUpdateFailureReport(
            { attemptId: prepared.attemptId, result: failedUpdate({ reason: "install-failed" }) },
            { stateDir },
          )
        : prepared;
      if (changed) {
        expect(next.body).not.toBe(prepared.body);
      }
      const validation = pausedValidation();
      const oldCreateIssue = vi.fn();
      const oldSubmission = submit({
        createIssue: oldCreateIssue,
        validateCurrentAttempt: validation.validateCurrentAttempt,
      });
      try {
        await validation.entered;
        const oldReportPath = await currentSavedReportArtifactPath(prepared, stateDir);
        expect(await fs.readFile(`${oldReportPath}.pending`, "utf8")).toBe(prepared.body);

        expireUpdateFailureReportReceipt(prepared.attemptId, stateDir);
        const replacement = await submitUpdateFailureReport(next, next.previewDigest, {
          createIssue: mockFallbackIssue(next.url),
          stateDir,
        });
        validation.finish();
        const oldResult = await oldSubmission;

        expect(replacement).toMatchObject({ fallbackUrl: next.url, status: "fallback" });
        if (changed) {
          expect(oldResult).toMatchObject({
            status: "duplicate",
            message: expect.stringContaining("different reviewed preview"),
          });
          expect(oldResult).not.toHaveProperty("fallbackUrl");
        } else {
          expect(oldResult).toMatchObject({ fallbackUrl: prepared.url, status: "duplicate" });
        }
        expect(oldCreateIssue).not.toHaveBeenCalled();
        expect(replacement.savedReportPath).not.toBe(oldReportPath);
        await expectSaved(replacement, next);
        await expectMissing(`${oldReportPath}.pending`);
      } finally {
        validation.finish();
        await oldSubmission;
      }
    },
  );

  it("does not let a delayed cleanup worker delete a successor report artifact", async () => {
    const { prepared, stateDir, submit } = await prepareFailedReport("delayed-cleanup");
    const validation = pausedValidation();
    const oldCreateIssue = vi.fn();
    const { promise: firstCleanupGate, resolve: releaseFirstCleanup } = createDeferred();
    const { promise: firstCleanupStart, resolve: firstCleanupStarted } = createDeferred();
    const oldSubmission = submit({
      createIssue: oldCreateIssue,
      validateCurrentAttempt: validation.validateCurrentAttempt,
    });
    try {
      await validation.entered;
      const oldReportPath = await currentSavedReportArtifactPath(prepared, stateDir);
      expect(await fs.readFile(`${oldReportPath}.pending`, "utf8")).toBe(prepared.body);

      const realRm = fs.rm.bind(fs);
      let blockedFirstCleanup = false;
      const rm = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
        if (String(target) === oldReportPath && !blockedFirstCleanup) {
          blockedFirstCleanup = true;
          firstCleanupStarted();
          await firstCleanupGate;
        }
        return await realRm(target, options);
      });

      validation.finish();
      await firstCleanupStart;
      let replacement: Awaited<ReturnType<typeof submitUpdateFailureReport>>;
      let oldResult: Awaited<ReturnType<typeof submitUpdateFailureReport>>;
      try {
        replacement = await submit({ createIssue: mockFallbackIssue(prepared.url) });
        expect(replacement).toMatchObject({ fallbackUrl: prepared.url, status: "fallback" });
        expect(replacement.savedReportPath).not.toBe(oldReportPath);
        await expectSaved(replacement, prepared);
        releaseFirstCleanup();
        oldResult = await oldSubmission;
      } finally {
        releaseFirstCleanup();
        rm.mockRestore();
      }

      expect(oldResult).toMatchObject({ fallbackUrl: prepared.url, status: "duplicate" });
      expect(oldCreateIssue).not.toHaveBeenCalled();
      await expectSaved(replacement, prepared);
      await expectMissing(oldReportPath);
      await expectMissing(`${oldReportPath}.pending`);
    } finally {
      validation.finish();
      releaseFirstCleanup();
      await Promise.allSettled([oldSubmission]);
    }
  });

  it("fences an expired staged writer and recovers its interrupted cleanup", async () => {
    const { prepared, receipt, stateDir, submit } = await prepareFailedReport("expired-write");
    const { promise: oldWriteGate, resolve: releaseOldWrite } = createDeferred();
    const { promise: oldWriteStartedGate, resolve: oldWriteStarted } = createDeferred();
    let delayFirstStagedWrite = true;
    const writeFile = fs.writeFile;
    const writeSpy = vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      if (delayFirstStagedWrite && typeof args[0] === "string" && args[0].endsWith(".pending")) {
        delayFirstStagedWrite = false;
        oldWriteStarted();
        await oldWriteGate;
      }
      return writeFile(...args);
    });
    const oldCreateIssue = mockCreatedIssue(issueUrl(122));

    const oldSubmission = submit({ createIssue: oldCreateIssue });
    try {
      await oldWriteStartedGate;
      const oldReportPath = await currentSavedReportArtifactPath(prepared, stateDir);
      const oldStagedReportPath = `${oldReportPath}.pending`;
      expect(await receipt()).toMatchObject({ status: "preparing" });

      expireUpdateFailureReportReceipt(prepared.attemptId, stateDir);
      const replacement = await submit({ createIssue: mockCreatedIssue(issueUrl()) });
      await fs.mkdir(path.dirname(oldReportPath), { mode: 0o700, recursive: true });
      const rm = fs.rm;
      const rmSpy = vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
        if (typeof args[0] === "string" && args[0] === oldStagedReportPath) {
          throw new Error("simulated late-owner cleanup interruption");
        }
        return rm(...args);
      });
      releaseOldWrite();
      const oldResult = await oldSubmission.finally(() => {
        rmSpy.mockRestore();
        writeSpy.mockRestore();
      });

      expectIssue(replacement, "created");
      expectIssue(oldResult, "duplicate");
      expect(oldCreateIssue).not.toHaveBeenCalled();
      expect(await receipt()).toMatchObject({
        artifactSweep: "pending",
        status: "created",
      });
      await expectMissing(oldReportPath);
      expect(await fs.readFile(oldStagedReportPath, "utf8")).toBe(prepared.body);

      const reconnectCreateIssue = mockCreatedIssue(issueUrl(124));
      const reconnected = await submit({ createIssue: reconnectCreateIssue });

      expectIssue(reconnected, "duplicate");
      expect(reconnectCreateIssue).not.toHaveBeenCalled();
      await expectMissing(oldReportPath);
      await expectMissing(oldStagedReportPath);
      await expect(listSavedReportArtifacts(prepared)).resolves.toEqual([]);
    } finally {
      releaseOldWrite();
      await Promise.allSettled([oldSubmission]);
      writeSpy.mockRestore();
    }
  });

  it.for(["enumeration", "receipt"] as const)(
    "preserves a successor while cleanup's %s is delayed",
    async (checkpoint, { signal }) => {
      const { env, prepared, stateDir, submit } =
        await prepareFailedReport("attempt-delayed-cleanup");
      const reservationId = "retired-reservation";
      expect(
        await reserveUpdateFailureReportReceipt(
          prepared.attemptId,
          reservationId,
          prepared.previewDigest,
          env,
        ),
      ).toMatchObject({ reserved: true });
      const retiredPath = savedReportArtifactPath(prepared, reservationId);
      const retiredArtifact = checkpoint === "enumeration" ? retiredPath + ".pending" : retiredPath;
      if (checkpoint === "enumeration") {
        await fs.mkdir(path.dirname(retiredPath), { mode: 0o700, recursive: true });
        await fs.writeFile(retiredArtifact, prepared.body, { mode: 0o600 });
      }
      expireUpdateFailureReportReceipt(prepared.attemptId, stateDir);
      expect(
        await beginStaleUpdateFailureReportReceiptCleanup(prepared.attemptId, reservationId, env),
      ).toBe(true);
      expect(
        await completeUpdateFailureReportReceiptCleanup(prepared.attemptId, reservationId, env),
      ).toBe(true);
      if (checkpoint === "receipt") {
        await fs.mkdir(path.dirname(retiredPath), { recursive: true });
        await fs.writeFile(retiredPath, prepared.body);
      }

      const entered = createDeferred();
      const release = createDeferred();
      let capturedEntries: unknown;
      const readdir = fs.readdir;
      const execute = stateReads.executeExistingOpenClawStateRead;
      let reads = 0;
      const held =
        checkpoint === "enumeration"
          ? vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
              if (String(args[0]) === path.dirname(retiredPath) && reads++ === 0) {
                entered.resolve();
                await release.promise;
                const entries = await readdir(...args);
                capturedEntries = entries;
                return entries;
              }
              return readdir(...args);
            })
          : vi
              .spyOn(stateReads, "executeExistingOpenClawStateRead")
              .mockImplementation(async (...args) => {
                const reply = await execute(...args);
                if (
                  reply?.ok &&
                  reply.type === "restartSentinel.reportReceipt" &&
                  reply.receipt?.reservationId === reservationId &&
                  reply.receipt.replacementReady &&
                  ++reads === 2
                ) {
                  entered.resolve();
                  await release.promise;
                }
                return reply;
              });
      const staleCreateIssue = vi.fn();
      const staleSubmission = submit({ createIssue: staleCreateIssue });
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            entered.promise,
            staleSubmission,
            "Cleanup did not reach " + checkpoint,
          ),
          signal,
        );
        const successor = await withinTest(submit({ publicationMode: "browser" }), signal);
        expect(successor).toMatchObject({ status: "fallback", fallbackUrl: prepared.url });
        expect(successor.savedReportPath).not.toBe(retiredPath);
        expect(await fs.readFile(successor.savedReportPath, "utf8")).toBe(prepared.body);
        release.resolve();
        const staleResult = await withinTest(staleSubmission, signal);
        if (checkpoint === "enumeration") {
          expect(capturedEntries).toContain(path.basename(successor.savedReportPath));
        }
        expect(staleResult).toMatchObject({ status: "duplicate", fallbackUrl: prepared.url });
        expect(staleCreateIssue).not.toHaveBeenCalled();
        expect(await fs.readFile(successor.savedReportPath, "utf8")).toBe(prepared.body);
        await expectMissing(retiredArtifact);
      } finally {
        release.resolve();
        await Promise.allSettled([staleSubmission]);
        held.mockRestore();
      }
    },
  );

  it("does not publish a fallback after its preparation lease is replaced", async ({ signal }) => {
    const { prepared, stateDir, submit } = await prepareFailedReport("expired-fallback");
    const fallbackEntered = createDeferred();
    const { promise: oldFallbackGate, resolve: releaseOldFallback } = createDeferred();
    const oldFallback = vi.fn(
      async (_issue: PreparedGithubIssue, hooks: GithubIssueSubmitHooks) => {
        await hooks.afterAuthPreflight?.();
        fallbackEntered.resolve();
        await oldFallbackGate;
        return {
          url: prepared.url!,
          reason: "cli-unavailable" as const,
          status: "browser-fallback" as const,
        };
      },
    );
    const oldSubmission = submit({ createIssue: oldFallback });
    const submissions = [oldSubmission];
    try {
      await withinTest(
        awaitGateBeforeSettlement(
          fallbackEntered.promise,
          oldSubmission,
          "Old owner did not reach fallback transport",
        ),
        signal,
      );
      expect(oldFallback).toHaveBeenCalledOnce();
      expireUpdateFailureReportReceipt(prepared.attemptId, stateDir);
      const replacementSubmission = submit({ createIssue: mockCreatedIssue(issueUrl()) });
      submissions.push(replacementSubmission);
      const replacement = await withinTest(replacementSubmission, signal);
      releaseOldFallback();
      const oldResult = await withinTest(oldSubmission, signal);

      expectIssue(replacement, "created");
      expectIssue(oldResult, "duplicate");
      expect(oldResult).not.toHaveProperty("fallbackUrl");
      await expectMissing(`${prepared.savedReportPath}.result.json`);
    } finally {
      releaseOldFallback();
      await Promise.allSettled(submissions);
    }
  });
});
