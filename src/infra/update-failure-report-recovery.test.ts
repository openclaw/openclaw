import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { useStateDatabaseTempDirs } from "../test-utils/state-database-temp-dirs.js";
import type {
  GithubIssueSubmitHooks,
  GithubIssueReconcileHooks,
  PreparedGithubIssue,
} from "./github-issue.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import {
  finalizeUpdateFailureReportReceipt,
  markUpdateFailureReportReceiptPrepared,
  markUpdateFailureReportReceiptPending,
  readUpdateFailureReportReceipt,
  reserveUpdateFailureReportReceipt,
} from "./restart-sentinel.js";
import { prepareUpdateFailureReport, submitUpdateFailureReport } from "./update-failure-report.js";
import {
  createUpdateFailureReportFixture,
  expireUpdateFailureReportReceipt,
  savedReportArtifactPath,
  mockCreatedIssue,
  mockFallbackIssue,
} from "./update-failure-report.test-support.js";
import type { UpdateRunResult } from "./update-runner-types.js";

const tempDirs = useStateDatabaseTempDirs();

function failedUpdate(): UpdateRunResult {
  return {
    status: "error",
    mode: "git",
    reason: "build-failed",
    before: { sha: "a".repeat(40), version: "2026.8.1" },
    after: { sha: "b".repeat(40), version: "2026.8.2" },
    steps: [{ name: "build", command: "pnpm build", cwd: "/repo", durationMs: 12, exitCode: 1 }],
    durationMs: 20,
    recovery: { serviceRestartSafe: true, version: "2026.8.1" },
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

function mockRetryableNoStartIssue() {
  return vi.fn(async (_issue: PreparedGithubIssue, hooks: GithubIssueSubmitHooks) => {
    await hooks.afterAuthPreflight?.();
    const commitIssueCreate = await hooks.beforeIssueCreate?.();
    commitIssueCreate?.();
    return {
      cause: "transport-unavailable" as const,
      reason: "fallback-url-too-long" as const,
      status: "fallback-unavailable" as const,
    };
  });
}

describe("update failure report receipt recovery", () => {
  it.each(["created", "fallback"] as const)(
    "recovers a committed %s receipt after its writer loses the acknowledgement",
    async (status) => {
      const { prepared, submit } = await prepareFailedReport(`attempt-${status}-lost-ack`);
      const issueUrl = "https://github.com/openclaw/openclaw/issues/123";
      const createIssue =
        status === "created" ? mockCreatedIssue(issueUrl) : mockFallbackIssue(prepared.url);
      const finalizeReceipt = vi.fn(
        async (...args: Parameters<typeof finalizeUpdateFailureReportReceipt>) => {
          const committed = await finalizeUpdateFailureReportReceipt(...args);
          if (committed) {
            throw new Error("simulated lost commit acknowledgement");
          }
          return committed;
        },
      );

      const first = await submit({
        createIssue,
        finalizeReceipt,
      });
      const second = await submit({ createIssue });

      expect(first).toMatchObject(
        status === "created" ? { status, url: issueUrl } : { fallbackUrl: prepared.url, status },
      );
      expect(second).toMatchObject(
        status === "created"
          ? { status: "duplicate", url: issueUrl }
          : { fallbackUrl: prepared.url, status: "duplicate" },
      );
      expect(createIssue).toHaveBeenCalledOnce();
      await expect(fs.stat(`${prepared.savedReportPath}.result.json`)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("does not replay an unknown no-start receipt write after reconciliation also fails", async () => {
    const { receipt, submit } = await prepareFailedReport("attempt-no-start-unknown-receipt");
    const createIssue = mockRetryableNoStartIssue();
    const finalizeReceipt = vi.fn(async () => {
      throw new Error("Receipt acknowledgement unavailable");
    });
    const result = await submit({ createIssue, finalizeReceipt });
    expect(result).toMatchObject({ status: "pending" });
    expect(finalizeReceipt).toHaveBeenCalledOnce();
    expect(await receipt()).toMatchObject({ status: "pending" });
    expect(createIssue).toHaveBeenCalledOnce();
  });

  it("retains retryable ownership until interrupted artifact cleanup completes", async () => {
    const { prepared, receipt, submit } = await prepareFailedReport(
      "attempt-retryable-cleanup-interruption",
    );
    const first = await submit({ createIssue: mockRetryableNoStartIssue() });
    const secondCreateIssue = mockCreatedIssue("https://github.com/openclaw/openclaw/issues/123");
    const rm = vi
      .spyOn(fs, "rm")
      .mockRejectedValueOnce(new Error("simulated retryable cleanup interruption"));

    let second: Awaited<ReturnType<typeof submitUpdateFailureReport>>;
    try {
      second = await submit({ createIssue: secondCreateIssue });
    } finally {
      rm.mockRestore();
    }

    expect(second).toMatchObject({ status: "retryable" });
    expect(secondCreateIssue).not.toHaveBeenCalled();
    expect(await receipt()).toMatchObject({
      cleanup: "pending",
      reservationId: expect.any(String),
      status: "retryable",
    });
    await expect(fs.readFile(first.savedReportPath, "utf8")).resolves.toBe(prepared.body);

    const third = await submit({ createIssue: secondCreateIssue });

    expect(third).toMatchObject({
      status: "created",
      url: "https://github.com/openclaw/openclaw/issues/123",
    });
    expect(secondCreateIssue).toHaveBeenCalledOnce();
    expect(third.savedReportPath).not.toBe(first.savedReportPath);
    await expect(fs.stat(first.savedReportPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a retryable artifact when a later submission is stale", async () => {
    const { prepared, receipt, submit } = await prepareFailedReport("attempt-retryable-stale");
    const first = await submit({ createIssue: mockRetryableNoStartIssue() });
    const staleCreateIssue = mockCreatedIssue("https://github.com/openclaw/openclaw/issues/123");

    const stale = await submit({
      createIssue: staleCreateIssue,
      validateCurrentAttempt: () => false,
    });

    expect(stale).toMatchObject({ status: "stale" });
    expect(staleCreateIssue).not.toHaveBeenCalled();
    const retainedReceipt = await receipt();
    expect(retainedReceipt).toMatchObject({ status: "retryable" });
    expect(retainedReceipt).not.toHaveProperty("cleanup");
    await expect(fs.readFile(first.savedReportPath, "utf8")).resolves.toBe(prepared.body);
  });

  it("retains expired preparation custody when cleanup is interrupted", async () => {
    const { env, prepared, receipt, stateDir, submit } = await prepareFailedReport(
      "attempt-expired-preparation-cleanup",
    );
    const expiredReservationId = "expired-cleanup-owner";
    expect(
      await reserveUpdateFailureReportReceipt(
        prepared.attemptId,
        expiredReservationId,
        prepared.previewDigest,
        env,
      ),
    ).toMatchObject({ reserved: true });
    const expiredReportPath = savedReportArtifactPath(prepared, expiredReservationId);
    await fs.mkdir(path.dirname(expiredReportPath), { recursive: true });
    await fs.writeFile(expiredReportPath, prepared.body, { mode: 0o600 });
    expireUpdateFailureReportReceipt(prepared.attemptId, stateDir);
    const createIssue = mockCreatedIssue("https://github.com/openclaw/openclaw/issues/123");
    const rm = vi
      .spyOn(fs, "rm")
      .mockRejectedValueOnce(new Error("simulated expired cleanup interruption"));

    let interrupted: Awaited<ReturnType<typeof submitUpdateFailureReport>>;
    try {
      interrupted = await submit({ createIssue });
    } finally {
      rm.mockRestore();
    }

    expect(interrupted).toMatchObject({ status: "retryable" });
    expect(createIssue).not.toHaveBeenCalled();
    expect(await receipt()).toMatchObject({
      cleanup: "pending",
      reservationId: expiredReservationId,
      status: "retryable",
    });
    await expect(fs.readFile(expiredReportPath, "utf8")).resolves.toBe(prepared.body);

    const recovered = await submit({ createIssue });

    expect(recovered).toMatchObject({ status: "created" });
    expect(recovered.savedReportPath).not.toBe(expiredReportPath);
    expect(createIssue).toHaveBeenCalledOnce();
    await expect(fs.stat(expiredReportPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves non-growing expired-owner sweep custody across repeated retries", async () => {
    const { env, prepared, receipt, stateDir, submit } = await prepareFailedReport(
      "attempt-expired-owner-successor-retry",
    );
    const expiredReservationId = "expired-owner-before-retry";
    expect(
      await reserveUpdateFailureReportReceipt(
        prepared.attemptId,
        expiredReservationId,
        prepared.previewDigest,
        env,
      ),
    ).toMatchObject({ reserved: true });
    expireUpdateFailureReportReceipt(prepared.attemptId, stateDir);

    let retryable: Awaited<ReturnType<typeof submitUpdateFailureReport>> | undefined;
    for (let index = 0; index < 20; index += 1) {
      retryable = await submit({ createIssue: mockRetryableNoStartIssue() });
      expect(retryable).toMatchObject({ status: "retryable" });
    }

    const created = await submit({
      createIssue: mockCreatedIssue("https://github.com/openclaw/openclaw/issues/123"),
    });

    expect(created).toMatchObject({ status: "created" });
    expect(await receipt()).toMatchObject({
      artifactSweep: "pending",
      status: "created",
    });
    if (!retryable) {
      throw new Error("expected the repeated retry result");
    }
    await expect(fs.stat(retryable.savedReportPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reconciles a created issue after restart before stale-attempt validation", async () => {
    const { prepared, receipt, submit } = await prepareFailedReport(
      "attempt-created-reconcile-restart",
    );
    const issueUrl = "https://github.com/openclaw/openclaw/issues/123";
    const createIssue = mockCreatedIssue(issueUrl);

    const submitted = await submit({
      createIssue,
      finalizeReceipt: () => false,
    });
    const reconcileIssue = vi.fn(async () => ({ status: "created" as const, url: issueUrl }));
    const recovered = await submit({
      createIssue,
      reconcileIssue,
      validateCurrentAttempt: () => false,
    });

    expect(recovered).toMatchObject({ status: "duplicate", url: issueUrl });
    expect(createIssue).toHaveBeenCalledOnce();
    expect(reconcileIssue).toHaveBeenCalledWith(prepared, expect.any(Object));
    expect(await receipt()).toMatchObject({
      previewDigest: prepared.previewDigest,
      status: "created",
      url: issueUrl,
    });
    await expect(fs.stat(submitted.savedReportPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps an unreconciled restart pending without replaying issue creation", async () => {
    const { submit } = await prepareFailedReport("attempt-created-reconcile-miss");
    const createIssue = mockCreatedIssue("https://github.com/openclaw/openclaw/issues/123");

    await submit({
      createIssue,
      finalizeReceipt: () => false,
    });
    const result = await submit({
      createIssue,
      reconcileIssue: async () => ({ status: "not-found" }),
    });

    expect(result).toMatchObject({ status: "pending" });
    expect(result).not.toHaveProperty("url");
    expect(createIssue).toHaveBeenCalledOnce();
  });

  it("stops restart reconciliation when client authority expires before lookup", async () => {
    const { receipt, submit } = await prepareFailedReport("attempt-created-reconcile-revoked");
    const createIssue = mockCreatedIssue("https://github.com/openclaw/openclaw/issues/123");

    await submit({
      createIssue,
      finalizeReceipt: () => false,
    });
    let authorityCurrent = true;
    let lookupCalls = 0;
    const reconcileIssue = vi.fn(
      async (_issue: PreparedGithubIssue, hooks: GithubIssueReconcileHooks) => {
        authorityCurrent = false;
        await hooks.beforeIssueLookup?.();
        lookupCalls += 1;
        return {
          status: "created" as const,
          url: "https://github.com/openclaw/openclaw/issues/123",
        };
      },
    );

    const result = await submit({
      createIssue,
      hasCurrentAuthority: () => authorityCurrent,
      reconcileIssue,
    });

    expect(result).toMatchObject({ status: "pending" });
    expect(result).not.toHaveProperty("url");
    expect(lookupCalls).toBe(0);
    expect(createIssue).toHaveBeenCalledOnce();
    expect(await receipt()).toMatchObject({
      status: "pending",
    });
  });

  it("returns the created URL when post-transport receipt reads are also unavailable", async () => {
    const { submit } = await prepareFailedReport("attempt-created-read-outage");
    const issueUrl = "https://github.com/openclaw/openclaw/issues/123";
    const createIssue = mockCreatedIssue(issueUrl);
    const readReceipt = vi
      .fn(readUpdateFailureReportReceipt)
      .mockImplementationOnce(readUpdateFailureReportReceipt)
      .mockImplementationOnce(() => {
        throw new Error("simulated state read outage after transport");
      });

    const first = await submit({
      createIssue,
      finalizeReceipt: () => false,
      readReceipt,
    });
    const second = await submit({ createIssue });

    expect(first).toMatchObject({ status: "created", url: issueUrl });
    expect(second).toMatchObject({ status: "pending" });
    expect(createIssue).toHaveBeenCalledOnce();
  });

  it("commits cleanup intent before filesystem deletion and resumes it after reconnect", async () => {
    const { prepared, receipt, submit } = await prepareFailedReport(
      "attempt-created-cleanup-reconnect",
    );
    const issueUrl = "https://github.com/openclaw/openclaw/issues/123";
    const createIssue = mockCreatedIssue(issueUrl);
    const realRm = fs.rm.bind(fs);
    let observedReceipt: Awaited<ReturnType<typeof readUpdateFailureReportReceipt>> | undefined;
    const rm = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (
        path.dirname(String(target)) === path.dirname(prepared.savedReportPath) &&
        path.basename(String(target)).startsWith(`${path.parse(prepared.savedReportPath).name}.`)
      ) {
        observedReceipt = await receipt();
        throw new Error("simulated post-commit cleanup interruption");
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
    expect(observedReceipt).toMatchObject({
      cleanup: "pending",
      previewDigest: prepared.previewDigest,
      status: "created",
      url: issueUrl,
    });
    await expect(fs.readFile(first.savedReportPath, "utf8")).resolves.toBe(prepared.body);

    const second = await submit({ createIssue });

    expect(second).toMatchObject({ status: "duplicate", url: issueUrl });
    expect(createIssue).toHaveBeenCalledOnce();
    await expect(fs.stat(first.savedReportPath)).rejects.toMatchObject({ code: "ENOENT" });
    const completed = await receipt();
    expect(completed).toMatchObject({
      status: "created",
      url: issueUrl,
    });
    expect(completed).not.toHaveProperty("cleanup");
  });

  it("refuses to start transport after the approved preview digest changes", async () => {
    const { env, prepared, receipt } = await prepareFailedReport("attempt-pending-digest-change");
    expect(
      await reserveUpdateFailureReportReceipt(
        prepared.attemptId,
        "digest-owner",
        prepared.previewDigest,
        env,
      ),
    ).toMatchObject({ reserved: true });
    expect(
      await markUpdateFailureReportReceiptPrepared(
        prepared.attemptId,
        "digest-owner",
        prepared.previewDigest,
        env,
      ),
    ).toBe(true);

    expect(
      await markUpdateFailureReportReceiptPending(
        prepared.attemptId,
        "digest-owner",
        "f".repeat(64),
        env,
      ),
    ).toBe(false);
    expect(await receipt()).toMatchObject({
      previewDigest: prepared.previewDigest,
      status: "prepared",
    });
  });

  it.each([
    { cleanup: "pending" as const, reservationId: "owner", status: "created" as const },
    {
      fallbackUrl: "https://evil.example/openclaw/openclaw/issues/new",
      reservationId: "owner",
      status: "fallback" as const,
    },
  ])(
    "refuses an unreadable terminal receipt without wedging the pending owner",
    async (terminalReceipt) => {
      const { env, prepared, receipt } = await prepareFailedReport(
        `attempt-invalid-terminal-${terminalReceipt.status}`,
      );
      expect(
        await reserveUpdateFailureReportReceipt(
          prepared.attemptId,
          terminalReceipt.reservationId,
          prepared.previewDigest,
          env,
        ),
      ).toMatchObject({ reserved: true });
      expect(
        await markUpdateFailureReportReceiptPrepared(
          prepared.attemptId,
          terminalReceipt.reservationId,
          prepared.previewDigest,
          env,
        ),
      ).toBe(true);
      if (terminalReceipt.status === "created") {
        expect(
          await markUpdateFailureReportReceiptPending(
            prepared.attemptId,
            terminalReceipt.reservationId,
            prepared.previewDigest,
            env,
          ),
        ).toBe(true);
      }

      expect(
        await finalizeUpdateFailureReportReceipt(
          prepared.attemptId,
          { ...terminalReceipt, previewDigest: prepared.previewDigest },
          env,
        ),
      ).toBe(false);
      expect(await receipt()).toMatchObject({
        previewDigest: prepared.previewDigest,
        status: terminalReceipt.status === "created" ? "pending" : "prepared",
      });
    },
  );

  it("parses a pre-upgrade receipt conservatively without exposing an unbound URL", async () => {
    const { env, prepared, submit } = await prepareFailedReport("attempt-legacy-receipt");
    expect(
      await reserveUpdateFailureReportReceipt(
        prepared.attemptId,
        "legacy-owner",
        prepared.previewDigest,
        env,
      ),
    ).toMatchObject({ reserved: true });
    const { db } = openOpenClawStateDatabase({ env });
    const stateDb =
      getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "gateway_restart_sentinel">>(db);
    const key = `update-failure-report:${createHash("sha256")
      .update(prepared.attemptId)
      .digest("hex")}`;
    const legacyReceipt = {
      reservationId: "legacy-owner",
      status: "created",
      url: "https://github.com/openclaw/openclaw/issues/123",
    };
    executeSqliteQuerySync(
      db,
      stateDb
        .updateTable("gateway_restart_sentinel")
        .set({
          message: JSON.stringify(legacyReceipt),
          payload_json: JSON.stringify({
            kind: "update",
            message: JSON.stringify(legacyReceipt),
            stats: { reason: "update-failure-report-receipt" },
            status: "skipped",
            ts: Date.now(),
          }),
        })
        .where("sentinel_key", "=", key),
    );
    const createIssue = mockCreatedIssue("https://github.com/openclaw/openclaw/issues/124");

    const result = await submit({ createIssue });

    expect(result).toMatchObject({
      message: expect.stringContaining("different reviewed preview"),
      status: "duplicate",
    });
    expect(result).not.toHaveProperty("url");
    expect(createIssue).not.toHaveBeenCalled();
  });
});
