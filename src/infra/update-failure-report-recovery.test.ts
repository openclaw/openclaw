import fs from "node:fs/promises";
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

function mockAmbiguousIssue(message: string) {
  return vi.fn(async (_issue: SanitizedGithubIssue, hooks: GithubIssueCreateAsyncHooks) => {
    await hooks.afterAuthPreflight?.();
    await hooks.beforeIssueCreate?.();
    return { ambiguous: true as const, message, ok: false as const };
  });
}

describe("update failure report recovery", () => {
  it("recovers an unresolved fallback receipt without replaying transport", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-fallback-finalize-unavailable", result: failedUpdate() },
      { stateDir },
    );
    const fallbackUrl = prepared.url;
    const createIssue = mockFallbackIssue(fallbackUrl);
    const finalizeReceipt = vi.fn(() => false);
    let nowMs = 1_800_000_000_000;
    const now = vi.spyOn(Date, "now").mockImplementation(() => nowMs);

    const first = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue,
      finalizeReceipt,
      stateDir,
    });
    const recoveryPath = `${prepared.savedReportPath}.result.json`;
    expect(JSON.parse(await fs.readFile(recoveryPath, "utf8"))).toEqual({
      fallbackUrl,
      reservationId: expect.any(String),
      status: "fallback",
    });
    if (process.platform !== "win32") {
      expect((await fs.stat(recoveryPath)).mode & 0o777).toBe(0o600);
    }
    nowMs += 10 * 60_000;
    const second = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue,
      stateDir,
    });
    now.mockRestore();

    expect(first).toMatchObject({ status: "fallback", fallbackUrl });
    expect(second).toMatchObject({ status: "fallback", fallbackUrl });
    expect(createIssue).toHaveBeenCalledOnce();
    expect(await fs.readFile(prepared.savedReportPath, "utf8")).toBe(prepared.body);
    await expect(fs.stat(recoveryPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("suppresses recovered fallback details when reconciliation discovers a replacement owner", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-fallback-reconciliation-owner-change", result: failedUpdate() },
      { stateDir },
    );
    const createIssue = mockFallbackIssue(prepared.url);
    let nowMs = 1_800_000_000_000;
    const now = vi.spyOn(Date, "now").mockImplementation(() => nowMs);

    await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue,
      finalizeReceipt: () => false,
      stateDir,
    });
    nowMs += 10 * 60_000;

    let replacementInstalled = false;
    const refreshPreparation = vi.fn(
      (attemptId: string, _reservationId: string, env: NodeJS.ProcessEnv = process.env) => {
        if (!replacementInstalled) {
          expect(
            reserveUpdateFailureReportReceipt(attemptId, "replacement-owner", env),
          ).toMatchObject({ reserved: true });
          replacementInstalled = true;
        }
        return false;
      },
    );
    const recovered = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue,
      finalizeReceipt: () => false,
      refreshPreparation,
      stateDir,
    });
    now.mockRestore();

    expect(recovered).toMatchObject({ status: "retryable" });
    expect(recovered).not.toHaveProperty("fallbackUrl");
    expect(createIssue).toHaveBeenCalledOnce();
    expect(refreshPreparation).toHaveBeenCalled();
    expect(
      readUpdateFailureReportReceipt(prepared.attemptId, {
        OPENCLAW_STATE_DIR: stateDir,
      }),
    ).toMatchObject({ reservationId: "replacement-owner", status: "preparing" });
    await expect(fs.stat(`${prepared.savedReportPath}.result.json`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("suppresses a fallback when recovery publication outlives receipt ownership", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-fallback-recovery-owner-change", result: failedUpdate() },
      { stateDir },
    );
    let nowMs = 1_800_000_000_000;
    const now = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    let finishRecovery!: () => void;
    const recoveryGate = new Promise<boolean>((resolve) => {
      finishRecovery = () => resolve(true);
    });
    const writeRecovery = vi.fn(async () => await recoveryGate);
    const oldSubmission = submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue: mockFallbackIssue(prepared.url),
      finalizeReceipt: () => false,
      stateDir,
      writeRecovery,
    });
    await vi.waitFor(() => expect(writeRecovery).toHaveBeenCalledOnce());

    nowMs += 10 * 60_000;
    const replacement = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue: mockCreatedIssue("https://github.com/openclaw/openclaw/issues/123"),
      stateDir,
    });
    finishRecovery();
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
  });

  it("rejects a tampered fallback recovery without invoking transport", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-tampered-fallback", result: failedUpdate() },
      { stateDir },
    );
    await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue: mockFallbackIssue(prepared.url),
      finalizeReceipt: () => false,
      stateDir,
    });
    const recoveryPath = `${prepared.savedReportPath}.result.json`;
    const recovery = JSON.parse(await fs.readFile(recoveryPath, "utf8")) as {
      fallbackUrl: string;
      reservationId: string;
      status: "fallback";
    }; // SAFETY: test-owned recovery fixture written by the production serializer above.
    recovery.fallbackUrl =
      "https://github.com/openclaw/openclaw/issues/new?body=token%3Dprivate-test-secret";
    await fs.writeFile(recoveryPath, JSON.stringify(recovery), "utf8");
    const createIssue = mockCreatedIssue("https://github.com/openclaw/openclaw/issues/123");

    await expect(
      submitUpdateFailureReport(prepared, prepared.previewDigest, { createIssue, stateDir }),
    ).rejects.toThrow("does not match the reviewed report");
    expect(createIssue).not.toHaveBeenCalled();
  });

  it.each(["created", "fallback"] as const)(
    "returns a durable %s recovery when receipt finalization and reads are unavailable",
    async (terminalStatus) => {
      const stateDir = tempDirs.make("openclaw-update-report-");
      const prepared = await prepareUpdateFailureReport(
        { attemptId: `attempt-recovery-read-failure-${terminalStatus}`, result: failedUpdate() },
        { stateDir },
      );
      const issueUrl = "https://github.com/openclaw/openclaw/issues/123";
      const createIssue =
        terminalStatus === "created" ? mockCreatedIssue(issueUrl) : mockFallbackIssue(prepared.url);
      await submitUpdateFailureReport(prepared, prepared.previewDigest, {
        createIssue,
        finalizeReceipt: () => false,
        stateDir,
      });
      const recoveryPath = `${prepared.savedReportPath}.result.json`;

      const recovered = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
        createIssue,
        finalizeReceipt: () => false,
        readReceipt: () => {
          throw new Error("state database unavailable");
        },
        stateDir,
      });

      expect(recovered).toMatchObject(
        terminalStatus === "created"
          ? { status: "created", url: issueUrl }
          : { fallbackUrl: prepared.url, status: "fallback" },
      );
      expect(createIssue).toHaveBeenCalledOnce();
      await expect(fs.stat(recoveryPath)).resolves.toBeDefined();
    },
  );

  it.each([
    ["returns false", () => false],
    [
      "throws",
      () => {
        throw new Error("pending fence unavailable");
      },
    ],
  ])(
    "withholds a fallback and permits retry after terminal recovery %s",
    async (_, failRecovery) => {
      const stateDir = tempDirs.make("openclaw-update-report-");
      const prepared = await prepareUpdateFailureReport(
        { attemptId: "attempt-unfenced-fallback", result: failedUpdate() },
        { stateDir },
      );
      const fallbackIssue = mockFallbackIssue(
        "https://github.com/openclaw/openclaw/issues/new?title=update",
      );
      let nowMs = 1_800_000_000_000;
      const now = vi.spyOn(Date, "now").mockImplementation(() => nowMs);

      const first = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
        createIssue: fallbackIssue,
        finalizeReceipt: () => false,
        stateDir,
        writeRecovery: async () => failRecovery(),
      });
      expect(first).toMatchObject({ status: "retryable" });
      expect(first).not.toHaveProperty("fallbackUrl");

      nowMs += 10 * 60_000;
      const createdIssue = mockCreatedIssue("https://github.com/openclaw/openclaw/issues/123");
      const second = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
        createIssue: createdIssue,
        stateDir,
      });
      now.mockRestore();

      expect(second).toMatchObject({ status: "created" });
      expect(fallbackIssue).toHaveBeenCalledOnce();
      expect(createdIssue).toHaveBeenCalledOnce();
    },
  );

  it("keeps the event loop responsive while issue creation is pending", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-responsive", result: failedUpdate() },
      { stateDir },
    );
    let resolveIssue!: (result: { ok: true; url: string }) => void;
    const createIssue = vi.fn(
      async (_issue: SanitizedGithubIssue, hooks: GithubIssueCreateAsyncHooks) => {
        await hooks.afterAuthPreflight?.();
        await hooks.beforeIssueCreate?.();
        return await new Promise<{ ok: true; url: string }>((resolve) => {
          resolveIssue = resolve;
        });
      },
    );

    const submission = submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue,
      stateDir,
    });
    await vi.waitFor(() => expect(createIssue).toHaveBeenCalledOnce());
    let timerRan = false;
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        timerRan = true;
        resolve();
      }, 0);
    });
    expect(timerRan).toBe(true);

    resolveIssue({ ok: true, url: "https://github.com/openclaw/openclaw/issues/123" });
    await expect(submission).resolves.toMatchObject({ status: "created" });
  });

  it("keeps timeout ambiguity pending without exposing a replay link", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-timeout", result: failedUpdate() },
      { stateDir },
    );
    const createIssue = mockAmbiguousIssue("spawnSync gh ETIMEDOUT");
    let nowMs = 1_800_000_000_000;
    const now = vi.spyOn(Date, "now").mockImplementation(() => nowMs);

    const first = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue,
      stateDir,
    });
    expect(
      readUpdateFailureReportReceipt(prepared.attemptId, {
        OPENCLAW_STATE_DIR: stateDir,
      }),
    ).toMatchObject({ status: "pending" });
    nowMs += 10 * 60_000;
    const second = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue,
      stateDir,
    });
    now.mockRestore();

    expect(first).toMatchObject({ status: "pending" });
    expect(first).not.toHaveProperty("fallbackUrl");
    expect(second).toMatchObject({ status: "pending" });
    expect(second).not.toHaveProperty("fallbackUrl");
    expect(createIssue).toHaveBeenCalledOnce();
  });

  it("restores a pending receipt when issue creation definitely did not start", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-issue-create-prestart-failure", result: failedUpdate() },
      { stateDir },
    );
    const createIssue = vi.fn(
      async (_issue: SanitizedGithubIssue, hooks: GithubIssueCreateAsyncHooks) => {
        await hooks.afterAuthPreflight?.();
        await hooks.beforeIssueCreate?.();
        return {
          fallbackUrl: prepared.url,
          issueCreateStarted: false as const,
          message: "spawn gh ENOENT",
          ok: false as const,
        };
      },
    );

    const first = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue,
      stateDir,
    });
    const second = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue,
      stateDir,
    });

    expect(first).toMatchObject({ fallbackUrl: prepared.url, status: "fallback" });
    expect(second).toMatchObject({ fallbackUrl: prepared.url, status: "duplicate" });
    expect(createIssue).toHaveBeenCalledOnce();
    expect(
      readUpdateFailureReportReceipt(prepared.attemptId, {
        OPENCLAW_STATE_DIR: stateDir,
      }),
    ).toMatchObject({ fallbackUrl: prepared.url, status: "fallback" });
  });

  it("does not expose a finalized fallback for a changed preview with the same attempt id", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const firstPrepared = await prepareUpdateFailureReport(
      {
        attemptId: "attempt-fallback-preview-changed",
        result: failedUpdate(),
        target: "origin/first",
      },
      { stateDir },
    );
    const firstCreateIssue = mockFallbackIssue(firstPrepared.url);
    await submitUpdateFailureReport(firstPrepared, firstPrepared.previewDigest, {
      createIssue: firstCreateIssue,
      stateDir,
    });
    const changedPrepared = await prepareUpdateFailureReport(
      {
        attemptId: firstPrepared.attemptId,
        result: failedUpdate({ reason: "install-failed" }),
        target: "origin/changed",
      },
      { stateDir },
    );
    const changedCreateIssue = mockFallbackIssue(changedPrepared.url);

    expect(changedPrepared.url).not.toBe(firstPrepared.url);
    const duplicate = await submitUpdateFailureReport(
      changedPrepared,
      changedPrepared.previewDigest,
      { createIssue: changedCreateIssue, stateDir },
    );

    expect(duplicate).toMatchObject({
      message: expect.stringContaining("different reviewed preview"),
      status: "duplicate",
    });
    expect(duplicate).not.toHaveProperty("fallbackUrl");
    expect(duplicate).not.toHaveProperty("url");
    expect(firstCreateIssue).toHaveBeenCalledOnce();
    expect(changedCreateIssue).not.toHaveBeenCalled();
  });

  it("allows an immediate retry when issue creation explicitly did not start", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-issue-create-retryable", result: failedUpdate() },
      { stateDir },
    );
    const createIssue = vi
      .fn()
      .mockImplementationOnce(
        async (_issue: SanitizedGithubIssue, hooks: GithubIssueCreateAsyncHooks) => {
          await hooks.afterAuthPreflight?.();
          await hooks.beforeIssueCreate?.();
          return {
            issueCreateStarted: false as const,
            message: "spawn gh EAGAIN",
            ok: false as const,
            retryable: true as const,
          };
        },
      )
      .mockImplementationOnce(
        async (_issue: SanitizedGithubIssue, hooks: GithubIssueCreateAsyncHooks) => {
          await hooks.afterAuthPreflight?.();
          await hooks.beforeIssueCreate?.();
          return { ok: true as const, url: "https://github.com/openclaw/openclaw/issues/123" };
        },
      );

    await expect(
      submitUpdateFailureReport(prepared, prepared.previewDigest, { createIssue, stateDir }),
    ).resolves.toMatchObject({ status: "retryable" });
    await expect(
      submitUpdateFailureReport(prepared, prepared.previewDigest, { createIssue, stateDir }),
    ).resolves.toMatchObject({
      status: "created",
      url: "https://github.com/openclaw/openclaw/issues/123",
    });
    expect(createIssue).toHaveBeenCalledTimes(2);
  });

  it("recovers retryability after the definitely-unstarted state transition fails", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-issue-create-retryable-recovery", result: failedUpdate() },
      { stateDir },
    );
    const issueUrl = "https://github.com/openclaw/openclaw/issues/123";
    const createIssue = vi
      .fn()
      .mockImplementationOnce(
        async (_issue: SanitizedGithubIssue, hooks: GithubIssueCreateAsyncHooks) => {
          await hooks.afterAuthPreflight?.();
          await hooks.beforeIssueCreate?.();
          return {
            issueCreateStarted: false as const,
            message: "spawn gh EMFILE",
            ok: false as const,
            retryable: true as const,
          };
        },
      )
      .mockImplementationOnce(
        async (_issue: SanitizedGithubIssue, hooks: GithubIssueCreateAsyncHooks) => {
          await hooks.afterAuthPreflight?.();
          await hooks.beforeIssueCreate?.();
          return { ok: true as const, url: issueUrl };
        },
      );
    const finalizeReceipt = vi
      .fn(finalizeUpdateFailureReportReceipt)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false);

    const first = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue,
      finalizeReceipt,
      stateDir,
    });
    expect(first).toMatchObject({ status: "retryable" });
    expect(
      readUpdateFailureReportReceipt(prepared.attemptId, {
        OPENCLAW_STATE_DIR: stateDir,
      }),
    ).toMatchObject({ status: "pending" });
    if (process.platform !== "win32") {
      expect((await fs.stat(`${prepared.savedReportPath}.result.json`)).mode & 0o777).toBe(0o600);
    }

    const reconciled = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue,
      stateDir,
    });
    expect(reconciled).toMatchObject({ status: "retryable" });
    expect(createIssue).toHaveBeenCalledOnce();
    expect(
      readUpdateFailureReportReceipt(prepared.attemptId, {
        OPENCLAW_STATE_DIR: stateDir,
      }),
    ).toMatchObject({ status: "retryable" });
    await expect(fs.stat(`${prepared.savedReportPath}.result.json`)).rejects.toMatchObject({
      code: "ENOENT",
    });

    const retried = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue,
      stateDir,
    });
    expect(retried).toMatchObject({ status: "created", url: issueUrl });
    expect(createIssue).toHaveBeenCalledTimes(2);
  });

  it("does not replay when definitely-unstarted retry state cannot be persisted", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-issue-create-unfenced-retry", result: failedUpdate() },
      { stateDir },
    );
    const createIssue = vi.fn(
      async (_issue: SanitizedGithubIssue, hooks: GithubIssueCreateAsyncHooks) => {
        await hooks.afterAuthPreflight?.();
        await hooks.beforeIssueCreate?.();
        return {
          issueCreateStarted: false as const,
          message: "spawn gh EAGAIN",
          ok: false as const,
          retryable: true as const,
        };
      },
    );

    const first = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue,
      finalizeReceipt: () => false,
      stateDir,
      writeRecovery: async () => false,
    });
    const second = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue,
      stateDir,
    });

    expect(first).toMatchObject({ status: "pending" });
    expect(second).toMatchObject({ status: "pending" });
    expect(createIssue).toHaveBeenCalledOnce();
  });

  it("requires the submitted body to match the reviewed preview", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-stale-preview", result: failedUpdate() },
      { stateDir },
    );
    const createIssue = vi.fn();

    await expect(
      submitUpdateFailureReport(prepared, "stale-digest", { createIssue, stateDir }),
    ).rejects.toThrow("preview is stale");
    expect(createIssue).not.toHaveBeenCalled();
    await expect(fs.stat(prepared.savedReportPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes a newly saved body when the canonical attempt changes before reservation", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-replaced", result: failedUpdate() },
      { stateDir },
    );
    const createIssue = vi.fn();

    await expect(
      submitUpdateFailureReport(prepared, prepared.previewDigest, {
        createIssue,
        stateDir,
        validateCurrentAttempt: () => false,
      }),
    ).resolves.toMatchObject({ status: "stale" });

    expect(createIssue).not.toHaveBeenCalled();
    await expect(fs.stat(prepared.savedReportPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
