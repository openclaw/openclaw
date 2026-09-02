import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { GithubIssueCreateAsyncHooks, SanitizedGithubIssue } from "./github-issue.js";
import {
  finalizeUpdateFailureReportReceipt,
  readUpdateFailureReportReceipt,
  reserveUpdateFailureReportReceipt,
} from "./restart-sentinel.js";
import { prepareUpdateFailureReport, submitUpdateFailureReport } from "./update-failure-report.js";
import type { UpdateRunResult } from "./update-runner.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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

function mockCreatedIssue(url: string) {
  return vi.fn(async (_issue: SanitizedGithubIssue, hooks: GithubIssueCreateAsyncHooks) => {
    await hooks.afterAuthPreflight?.();
    await hooks.beforeIssueCreate?.();
    return { ok: true as const, url };
  });
}

function mockFallbackIssue(fallbackUrl: string, message = "GitHub CLI unavailable") {
  return vi.fn(async (_issue: SanitizedGithubIssue, hooks: GithubIssueCreateAsyncHooks) => {
    await hooks.afterAuthPreflight?.();
    return { fallbackUrl, issueCreateStarted: false as const, message, ok: false as const };
  });
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

    expect(prepared.title).toBe("Update failure: build (2026.8.1)");
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
          'quoted "/Users/Alice Smith/private project" after quoted marker',
          emoji,
        ].join("\n"),
      },
      { env: { HOME: home, OPENCLAW_STATE_DIR: stateDir }, stateDir },
    );
    await expect(fs.stat(prepared.savedReportPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      submitUpdateFailureReport(prepared, prepared.previewDigest, {
        createIssue: mockFallbackIssue(
          "https://github.com/openclaw/openclaw/issues/new?title=update",
        ),
        env: { HOME: home, OPENCLAW_STATE_DIR: stateDir },
        stateDir,
      }),
    ).resolves.toMatchObject({ status: "fallback" });

    const saved = await fs.readFile(prepared.savedReportPath, "utf8");
    expect(saved).toBe(prepared.body);
    expect(Buffer.byteLength(saved, "utf8")).toBeLessThanOrEqual(16_000);
    expect(saved).toContain("Rollback outcome: verified safe to restart");
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
      expect((await fs.stat(path.dirname(prepared.savedReportPath))).mode & 0o777).toBe(0o700);
      expect((await fs.stat(prepared.savedReportPath)).mode & 0o777).toBe(0o600);
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
      "Rollback outcome: package rollback verified; service restart not verified (runtime-verification-failed)",
    );
  });

  it("submits once and rejects a duplicate click for the same attempt", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-once", result: failedUpdate() },
      { stateDir },
    );
    const createIssue = mockCreatedIssue("https://github.com/openclaw/openclaw/issues/123");

    const [first, second] = await Promise.all([
      submitUpdateFailureReport(prepared, prepared.previewDigest, { createIssue, stateDir }),
      submitUpdateFailureReport(prepared, prepared.previewDigest, { createIssue, stateDir }),
    ]);
    const third = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue,
      stateDir,
      validateCurrentAttempt: () => false,
    });

    expect(createIssue).toHaveBeenCalledOnce();
    expect([first.status, second.status].toSorted()).toEqual(["created", "retryable"]);
    expect(third).toMatchObject({
      status: "duplicate",
      url: "https://github.com/openclaw/openclaw/issues/123",
    });
    await expect(fs.stat(prepared.savedReportPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("distinguishes an active preparation from ambiguous issue creation", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-preparing", result: failedUpdate() },
      { stateDir },
    );
    expect(
      reserveUpdateFailureReportReceipt(prepared.attemptId, "active-owner", {
        OPENCLAW_STATE_DIR: stateDir,
      }),
    ).toMatchObject({ reserved: true });
    const createIssue = mockCreatedIssue("https://github.com/openclaw/openclaw/issues/123");

    await expect(
      submitUpdateFailureReport(prepared, prepared.previewDigest, { createIssue, stateDir }),
    ).resolves.toMatchObject({
      message: "This update attempt already has a report preparation in progress.",
      status: "retryable",
    });
    expect(createIssue).not.toHaveBeenCalled();
  });

  it("cancels preparation when authority closes immediately before issue creation", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-auth-preflight-authority", result: failedUpdate() },
      { stateDir },
    );
    let authorityCurrent = true;
    let issueCreateCalls = 0;
    const createIssue = vi.fn(
      async (_issue: SanitizedGithubIssue, hooks: GithubIssueCreateAsyncHooks) => {
        await hooks.afterAuthPreflight?.();
        authorityCurrent = false;
        await hooks.beforeIssueCreate?.();
        issueCreateCalls += 1;
        return { ok: true as const, url: "https://github.com/openclaw/openclaw/issues/123" };
      },
    );

    await expect(
      submitUpdateFailureReport(prepared, prepared.previewDigest, {
        createIssue,
        hasCurrentAuthority: () => authorityCurrent,
        stateDir,
        validateCurrentAttempt: () => true,
      }),
    ).rejects.toThrow("current authenticated client");
    expect(issueCreateCalls).toBe(0);
    await expect(fs.stat(prepared.savedReportPath)).rejects.toMatchObject({ code: "ENOENT" });

    authorityCurrent = true;
    const retryCreateIssue = vi.fn(
      async (_issue: SanitizedGithubIssue, hooks: GithubIssueCreateAsyncHooks) => {
        await hooks.afterAuthPreflight?.();
        await hooks.beforeIssueCreate?.();
        issueCreateCalls += 1;
        return { ok: true as const, url: "https://github.com/openclaw/openclaw/issues/124" };
      },
    );
    await expect(
      submitUpdateFailureReport(prepared, prepared.previewDigest, {
        createIssue: retryCreateIssue,
        hasCurrentAuthority: () => authorityCurrent,
        stateDir,
        validateCurrentAttempt: () => true,
      }),
    ).resolves.toMatchObject({ status: "created" });
    expect(issueCreateCalls).toBe(1);
  });

  it("cancels preparation when the canonical attempt changes immediately before issue creation", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-auth-preflight-stale", result: failedUpdate() },
      { stateDir },
    );
    let currentAttempt = true;
    let issueCreateCalls = 0;
    const createIssue = vi.fn(
      async (_issue: SanitizedGithubIssue, hooks: GithubIssueCreateAsyncHooks) => {
        await hooks.afterAuthPreflight?.();
        currentAttempt = false;
        await hooks.beforeIssueCreate?.();
        issueCreateCalls += 1;
        return { ok: true as const, url: "https://github.com/openclaw/openclaw/issues/123" };
      },
    );

    await expect(
      submitUpdateFailureReport(prepared, prepared.previewDigest, {
        createIssue,
        stateDir,
        validateCurrentAttempt: () => currentAttempt,
      }),
    ).resolves.toMatchObject({ status: "stale" });
    expect(issueCreateCalls).toBe(0);
    await expect(fs.stat(prepared.savedReportPath)).rejects.toMatchObject({ code: "ENOENT" });

    currentAttempt = true;
    const retryCreateIssue = vi.fn(
      async (_issue: SanitizedGithubIssue, hooks: GithubIssueCreateAsyncHooks) => {
        await hooks.afterAuthPreflight?.();
        await hooks.beforeIssueCreate?.();
        issueCreateCalls += 1;
        return { ok: true as const, url: "https://github.com/openclaw/openclaw/issues/124" };
      },
    );
    await expect(
      submitUpdateFailureReport(prepared, prepared.previewDigest, {
        createIssue: retryCreateIssue,
        stateDir,
        validateCurrentAttempt: () => currentAttempt,
      }),
    ).resolves.toMatchObject({ status: "created" });
    expect(issueCreateCalls).toBe(1);
  });

  it("releases the reservation when the post-preflight attempt refresh throws", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-auth-preflight-refresh-error", result: failedUpdate() },
      { stateDir },
    );
    let issueCreateCalls = 0;
    const validateCurrentAttempt = vi
      .fn<() => boolean>()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockImplementationOnce(() => {
        throw new Error("restart sentinel refresh unavailable");
      });
    const createIssue = vi.fn(
      async (_issue: SanitizedGithubIssue, hooks: GithubIssueCreateAsyncHooks) => {
        await hooks.afterAuthPreflight?.();
        await hooks.beforeIssueCreate?.();
        issueCreateCalls += 1;
        return { ok: true as const, url: "https://github.com/openclaw/openclaw/issues/123" };
      },
    );

    await expect(
      submitUpdateFailureReport(prepared, prepared.previewDigest, {
        createIssue,
        stateDir,
        validateCurrentAttempt,
      }),
    ).rejects.toThrow("could not be rechecked");
    expect(issueCreateCalls).toBe(0);
    await expect(fs.stat(prepared.savedReportPath)).rejects.toMatchObject({ code: "ENOENT" });

    const retryCreateIssue = vi.fn(
      async (_issue: SanitizedGithubIssue, hooks: GithubIssueCreateAsyncHooks) => {
        await hooks.afterAuthPreflight?.();
        await hooks.beforeIssueCreate?.();
        issueCreateCalls += 1;
        return { ok: true as const, url: "https://github.com/openclaw/openclaw/issues/124" };
      },
    );
    await expect(
      submitUpdateFailureReport(prepared, prepared.previewDigest, {
        createIssue: retryCreateIssue,
        stateDir,
        validateCurrentAttempt: () => true,
      }),
    ).resolves.toMatchObject({ status: "created" });
    expect(issueCreateCalls).toBe(1);
  });

  it("does not let a pending-reservation loser delete the winner's fallback report", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-pending-fallback-race", result: failedUpdate() },
      { stateDir },
    );
    let finishValidation!: () => void;
    const validationGate = new Promise<boolean>((resolve) => {
      finishValidation = () => resolve(true);
    });
    const delayedCreateIssue = vi.fn();
    const delayed = submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue: delayedCreateIssue,
      stateDir,
      validateCurrentAttempt: () => validationGate,
    });
    const fallbackUrl = prepared.url;
    let finishFallback!: () => void;
    const createIssue = vi.fn(
      async (_issue: SanitizedGithubIssue, hooks: GithubIssueCreateAsyncHooks) => {
        await hooks.afterAuthPreflight?.();
        return await new Promise<{
          fallbackUrl: string;
          issueCreateStarted: false;
          message: string;
          ok: false;
        }>((resolve) => {
          finishFallback = () =>
            resolve({
              fallbackUrl,
              issueCreateStarted: false,
              message: "GitHub CLI unavailable",
              ok: false,
            });
        });
      },
    );
    const winner = submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue,
      stateDir,
    });
    await vi.waitFor(() => expect(createIssue).toHaveBeenCalledOnce());
    expect(await fs.readFile(prepared.savedReportPath, "utf8")).toBe(prepared.body);

    finishValidation();
    const delayedResult = await delayed;
    expect(delayedResult).toMatchObject({ status: "retryable" });
    expect(delayedResult).not.toHaveProperty("fallbackUrl");
    expect(delayedCreateIssue).not.toHaveBeenCalled();
    finishFallback();
    await expect(winner).resolves.toMatchObject({ status: "fallback", fallbackUrl });
    expect(await fs.readFile(prepared.savedReportPath, "utf8")).toBe(prepared.body);
  });

  it("does not let expired validation cleanup delete a replacement fallback report", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-expired-validation-cleanup", result: failedUpdate() },
      { stateDir },
    );
    let nowMs = 1_800_000_000_000;
    const now = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    let finishValidation!: () => void;
    const validationGate = new Promise<boolean>((resolve) => {
      finishValidation = () => resolve(false);
    });
    const validateCurrentAttempt = vi
      .fn<() => boolean | Promise<boolean>>()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(validationGate);
    const oldCreateIssue = vi.fn();
    const oldSubmission = submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue: oldCreateIssue,
      stateDir,
      validateCurrentAttempt,
    });
    await vi.waitFor(() => expect(validateCurrentAttempt).toHaveBeenCalledTimes(2));
    expect(await fs.readFile(prepared.savedReportPath, "utf8")).toBe(prepared.body);

    nowMs += 10 * 60_000;
    const replacement = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue: mockFallbackIssue(prepared.url),
      stateDir,
    });
    finishValidation();
    const oldResult = await oldSubmission;
    now.mockRestore();

    expect(replacement).toMatchObject({ fallbackUrl: prepared.url, status: "fallback" });
    expect(oldResult).toMatchObject({ fallbackUrl: prepared.url, status: "duplicate" });
    expect(oldCreateIssue).not.toHaveBeenCalled();
    expect(await fs.readFile(prepared.savedReportPath, "utf8")).toBe(prepared.body);
  });

  it("clears an expired owner's mismatched report before the replacement retries", async () => {
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
    let nowMs = 1_800_000_000_000;
    const now = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    let finishValidation!: () => void;
    const validationGate = new Promise<boolean>((resolve) => {
      finishValidation = () => resolve(false);
    });
    const validateCurrentAttempt = vi
      .fn<() => boolean | Promise<boolean>>()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(validationGate);
    const oldCreateIssue = vi.fn();
    const oldSubmission = submitUpdateFailureReport(oldPrepared, oldPrepared.previewDigest, {
      createIssue: oldCreateIssue,
      stateDir,
      validateCurrentAttempt,
    });
    await vi.waitFor(() => expect(validateCurrentAttempt).toHaveBeenCalledTimes(2));
    expect(await fs.readFile(oldPrepared.savedReportPath, "utf8")).toBe(oldPrepared.body);

    nowMs += 10 * 60_000;
    await expect(
      submitUpdateFailureReport(replacementPrepared, replacementPrepared.previewDigest, {
        createIssue: mockFallbackIssue(replacementPrepared.url),
        stateDir,
      }),
    ).rejects.toThrow("does not match the reviewed preview");
    await expect(fs.stat(oldPrepared.savedReportPath)).rejects.toMatchObject({ code: "ENOENT" });

    const replacement = await submitUpdateFailureReport(
      replacementPrepared,
      replacementPrepared.previewDigest,
      { createIssue: mockFallbackIssue(replacementPrepared.url), stateDir },
    );
    finishValidation();
    const oldResult = await oldSubmission;
    now.mockRestore();

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
    expect(await fs.readFile(replacementPrepared.savedReportPath, "utf8")).toBe(
      replacementPrepared.body,
    );
  });

  it("reclaims an expired pre-create preparation without letting its old owner submit", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-expired-preparation", result: failedUpdate() },
      { stateDir },
    );
    let nowMs = 1_800_000_000_000;
    const now = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    let releaseOldPreparation!: () => void;
    const oldPreparationGate = new Promise<void>((resolve) => {
      releaseOldPreparation = resolve;
    });
    let issueCreateCalls = 0;
    const oldCreateIssue = vi.fn(
      async (_issue: SanitizedGithubIssue, hooks: GithubIssueCreateAsyncHooks) => {
        await hooks.afterAuthPreflight?.();
        await oldPreparationGate;
        await hooks.beforeIssueCreate?.();
        issueCreateCalls += 1;
        return { ok: true as const, url: "https://github.com/openclaw/openclaw/issues/122" };
      },
    );

    const oldSubmission = submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue: oldCreateIssue,
      stateDir,
    });
    await vi.waitFor(() => expect(oldCreateIssue).toHaveBeenCalledOnce());
    expect(
      readUpdateFailureReportReceipt(prepared.attemptId, {
        OPENCLAW_STATE_DIR: stateDir,
      }),
    ).toMatchObject({ status: "preparing" });

    nowMs += 10 * 60_000;
    const replacement = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue: mockCreatedIssue("https://github.com/openclaw/openclaw/issues/123"),
      stateDir,
    });
    releaseOldPreparation();
    const oldResult = await oldSubmission;
    now.mockRestore();

    expect(replacement).toMatchObject({
      status: "created",
      url: "https://github.com/openclaw/openclaw/issues/123",
    });
    expect(oldResult).toMatchObject({
      status: "duplicate",
      url: "https://github.com/openclaw/openclaw/issues/123",
    });
    expect(issueCreateCalls).toBe(0);
  });

  it("does not publish a fallback after its preparation lease is replaced", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-expired-fallback-preparation", result: failedUpdate() },
      { stateDir },
    );
    let nowMs = 1_800_000_000_000;
    const now = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    let releaseOldFallback!: () => void;
    const oldFallbackGate = new Promise<void>((resolve) => {
      releaseOldFallback = resolve;
    });
    const oldFallback = vi.fn(
      async (_issue: SanitizedGithubIssue, hooks: GithubIssueCreateAsyncHooks) => {
        await hooks.afterAuthPreflight?.();
        await oldFallbackGate;
        return {
          fallbackUrl: prepared.url,
          issueCreateStarted: false as const,
          message: "GitHub CLI unavailable",
          ok: false as const,
        };
      },
    );
    const oldSubmission = submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue: oldFallback,
      stateDir,
    });
    await vi.waitFor(() => expect(oldFallback).toHaveBeenCalledOnce());

    nowMs += 10 * 60_000;
    const replacement = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue: mockCreatedIssue("https://github.com/openclaw/openclaw/issues/123"),
      stateDir,
    });
    releaseOldFallback();
    const oldResult = await oldSubmission;
    now.mockRestore();

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
  });

  it.each([
    ["returns false", () => false],
    [
      "throws",
      () => {
        throw new Error("receipt database unavailable");
      },
    ],
  ])("returns a created URL without retrying when receipt finalization %s", async (_, fail) => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-created-finalize-failure", result: failedUpdate() },
      { stateDir },
    );
    const issueUrl = "https://github.com/openclaw/openclaw/issues/123";
    const createIssue = mockCreatedIssue(issueUrl);
    const finalizeReceipt = vi.fn(finalizeUpdateFailureReportReceipt).mockImplementationOnce(fail);

    const first = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue,
      finalizeReceipt,
      stateDir,
    });
    const second = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue,
      stateDir,
    });

    expect(first).toMatchObject({ status: "created", url: issueUrl });
    expect(second).toMatchObject({ status: "duplicate", url: issueUrl });
    expect(createIssue).toHaveBeenCalledOnce();
    expect(finalizeReceipt).toHaveBeenCalledTimes(2);
    await expect(fs.stat(prepared.savedReportPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers a durable created result before rejecting the original attempt as stale", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-created-finalize-unavailable", result: failedUpdate() },
      { stateDir },
    );
    const issueUrl = "https://github.com/openclaw/openclaw/issues/123";
    const createIssue = mockCreatedIssue(issueUrl);
    const finalizeReceipt = vi.fn(() => false);

    const first = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue,
      finalizeReceipt,
      stateDir,
    });
    const recoveryPath = `${prepared.savedReportPath}.result.json`;
    const recovery = JSON.parse(await fs.readFile(recoveryPath, "utf8")) as unknown;
    expect(recovery).toEqual({
      reservationId: expect.any(String),
      status: "created",
      url: issueUrl,
    });
    await expect(fs.stat(prepared.savedReportPath)).rejects.toMatchObject({ code: "ENOENT" });
    if (process.platform !== "win32") {
      expect((await fs.stat(recoveryPath)).mode & 0o777).toBe(0o600);
    }

    const second = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue,
      stateDir,
      validateCurrentAttempt: () => false,
    });

    expect(first).toMatchObject({ status: "created", url: issueUrl });
    expect(second).toMatchObject({ status: "created", url: issueUrl });
    expect(createIssue).toHaveBeenCalledOnce();
    expect(finalizeReceipt).toHaveBeenCalledTimes(2);
    await expect(fs.stat(prepared.savedReportPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(recoveryPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not hide a created result when saved-report cleanup fails", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-created-cleanup-failure", result: failedUpdate() },
      { stateDir },
    );
    const issueUrl = "https://github.com/openclaw/openclaw/issues/123";
    const createIssue = mockCreatedIssue(issueUrl);
    const realRm = fs.rm.bind(fs);
    const rm = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (target === prepared.savedReportPath) {
        throw new Error("simulated saved-report cleanup failure");
      }
      return await realRm(target, options);
    });
    let first: Awaited<ReturnType<typeof submitUpdateFailureReport>>;
    try {
      first = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
        createIssue,
        stateDir,
      });
    } finally {
      rm.mockRestore();
    }

    expect(first).toMatchObject({ status: "created", url: issueUrl });
    expect(await fs.readFile(prepared.savedReportPath, "utf8")).toBe(prepared.body);
    const second = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue,
      stateDir,
    });
    expect(second).toMatchObject({ status: "duplicate", url: issueUrl });
    expect(createIssue).toHaveBeenCalledOnce();
    await expect(fs.stat(prepared.savedReportPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("surfaces durable-recovery failure without replaying a created issue", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-created-recovery-failure", result: failedUpdate() },
      { stateDir },
    );
    const issueUrl = "https://github.com/openclaw/openclaw/issues/123";
    const createIssue = mockCreatedIssue(issueUrl);
    const finalizeReceipt = vi.fn(() => false);
    const recoveryPath = `${prepared.savedReportPath}.result.json`;
    const realLink = fs.link.bind(fs);
    const link = vi.spyOn(fs, "link").mockImplementation(async (existingPath, newPath) => {
      if (newPath === recoveryPath) {
        throw Object.assign(new Error("simulated recovery publication failure"), { code: "EIO" });
      }
      return await realLink(existingPath, newPath);
    });
    let first: Awaited<ReturnType<typeof submitUpdateFailureReport>>;
    try {
      first = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
        createIssue,
        finalizeReceipt,
        stateDir,
      });
    } finally {
      link.mockRestore();
    }

    expect(first).toMatchObject({
      message: expect.stringContaining("local receipt could not be saved"),
      status: "created",
      url: issueUrl,
    });
    expect(await fs.readFile(prepared.savedReportPath, "utf8")).toBe(prepared.body);
    await expect(fs.stat(recoveryPath)).rejects.toMatchObject({ code: "ENOENT" });
    const second = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue,
      stateDir,
    });
    expect(second).toMatchObject({ status: "pending" });
    expect(createIssue).toHaveBeenCalledOnce();
  });
});
