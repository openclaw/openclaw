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
import { VERSION } from "../version.js";
import type { GithubIssueSubmitHooks, PreparedGithubIssue } from "./github-issue.js";
import {
  beginStaleUpdateFailureReportReceiptCleanup,
  completeUpdateFailureReportReceiptCleanup,
  finalizeUpdateFailureReportReceipt,
  readUpdateFailureReportReceipt,
  reserveUpdateFailureReportReceipt,
} from "./restart-sentinel.js";
import { cleanRetiredUpdateFailureReportArtifacts } from "./update-failure-report-artifact-sweep.js";
import { prepareUpdateFailureReport, submitUpdateFailureReport } from "./update-failure-report.js";
import {
  createUpdateFailureReportFixture,
  expireUpdateFailureReportReceipt,
  savedReportArtifactPath,
  mockCreatedIssue,
  mockFallbackIssue,
  mockFallbackAfterIssueCreateNoStart,
} from "./update-failure-report.test-support.js";
import type { UpdateRunResult } from "./update-runner-types.js";

const tempDirs = useStateDatabaseTempDirs();

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
    before: { sha: "a".repeat(40), version: "2026.8.1" },
    after: { sha: "b".repeat(40), version: "2026.8.2" },
    steps: [
      {
        name: "build",
        command: "pnpm build --token raw-command-secret",
        cwd: "/Users/private/openclaw",
        durationMs: 12,
        exitCode: 1,
        stdoutTail: "raw chat and log output must not be copied",
        stderrTail: "token=raw-log-secret /Users/private/openclaw/build.log",
      },
    ],
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

describe("update failure report", () => {
  it("excludes a later advisory step when selecting the failed phase", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-advisory-");
    const prepared = await prepareUpdateFailureReport(
      {
        attemptId: "attempt-advisory-phase",
        result: failedUpdate({
          steps: [
            failedUpdate().steps[0]!,
            {
              name: "post-install doctor",
              command: "openclaw doctor",
              cwd: "/tmp/openclaw",
              durationMs: 5,
              exitCode: 86,
              advisory: {
                kind: "package-post-install-doctor",
                message: "recoverable repair warning",
              },
            },
          ],
        }),
      },
      { stateDir },
    );

    expect(prepared.title).toBe(`Update failure: build (${VERSION})`);
    expect(prepared.body).toContain("Failed phase: build");
    expect(prepared.body).not.toContain("post-install doctor");
  });

  it("saves only allowlisted, redacted, Unicode-safe report facts for fallback", async () => {
    const home = tempDirs.make("openclaw-update-report-");
    const stateDir = path.join(home, ".openclaw");
    const secret = "sk-test-update-report-secret-1234567890";
    const emoji = "🦞".repeat(2_000);
    const prepared = await prepareUpdateFailureReport(
      {
        attemptId: "attempt-redaction",
        error: `opaque raw chat payload token=${secret} ${home}/private/error.log`,
        result: failedUpdate({
          reason:
            "build-failed at /Users/Alice Smith/private/customer list.txt after checksum mismatch",
          steps: [
            {
              ...failedUpdate().steps[0]!,
              name: `Command failed: /usr/local/bin/openclaw doctor --fix ${home}/source token=${secret}`,
            },
          ],
        }),
        target: [
          `origin/main token=${secret}`,
          "windows C:\\Users\\Alice Smith\\private\\project after windows marker",
          "unc \\\\server\\Alice Smith\\private\\project after unc marker",
          "rooted \\Users\\Alice Smith\\private\\rooted-secret.txt after rooted marker",
          'quoted "/Users/Alice Smith/private project" after quoted marker',
          "openclaw.exe doctor --token openclaw-exe-secret",
          '"npm.cmd" install --token npm-cmd-secret',
          "npm.ps1 install --token npm-ps1-secret",
          '"PowerShell.EXE" -EncodedCommand powershell-exe-secret',
          '"cmd.exe" /c echo cmd-exe-secret',
          emoji,
        ].join("\n"),
      },
      { env: { HOME: home, OPENCLAW_STATE_DIR: stateDir }, stateDir },
    );
    await expect(fs.stat(prepared.savedReportPath)).rejects.toMatchObject({ code: "ENOENT" });
    const result = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue: mockFallbackIssue(
        "https://github.com/openclaw/openclaw/issues/new?title=update",
      ),
      env: { HOME: home, OPENCLAW_STATE_DIR: stateDir },
      stateDir,
    });
    expect(result).toMatchObject({ status: "fallback" });

    const saved = await fs.readFile(result.savedReportPath, "utf8");
    expect(saved).toBe(prepared.body);
    expect(Buffer.byteLength(saved, "utf8")).toBeLessThanOrEqual(16_000);
    expect(saved).toContain("Recovery outcome: verified safe to restart");
    expect(saved).toContain("Failed phase:");
    expect(saved).toContain("Update target:");
    expect(saved).toContain("🦞");
    expect(saved).toContain("[redacted-path]");
    expect(saved).not.toContain("�");
    expect(saved).not.toContain(secret);
    expect(saved).not.toContain(home);
    expect(saved).not.toContain("/var/lib/openclaw");
    expect(saved).not.toContain("/Users/alice");
    expect(saved).not.toContain("Alice Smith");
    expect(saved).not.toContain("rooted-secret");
    expect(saved).not.toContain("openclaw-exe-secret");
    expect(saved).not.toContain("npm-cmd-secret");
    expect(saved).not.toContain("npm-ps1-secret");
    expect(saved).not.toContain("powershell-exe-secret");
    expect(saved).not.toContain("cmd-exe-secret");
    expect(saved).not.toContain("customer list.txt");
    expect(saved).not.toContain("after checksum mismatch");
    expect(saved).not.toContain("https://example.com/?next=/docs");
    expect(saved).not.toContain("opaque raw chat payload");
    expect(saved).not.toContain("raw-command-secret");
    expect(saved).not.toContain("raw-log-secret");
    expect(saved).not.toContain("raw chat and log output");
    expect(saved).not.toContain("openclaw doctor --fix");
    expect(saved).not.toContain("C:\\Users\\private");
    expect(saved).not.toContain("\\\\server\\private");
    if (process.platform !== "win32") {
      expect((await fs.stat(path.dirname(result.savedReportPath))).mode & 0o777).toBe(0o700);
      expect((await fs.stat(result.savedReportPath)).mode & 0o777).toBe(0o600);
    }
  });

  it("reports a verified package rollback separately from restart safety", async () => {
    const home = tempDirs.make("openclaw-update-report-package-rollback-");
    const prepared = await prepareUpdateFailureReport(
      {
        attemptId: "attempt-package-rollback",
        result: failedUpdate({
          recovery: {
            packageRollbackVerified: true,
            reason: "runtime-verification-failed",
            serviceRestartSafe: false,
          },
        }),
      },
      { stateDir: path.join(home, ".openclaw") },
    );

    expect(prepared.body).toContain(
      "Recovery outcome: package rollback verified; service restart not verified (runtime-verification-failed)",
    );
  });

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
  });

  it("submits once and rejects a duplicate click for the same attempt", async () => {
    const { submit } = await prepareFailedReport("attempt-once");
    const createIssue = mockCreatedIssue("https://github.com/openclaw/openclaw/issues/123");

    const [first, second] = await Promise.all([submit({ createIssue }), submit({ createIssue })]);
    const third = await submit({
      createIssue,
      validateCurrentAttempt: () => false,
    });

    expect(createIssue).toHaveBeenCalledOnce();
    expect([first.status, second.status].toSorted()).toEqual(["created", "retryable"]);
    expect(third).toMatchObject({
      status: "duplicate",
      url: "https://github.com/openclaw/openclaw/issues/123",
    });
    await expect(fs.stat(first.savedReportPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns the fallback when issue creation cannot start after auth preflight", async () => {
    const { prepared, receipt, submit } = await prepareFailedReport(
      "attempt-post-auth-spawn-no-start",
    );
    const createIssue = mockFallbackAfterIssueCreateNoStart(prepared.url);

    const first = await submit({ createIssue });
    const second = await submit({ createIssue });

    expect(first).toMatchObject({ fallbackUrl: prepared.url, status: "fallback" });
    expect(second).toMatchObject({ fallbackUrl: prepared.url, status: "duplicate" });
    expect(createIssue).toHaveBeenCalledOnce();
    expect(await receipt()).toMatchObject({
      fallbackUrl: prepared.url,
      status: "fallback",
    });
  });

  it("distinguishes an active preparation from ambiguous issue creation", async () => {
    const { env, prepared, submit } = await prepareFailedReport("attempt-preparing");
    expect(
      await reserveUpdateFailureReportReceipt(
        prepared.attemptId,
        "active-owner",
        prepared.previewDigest,
        env,
      ),
    ).toMatchObject({ reserved: true });
    const createIssue = mockCreatedIssue("https://github.com/openclaw/openclaw/issues/123");

    await expect(submit({ createIssue })).resolves.toMatchObject({
      message: "This update attempt already has a report preparation in progress.",
      status: "retryable",
    });
    expect(createIssue).not.toHaveBeenCalled();
  });

  it.each([
    { condition: "authority closes", attemptId: "attempt-auth-preflight-authority" },
    { condition: "the canonical attempt changes", attemptId: "attempt-auth-preflight-stale" },
  ])(
    "cancels preparation when $condition immediately before issue creation",
    async ({ condition, attemptId }) => {
      const { prepared, submit } = await prepareFailedReport(attemptId);
      let current = true;
      let issueCreateCalls = 0;
      const guards =
        condition === "authority closes"
          ? { hasCurrentAuthority: () => current, validateCurrentAttempt: () => true }
          : { validateCurrentAttempt: () => current };
      const createIssue = vi.fn(
        async (_issue: PreparedGithubIssue, hooks: GithubIssueSubmitHooks) => {
          await hooks.afterAuthPreflight?.();
          current = false;
          (await hooks.beforeIssueCreate?.())?.();
          issueCreateCalls += 1;
          return {
            status: "created" as const,
            url: "https://github.com/openclaw/openclaw/issues/123",
          };
        },
      );

      const submission = submit({ createIssue, ...guards });
      if (condition === "authority closes") {
        await expect(submission).rejects.toThrow("current authenticated client");
      } else {
        await expect(submission).resolves.toMatchObject({ status: "stale" });
      }
      expect(issueCreateCalls).toBe(0);
      await expect(listSavedReportArtifacts(prepared)).resolves.toEqual([]);

      current = true;
      const retryCreateIssue = vi.fn(
        async (_issue: PreparedGithubIssue, hooks: GithubIssueSubmitHooks) => {
          await hooks.afterAuthPreflight?.();
          (await hooks.beforeIssueCreate?.())?.();
          issueCreateCalls += 1;
          return {
            status: "created" as const,
            url: "https://github.com/openclaw/openclaw/issues/124",
          };
        },
      );
      await expect(submit({ createIssue: retryCreateIssue, ...guards })).resolves.toMatchObject({
        status: "created",
      });
      expect(issueCreateCalls).toBe(1);
    },
  );

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
    const createIssue = vi.fn(
      async (_issue: PreparedGithubIssue, hooks: GithubIssueSubmitHooks) => {
        await hooks.afterAuthPreflight?.();
        (await hooks.beforeIssueCreate?.())?.();
        issueCreateCalls += 1;
        return {
          status: "created" as const,
          url: "https://github.com/openclaw/openclaw/issues/123",
        };
      },
    );

    await expect(
      submit({
        createIssue,
        validateCurrentAttempt,
      }),
    ).rejects.toThrow("could not be rechecked");
    expect(issueCreateCalls).toBe(0);
    await expect(listSavedReportArtifacts(prepared)).resolves.toEqual([]);

    const retryCreateIssue = vi.fn(
      async (_issue: PreparedGithubIssue, hooks: GithubIssueSubmitHooks) => {
        await hooks.afterAuthPreflight?.();
        (await hooks.beforeIssueCreate?.())?.();
        issueCreateCalls += 1;
        return {
          status: "created" as const,
          url: "https://github.com/openclaw/openclaw/issues/124",
        };
      },
    );
    await expect(
      submit({
        createIssue: retryCreateIssue,
        validateCurrentAttempt: () => true,
      }),
    ).resolves.toMatchObject({ status: "created" });
    expect(issueCreateCalls).toBe(1);
  });

  it("does not let a pending-reservation loser delete the winner's fallback report", async ({
    signal,
  }) => {
    const { prepared, stateDir, submit } = await prepareFailedReport(
      "attempt-pending-fallback-race",
    );
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

  it("does not let expired validation cleanup delete a replacement fallback report", async () => {
    const { prepared, stateDir, submit } = await prepareFailedReport(
      "attempt-expired-validation-cleanup",
    );
    const { promise: validationGate, resolve: finishValidation } = createDeferred<boolean>();
    const { promise: validationStarted, resolve: markValidationStarted } = createDeferred();
    const validateCurrentAttempt = vi
      .fn<() => boolean | Promise<boolean>>()
      .mockReturnValueOnce(true)
      .mockImplementationOnce(() => {
        markValidationStarted();
        return validationGate;
      });
    const oldCreateIssue = vi.fn();
    const oldSubmission = submit({
      createIssue: oldCreateIssue,
      validateCurrentAttempt,
    });
    try {
      await validationStarted;
      expect(validateCurrentAttempt).toHaveBeenCalledTimes(2);
      const oldReportPath = await currentSavedReportArtifactPath(prepared, stateDir);
      expect(await fs.readFile(`${oldReportPath}.pending`, "utf8")).toBe(prepared.body);

      expireUpdateFailureReportReceipt(prepared.attemptId, stateDir);
      const replacement = await submit({ createIssue: mockFallbackIssue(prepared.url) });
      finishValidation(false);
      const oldResult = await oldSubmission;

      expect(replacement).toMatchObject({ fallbackUrl: prepared.url, status: "fallback" });
      expect(oldResult).toMatchObject({ fallbackUrl: prepared.url, status: "duplicate" });
      expect(oldCreateIssue).not.toHaveBeenCalled();
      expect(replacement.savedReportPath).not.toBe(oldReportPath);
      expect(await fs.readFile(replacement.savedReportPath, "utf8")).toBe(prepared.body);
      await expect(fs.stat(`${oldReportPath}.pending`)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      finishValidation(false);
      await oldSubmission;
    }
  });

  it("does not let a delayed cleanup worker delete a successor report artifact", async () => {
    const { prepared, stateDir, submit } = await prepareFailedReport(
      "attempt-delayed-cleanup-successor",
    );
    let finishValidation!: () => void;
    const validationGate = new Promise<boolean>((resolve) => {
      finishValidation = () => resolve(false);
    });
    const { promise: validationStarted, resolve: markValidationStarted } = createDeferred();
    const validateCurrentAttempt = vi
      .fn<() => boolean | Promise<boolean>>()
      .mockReturnValueOnce(true)
      .mockImplementationOnce(() => {
        markValidationStarted();
        return validationGate;
      });
    const oldCreateIssue = vi.fn();
    const oldSubmission = submit({
      createIssue: oldCreateIssue,
      validateCurrentAttempt,
    });
    await validationStarted;
    expect(validateCurrentAttempt).toHaveBeenCalledTimes(2);
    const oldReportPath = await currentSavedReportArtifactPath(prepared, stateDir);
    expect(await fs.readFile(`${oldReportPath}.pending`, "utf8")).toBe(prepared.body);

    const realRm = fs.rm.bind(fs);
    const { promise: firstCleanupGate, resolve: releaseFirstCleanup } = createDeferred();
    const { promise: firstCleanupStart, resolve: firstCleanupStarted } = createDeferred();
    let blockedFirstCleanup = false;
    const rm = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (String(target) === oldReportPath && !blockedFirstCleanup) {
        blockedFirstCleanup = true;
        firstCleanupStarted();
        await firstCleanupGate;
      }
      return await realRm(target, options);
    });

    finishValidation();
    await firstCleanupStart;
    let replacement: Awaited<ReturnType<typeof submitUpdateFailureReport>>;
    let oldResult: Awaited<ReturnType<typeof submitUpdateFailureReport>>;
    try {
      replacement = await submit({ createIssue: mockFallbackIssue(prepared.url) });
      expect(replacement).toMatchObject({ fallbackUrl: prepared.url, status: "fallback" });
      expect(replacement.savedReportPath).not.toBe(oldReportPath);
      expect(await fs.readFile(replacement.savedReportPath, "utf8")).toBe(prepared.body);
      releaseFirstCleanup();
      oldResult = await oldSubmission;
    } finally {
      releaseFirstCleanup();
      rm.mockRestore();
    }

    expect(oldResult).toMatchObject({ fallbackUrl: prepared.url, status: "duplicate" });
    expect(oldCreateIssue).not.toHaveBeenCalled();
    expect(await fs.readFile(replacement.savedReportPath, "utf8")).toBe(prepared.body);
    await expect(fs.stat(oldReportPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(`${oldReportPath}.pending`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("isolates a replacement from an expired owner's mismatched report artifact", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const attemptId = "attempt-expired-mismatched-report";
    const oldPrepared = await prepareUpdateFailureReport(
      { attemptId, result: failedUpdate() },
      { stateDir },
    );
    const replacementPrepared = await prepareUpdateFailureReport(
      { attemptId, result: failedUpdate({ reason: "install-failed" }) },
      { stateDir },
    );
    expect(replacementPrepared.body).not.toBe(oldPrepared.body);
    const { promise: validationGate, resolve: finishValidation } = createDeferred<boolean>();
    const { promise: validationStarted, resolve: markValidationStarted } = createDeferred();
    const validateCurrentAttempt = vi
      .fn<() => boolean | Promise<boolean>>()
      .mockReturnValueOnce(true)
      .mockImplementationOnce(() => {
        markValidationStarted();
        return validationGate;
      });
    const oldCreateIssue = vi.fn();
    const oldSubmission = submitUpdateFailureReport(oldPrepared, oldPrepared.previewDigest, {
      createIssue: oldCreateIssue,
      stateDir,
      validateCurrentAttempt,
    });
    try {
      await validationStarted;
      expect(validateCurrentAttempt).toHaveBeenCalledTimes(2);
      const oldReportPath = await currentSavedReportArtifactPath(oldPrepared, stateDir);
      expect(await fs.readFile(`${oldReportPath}.pending`, "utf8")).toBe(oldPrepared.body);

      expireUpdateFailureReportReceipt(oldPrepared.attemptId, stateDir);
      const replacement = await submitUpdateFailureReport(
        replacementPrepared,
        replacementPrepared.previewDigest,
        { createIssue: mockFallbackIssue(replacementPrepared.url), stateDir },
      );
      finishValidation(false);
      const oldResult = await oldSubmission;

      expect(replacement).toMatchObject({
        fallbackUrl: replacementPrepared.url,
        status: "fallback",
      });
      expect(oldResult).toMatchObject({
        message: expect.stringContaining("different reviewed preview"),
        status: "duplicate",
      });
      expect(oldResult).not.toHaveProperty("fallbackUrl");
      expect(oldCreateIssue).not.toHaveBeenCalled();
      expect(replacement.savedReportPath).not.toBe(oldReportPath);
      expect(await fs.readFile(replacement.savedReportPath, "utf8")).toBe(replacementPrepared.body);
      await expect(fs.stat(`${oldReportPath}.pending`)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      finishValidation(false);
      await oldSubmission;
    }
  });

  it("fences an expired staged writer and recovers its interrupted cleanup", async () => {
    const { prepared, receipt, stateDir, submit } = await prepareFailedReport(
      "attempt-expired-preparation",
    );
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
    const oldCreateIssue = mockCreatedIssue("https://github.com/openclaw/openclaw/issues/122");

    const oldSubmission = submit({ createIssue: oldCreateIssue });
    await oldWriteStartedGate;
    const oldReportPath = await currentSavedReportArtifactPath(prepared, stateDir);
    const oldStagedReportPath = `${oldReportPath}.pending`;
    expect(await receipt()).toMatchObject({ status: "preparing" });

    expireUpdateFailureReportReceipt(prepared.attemptId, stateDir);
    const replacement = await submit({
      createIssue: mockCreatedIssue("https://github.com/openclaw/openclaw/issues/123"),
    });
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

    expect(replacement).toMatchObject({
      status: "created",
      url: "https://github.com/openclaw/openclaw/issues/123",
    });
    expect(oldResult).toMatchObject({
      status: "duplicate",
      url: "https://github.com/openclaw/openclaw/issues/123",
    });
    expect(oldCreateIssue).not.toHaveBeenCalled();
    expect(await receipt()).toMatchObject({
      artifactSweep: "pending",
      status: "created",
    });
    await expect(fs.stat(oldReportPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(oldStagedReportPath, "utf8")).resolves.toBe(prepared.body);

    const reconnectCreateIssue = mockCreatedIssue(
      "https://github.com/openclaw/openclaw/issues/124",
    );
    const reconnected = await submit({ createIssue: reconnectCreateIssue });

    expect(reconnected).toMatchObject({
      status: "duplicate",
      url: "https://github.com/openclaw/openclaw/issues/123",
    });
    expect(reconnectCreateIssue).not.toHaveBeenCalled();
    await expect(fs.stat(oldReportPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(oldStagedReportPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(listSavedReportArtifacts(prepared)).resolves.toEqual([]);
  });

  it("fences an expired sweep holder before listing successor artifacts", async () => {
    const { env, prepared, stateDir, submit } = await prepareFailedReport(
      "attempt-expired-sweep-holder",
    );
    const expiredReservationId = "expired-sweep-reservation";
    expect(
      await reserveUpdateFailureReportReceipt(
        prepared.attemptId,
        expiredReservationId,
        prepared.previewDigest,
        env,
      ),
    ).toMatchObject({ reserved: true });
    const retiredPath = savedReportArtifactPath(prepared, expiredReservationId);
    await fs.mkdir(path.dirname(retiredPath), { mode: 0o700, recursive: true });
    await fs.writeFile(`${retiredPath}.pending`, prepared.body, { mode: 0o600 });
    expireUpdateFailureReportReceipt(prepared.attemptId, stateDir);
    expect(
      await beginStaleUpdateFailureReportReceiptCleanup(
        prepared.attemptId,
        expiredReservationId,
        env,
      ),
    ).toBe(true);
    expect(
      await completeUpdateFailureReportReceiptCleanup(
        prepared.attemptId,
        expiredReservationId,
        env,
      ),
    ).toBe(true);

    const { promise: expiredSweepGate, resolve: releaseExpiredSweep } = createDeferred();
    const { promise: expiredSweepClaimedGate, resolve: expiredSweepClaimed } = createDeferred();
    const staleListCandidates = vi.fn(async () => {
      throw new Error("an expired sweep holder must not scan after takeover");
    });
    const staleCreateIssue = vi.fn();
    const staleSubmission = submit({
      artifactSweepHooks: {
        beforeList: async () => {
          expiredSweepClaimed();
          await expiredSweepGate;
        },
        listCandidates: staleListCandidates,
      },
      createIssue: staleCreateIssue,
    });
    await expiredSweepClaimedGate;

    expireUpdateFailureReportReceipt(prepared.attemptId, stateDir);
    const { promise: successorTransportGate, resolve: releaseSuccessorTransport } =
      createDeferred();
    const { promise: successorPublishedGate, resolve: successorPublished } = createDeferred();
    let transportCount = 0;
    const successorCreateIssue = vi.fn(
      async (_issue: PreparedGithubIssue, hooks: GithubIssueSubmitHooks) => {
        successorPublished();
        await successorTransportGate;
        await hooks.afterAuthPreflight?.();
        (await hooks.beforeIssueCreate?.())?.();
        transportCount += 1;
        return {
          status: "created" as const,
          url: "https://github.com/openclaw/openclaw/issues/123",
        };
      },
    );
    const successorSubmission = submit({ createIssue: successorCreateIssue });
    await successorPublishedGate;
    const successorPath = await currentSavedReportArtifactPath(prepared, stateDir);
    expect(await fs.readFile(successorPath, "utf8")).toBe(prepared.body);
    await expect(fs.stat(`${retiredPath}.pending`)).rejects.toMatchObject({ code: "ENOENT" });

    releaseExpiredSweep();
    const staleResult = await staleSubmission;
    expect(staleResult).toMatchObject({ status: "retryable" });
    expect(staleListCandidates).not.toHaveBeenCalled();
    expect(staleCreateIssue).not.toHaveBeenCalled();
    expect(await fs.readFile(successorPath, "utf8")).toBe(prepared.body);

    releaseSuccessorTransport();
    const successorResult = await successorSubmission;
    expect(successorResult).toMatchObject({
      status: "created",
      url: "https://github.com/openclaw/openclaw/issues/123",
    });
    expect(transportCount).toBe(1);
    expect(successorCreateIssue).toHaveBeenCalledOnce();

    const reconnectCreateIssue = mockCreatedIssue(
      "https://github.com/openclaw/openclaw/issues/124",
    );
    const reconnected = await submit({ createIssue: reconnectCreateIssue });

    expect(reconnected).toMatchObject({
      status: "duplicate",
      url: "https://github.com/openclaw/openclaw/issues/123",
    });
    expect(reconnectCreateIssue).not.toHaveBeenCalled();
    await expect(listSavedReportArtifacts(prepared)).resolves.toEqual([]);
    await expect(fs.stat(`${retiredPath}.pending`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves successor artifacts when the final sweep reply arrives after foreign takeover", async () => {
    const { env, prepared, receipt, stateDir, submit } = await prepareFailedReport(
      "attempt-late-sweep-reply",
    );
    const reservationId = "retired-reservation";
    await reserveUpdateFailureReportReceipt(
      prepared.attemptId,
      reservationId,
      prepared.previewDigest,
      env,
    );
    expireUpdateFailureReportReceipt(prepared.attemptId, stateDir);
    await beginStaleUpdateFailureReportReceiptCleanup(prepared.attemptId, reservationId, env);
    await completeUpdateFailureReportReceiptCleanup(prepared.attemptId, reservationId, env);
    const retired = await receipt();
    if (!retired) {
      throw new Error("Expected retired receipt");
    }
    const retiredPath = savedReportArtifactPath(prepared, reservationId);
    await fs.mkdir(path.dirname(retiredPath), { recursive: true });
    await fs.writeFile(retiredPath, prepared.body);
    const queried = createDeferred();
    const releaseReply = createDeferred();
    const execute = stateReads.executeExistingOpenClawStateRead;
    let leaseReads = 0;
    const reader = vi
      .spyOn(stateReads, "executeExistingOpenClawStateRead")
      .mockImplementation(async (...args) => {
        const reply = await execute(...args);
        if (
          reply?.ok &&
          reply.type === "restartSentinel.reportReceipt" &&
          reply.receipt?.sweepOwnerId
        ) {
          leaseReads += 1;
          if (leaseReads === 2) {
            queried.resolve();
            await releaseReply.promise;
          }
        }
        return reply;
      });
    const sweeping = cleanRetiredUpdateFailureReportArtifacts(prepared, retired, env, false);
    let successor: Awaited<ReturnType<typeof submitUpdateFailureReport>>;
    try {
      await queried.promise;
      expireUpdateFailureReportReceipt(prepared.attemptId, stateDir);
      successor = await submit({ publicationMode: "browser" });
      expect(successor).toMatchObject({ status: "fallback" });
      expect(successor.savedReportPath).not.toBe(retiredPath);
      releaseReply.resolve();
      expect(await sweeping).toBe(false);
      expect(await fs.readFile(successor.savedReportPath, "utf8")).toBe(prepared.body);
    } finally {
      releaseReply.resolve();
      await sweeping;
      reader.mockRestore();
    }
  });

  it("does not publish a fallback after its preparation lease is replaced", async ({ signal }) => {
    const { prepared, stateDir, submit } = await prepareFailedReport(
      "attempt-expired-fallback-preparation",
    );
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
      const replacementSubmission = submit({
        createIssue: mockCreatedIssue("https://github.com/openclaw/openclaw/issues/123"),
      });
      submissions.push(replacementSubmission);
      const replacement = await withinTest(replacementSubmission, signal);
      releaseOldFallback();
      const oldResult = await withinTest(oldSubmission, signal);

      expect(replacement).toMatchObject({
        status: "created",
        url: "https://github.com/openclaw/openclaw/issues/123",
      });
      expect(oldResult).toMatchObject({
        status: "duplicate",
        url: "https://github.com/openclaw/openclaw/issues/123",
      });
      expect(oldResult).not.toHaveProperty("fallbackUrl");
      await expect(fs.stat(`${prepared.savedReportPath}.result.json`)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      releaseOldFallback();
      await Promise.allSettled(submissions);
    }
  });

  it.each([
    ["returns false", () => false],
    [
      "throws",
      () => {
        throw new Error("receipt database unavailable");
      },
    ],
  ])(
    "returns a created URL without replaying unknown finalization when it %s",
    async (failure, fail) => {
      const { submit } = await prepareFailedReport("attempt-created-finalize-failure");
      const issueUrl = "https://github.com/openclaw/openclaw/issues/123";
      const createIssue = mockCreatedIssue(issueUrl);
      const finalizeReceipt = vi
        .fn(finalizeUpdateFailureReportReceipt)
        .mockImplementationOnce(async () => fail());

      const first = await submit({
        createIssue,
        finalizeReceipt,
      });
      const second = await submit({ createIssue });

      expect(first).toMatchObject({ status: "created", url: issueUrl });
      expect(createIssue).toHaveBeenCalledOnce();
      if (failure === "throws") {
        expect(second).toMatchObject({ status: "pending" });
        expect(finalizeReceipt).toHaveBeenCalledOnce();
        expect(await fs.readFile(first.savedReportPath, "utf8")).not.toBe("");
      } else {
        expect(second).toMatchObject({ status: "duplicate", url: issueUrl });
        expect(finalizeReceipt).toHaveBeenCalledTimes(2);
        await expect(fs.stat(first.savedReportPath)).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
  );

  it("does not hide a created result when saved-report cleanup fails", async () => {
    const { prepared, submit } = await prepareFailedReport("attempt-created-cleanup-failure");
    const issueUrl = "https://github.com/openclaw/openclaw/issues/123";
    const createIssue = mockCreatedIssue(issueUrl);
    const realRm = fs.rm.bind(fs);
    const rm = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (
        path.dirname(String(target)) === path.dirname(prepared.savedReportPath) &&
        path.basename(String(target)).startsWith(`${path.parse(prepared.savedReportPath).name}.`)
      ) {
        throw new Error("simulated saved-report cleanup failure");
      }
      return await realRm(target, options);
    });
    let first: Awaited<ReturnType<typeof submitUpdateFailureReport>>;
    try {
      first = await submit({ createIssue });
    } finally {
      rm.mockRestore();
    }

    expect(first).toMatchObject({ status: "created", url: issueUrl });
    expect(await fs.readFile(first.savedReportPath, "utf8")).toBe(prepared.body);
    const second = await submit({ createIssue });
    expect(second).toMatchObject({ status: "duplicate", url: issueUrl });
    expect(createIssue).toHaveBeenCalledOnce();
    await expect(fs.stat(first.savedReportPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
