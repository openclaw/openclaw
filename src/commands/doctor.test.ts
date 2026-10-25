import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DoctorSessionSqliteReport } from "./doctor-session-sqlite.js";

const mocks = vi.hoisted(() => ({
  claimSessionSqliteMigrationGithubIssue: vi.fn(),
  clearSessionSqliteMigrationGithubIssueClaim: vi.fn(),
  detectBrowserOpenSupport: vi.fn(),
  openUrl: vi.fn(),
  promptYesNo: vi.fn(),
  readSourceConfigBestEffort: vi.fn(),
  reconcileGithubIssue: vi.fn(),
  runPostUpgradeProbes: vi.fn(),
  runDoctorStateSqliteCompact: vi.fn(),
  runDoctorSessionSqlite: vi.fn(),
  sqliteMaintenanceAuthority: { assertCurrent: vi.fn() },
  submitGithubIssue: vi.fn(),
  withDoctorSqliteMaintenanceLock: vi.fn(),
  resolveInstalledPluginIndexStorePath: vi.fn(() => "/tmp/openclaw-installed-plugins.json"),
}));

vi.mock("../config/io.runtime.js", () => ({
  readSourceConfigBestEffort: mocks.readSourceConfigBestEffort,
}));

vi.mock("./doctor-post-upgrade.js", () => ({
  runPostUpgradeProbes: mocks.runPostUpgradeProbes,
}));

vi.mock("./doctor-session-sqlite.js", () => ({
  runDoctorSessionSqlite: mocks.runDoctorSessionSqlite,
  reconcileDoctorSessionSqlitePublication: vi.fn(),
}));

vi.mock("./doctor-state-sqlite-compact.js", () => ({
  runDoctorStateSqliteCompact: mocks.runDoctorStateSqliteCompact,
}));

vi.mock("./doctor-sqlite-maintenance-lock.js", () => ({
  isDestructiveDoctorSessionSqliteMode: (mode: string) =>
    mode === "import" || mode === "compact" || mode === "restore" || mode === "recover",
  withDoctorSqliteMaintenanceLock: mocks.withDoctorSqliteMaintenanceLock,
}));

vi.mock("../infra/github-issue.js", () => ({
  prepareGithubIssue: (input: { body: string; title: string }) => ({
    ...input,
    browserFallback: {
      status: "available",
      url: "https://github.com/openclaw/openclaw/issues/new?title=run-1",
    },
    marker: `openclaw-report:${"a".repeat(64)}`,
  }),
  reconcileGithubIssue: mocks.reconcileGithubIssue,
  submitGithubIssue: mocks.submitGithubIssue,
}));

vi.mock("./doctor-session-sqlite-failure.js", () => ({
  claimSessionSqliteMigrationGithubIssue: mocks.claimSessionSqliteMigrationGithubIssue,
  clearSessionSqliteMigrationGithubIssueClaim: mocks.clearSessionSqliteMigrationGithubIssueClaim,
}));

vi.mock("../infra/browser-open.js", () => ({
  detectBrowserOpenSupport: mocks.detectBrowserOpenSupport,
  openUrl: mocks.openUrl,
}));

vi.mock("../cli/prompt.js", () => ({
  promptYesNo: mocks.promptYesNo,
}));

vi.mock("../plugins/installed-plugin-index-store-path.js", () => ({
  resolveInstalledPluginIndexStorePath: mocks.resolveInstalledPluginIndexStorePath,
}));

const { doctorCommand } = await import("./doctor.js");

function createDoctorRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`exit:${code}`);
    }),
  };
}

function createSessionReport(mode: DoctorSessionSqliteReport["mode"]): DoctorSessionSqliteReport {
  return {
    mode,
    targets: [],
    totals: {
      archivedTranscriptFiles: 0,
      archivedUnreferencedJsonlFiles: 0,
      importedEntries: 0,
      importedTranscriptEvents: 0,
      issues: 0,
      legacyEntries: 0,
      sqliteEntries: 0,
      targets: 0,
      unreferencedJsonlFiles: 0,
      validatedEntries: 0,
      validatedTranscriptEvents: 0,
    },
  };
}

function createSupportIssue(
  body = "sanitized body",
): NonNullable<DoctorSessionSqliteReport["supportIssue"]> {
  return { body, title: "Session SQLite migration recovery report (run-1)" };
}

function createRecoveryReport(
  supportIssue?: NonNullable<DoctorSessionSqliteReport["supportIssue"]>,
): DoctorSessionSqliteReport {
  return {
    ...createSessionReport("recover"),
    migrationRun: { manifestPath: "/tmp/run-1.json", runId: "run-1" },
    supportIssue,
  };
}

const approvedRecoveryOptions = {
  sessionSqlite: "recover",
  sessionSqliteGithubIssue: true,
  yes: true,
} as const;

function runDoctor(
  runtime: ReturnType<typeof createDoctorRuntime>,
  options: Parameters<typeof doctorCommand>[1] = approvedRecoveryOptions,
  exitCode = 0,
) {
  return expect(doctorCommand(runtime, options)).rejects.toThrow(`exit:${exitCode}`);
}

function recovery(body = "sanitized body") {
  const supportIssue = createSupportIssue(body);
  const report = createRecoveryReport(supportIssue);
  mocks.runDoctorSessionSqlite.mockResolvedValueOnce(report);
  return { supportIssue, report, runtime: createDoctorRuntime() };
}

const fallbackUrl =
  "https://github.com/openclaw/openclaw/issues/new?title=run-1&body=private-report-text";

function expectClaimReleased() {
  expect(mocks.clearSessionSqliteMigrationGithubIssueClaim).toHaveBeenCalledWith(
    "/tmp/run-1.json",
    `openclaw-report:${"a".repeat(64)}`,
    expect.objectContaining({ assertCurrent: expect.any(Function) }),
  );
}

function expectUnused(...spies: ReturnType<typeof vi.fn>[]) {
  for (const spy of spies) {
    expect(spy).not.toHaveBeenCalled();
  }
}

function repeatReceipt(title: string) {
  const issue = {
    marker: `openclaw-report:${"a".repeat(64)}`,
    status: "attempted",
    title,
  } as const;
  mocks.claimSessionSqliteMigrationGithubIssue
    .mockReturnValueOnce({ issue, status: "claimed" })
    .mockReturnValueOnce({ issue, status: "existing" });
}

describe("doctorCommand", () => {
  const stdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");

  afterEach(() => {
    if (stdinIsTTY) {
      Object.defineProperty(process.stdin, "isTTY", stdinIsTTY);
    } else {
      Reflect.deleteProperty(process.stdin, "isTTY");
    }
  });

  beforeEach(() => {
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    vi.clearAllMocks();
    mocks.claimSessionSqliteMigrationGithubIssue.mockImplementation(
      (_manifestPath: string, issue: { marker: string; title: string }) => ({
        issue: { ...issue, status: "attempted" },
        status: "claimed",
      }),
    );
    mocks.clearSessionSqliteMigrationGithubIssueClaim.mockReturnValue(true);
    mocks.detectBrowserOpenSupport.mockResolvedValue({ ok: true });
    mocks.readSourceConfigBestEffort.mockResolvedValue({});
    mocks.reconcileGithubIssue.mockResolvedValue({ status: "not-found" });
    mocks.withDoctorSqliteMaintenanceLock.mockImplementation(
      async (params: { run: (authority: { assertCurrent(): void }) => unknown }) =>
        await params.run(mocks.sqliteMaintenanceAuthority),
    );
  });

  it("prints the intentional non-outcome instead of filing an empty recovery", async () => {
    mocks.runDoctorSessionSqlite.mockResolvedValueOnce(createRecoveryReport());
    const runtime = createDoctorRuntime();
    await runDoctor(runtime);
    expect(runtime.log).toHaveBeenCalledWith(
      "session-sqlite recover: nothing to recover; no report filed",
    );
    expectUnused(mocks.submitGithubIssue, mocks.promptYesNo, mocks.openUrl);
  });

  it("writes post-upgrade JSON through the runtime before exiting with findings", async () => {
    const report = {
      probesRun: ["plugin.index_unavailable"],
      findings: [
        {
          level: "error",
          code: "plugin.index_unavailable",
          message: "missing index",
        },
      ],
    };
    mocks.runPostUpgradeProbes.mockResolvedValueOnce(report);
    const runtime = createDoctorRuntime();

    await runDoctor(runtime, { postUpgrade: true, json: true }, 1);

    expect(runtime.writeJson).toHaveBeenCalledWith(report, 2);
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it("passes an unconfigured update channel to post-upgrade probes", async () => {
    mocks.readSourceConfigBestEffort.mockResolvedValueOnce({
      update: { channel: undefined },
      plugins: { enabled: false, deny: ["whatsapp"] },
    });
    mocks.runPostUpgradeProbes.mockResolvedValueOnce({ probesRun: [], findings: [] });
    const runtime = createDoctorRuntime();

    await runDoctor(runtime, { postUpgrade: true });

    expect(mocks.readSourceConfigBestEffort).toHaveBeenCalledOnce();
    expect(mocks.runPostUpgradeProbes).toHaveBeenCalledWith(undefined);
    expect(runtime.log).toHaveBeenCalledWith("post-upgrade: no findings");
  });

  it("writes session sqlite JSON through the runtime before exiting cleanly", async () => {
    const report = createSessionReport("inspect");
    mocks.runDoctorSessionSqlite.mockResolvedValueOnce(report);
    const runtime = createDoctorRuntime();

    await runDoctor(runtime, { json: true, sessionSqlite: "inspect", sessionSqliteAgent: "main" });

    expect(mocks.runDoctorSessionSqlite).toHaveBeenCalledWith(
      { agent: "main", mode: "inspect" },
      undefined,
    );
    expect(mocks.withDoctorSqliteMaintenanceLock).not.toHaveBeenCalled();
    expect(runtime.writeJson).toHaveBeenCalledWith(report, 2);
  });

  it("holds exclusive state ownership for destructive session sqlite modes", async () => {
    const report = createSessionReport("restore");
    mocks.runDoctorSessionSqlite.mockResolvedValueOnce(report);
    const runtime = createDoctorRuntime();

    await runDoctor(runtime, { sessionSqlite: "restore", sessionSqliteAllAgents: true });

    expect(mocks.withDoctorSqliteMaintenanceLock).toHaveBeenCalledWith({
      env: process.env,
      operation: "session SQLite restore",
      reconcileHardlink: expect.any(Function),
      run: expect.any(Function),
    });
    expect(mocks.runDoctorSessionSqlite).toHaveBeenCalledWith(
      { allAgents: true, mode: "restore" },
      mocks.sqliteMaintenanceAuthority,
    );
    expect(mocks.runDoctorSessionSqlite.mock.calls[0]?.[1]).toBe(mocks.sqliteMaintenanceAuthority);
  });

  it("binds explicit destructive session stores to the maintenance lock", async () => {
    const report = createSessionReport("compact");
    mocks.runDoctorSessionSqlite.mockResolvedValueOnce(report);
    const runtime = createDoctorRuntime();
    const stateDir = path.resolve(process.env.OPENCLAW_STATE_DIR ?? ".openclaw");
    const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    const sqlitePath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");

    await runDoctor(runtime, { sessionSqlite: "compact", sessionSqliteStore: storePath });

    expect(mocks.withDoctorSqliteMaintenanceLock).toHaveBeenCalledWith({
      env: process.env,
      operation: "session SQLite compact",
      protectedPaths: [
        storePath,
        sqlitePath,
        `${sqlitePath}-wal`,
        `${sqlitePath}-shm`,
        `${sqlitePath}-journal`,
      ],
      run: expect.any(Function),
    });
  });

  it("rejects an explicit store combined with all agents before taking maintenance ownership", async () => {
    await expect(
      doctorCommand(undefined, {
        sessionSqlite: "compact",
        sessionSqliteAllAgents: true,
        sessionSqliteStore: path.resolve("stores", "{agentId}", "sessions.json"),
      }),
    ).rejects.toThrow("--store cannot be combined with --all-agents");

    expectUnused(mocks.withDoctorSqliteMaintenanceLock, mocks.runDoctorSessionSqlite);
  });

  it("writes shared-state sqlite compaction JSON through the runtime", async () => {
    const report = {
      mode: "compact",
      path: "/tmp/openclaw/state/openclaw.sqlite",
      skipped: false,
    };
    mocks.runDoctorStateSqliteCompact.mockResolvedValueOnce(report);
    const runtime = createDoctorRuntime();

    await runDoctor(runtime, { json: true, stateSqlite: "compact" });

    expect(mocks.runDoctorStateSqliteCompact).toHaveBeenCalledWith();
    expect(runtime.writeJson).toHaveBeenCalledWith(report, 2);
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it("creates a GitHub issue for --yes recovery without interactive input", async () => {
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
    const supportIssue = {
      body: "sanitized body",
      bodyPath: "/tmp/session.failure.md",
      title: "Session SQLite migration recovery report (run-1)",
    };
    const report = createRecoveryReport(supportIssue);
    mocks.runDoctorSessionSqlite.mockResolvedValueOnce(report);
    mocks.submitGithubIssue.mockResolvedValueOnce({
      status: "created",
      url: "https://github.com/openclaw/openclaw/issues/123",
    });
    const runtime = createDoctorRuntime();

    await runDoctor(runtime, { ...approvedRecoveryOptions, nonInteractive: true });

    expect(mocks.promptYesNo).not.toHaveBeenCalled();
    expect(mocks.submitGithubIssue).toHaveBeenCalledWith({
      body: supportIssue.body,
      browserFallback: {
        status: "available",
        url: "https://github.com/openclaw/openclaw/issues/new?title=run-1",
      },
      marker: `openclaw-report:${"a".repeat(64)}`,
      title: supportIssue.title,
    });
    expect(runtime.log).toHaveBeenCalledWith(
      "session-sqlite recover: created GitHub issue https://github.com/openclaw/openclaw/issues/123",
    );
    expect(mocks.clearSessionSqliteMigrationGithubIssueClaim).not.toHaveBeenCalled();
  });

  it("reconciles a prior recovery handoff without issuing a second create", async () => {
    const supportIssue = createSupportIssue("stable sanitized body");
    const report = createRecoveryReport(supportIssue);
    mocks.runDoctorSessionSqlite.mockResolvedValue(report);
    repeatReceipt(supportIssue.title);
    mocks.submitGithubIssue.mockResolvedValueOnce({
      reason: "creation-outcome-unknown",
      status: "outcome-unknown",
    });
    mocks.reconcileGithubIssue.mockResolvedValueOnce({ status: "not-found" });
    const runtime = createDoctorRuntime();

    await runDoctor(runtime);
    await runDoctor(runtime);

    expect(mocks.submitGithubIssue).toHaveBeenCalledOnce();
    expect(mocks.reconcileGithubIssue).toHaveBeenCalledOnce();
    expect(mocks.clearSessionSqliteMigrationGithubIssueClaim).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(
      "session-sqlite recover: A prior GitHub issue handoff may already have created this report; no duplicate was opened.",
    );
  });

  it.each([
    { claim: undefined, expectedMessage: "could not be saved", label: "cannot be saved" },
    {
      claim: {
        issue: {
          marker: `openclaw-report:${"b".repeat(64)}`,
          status: "attempted" as const,
          title: "Session SQLite migration recovery report (run-1)",
        },
        status: "existing" as const,
      },
      expectedMessage: "is inconsistent",
      label: "is inconsistent",
    },
  ])(
    "does not start transport when its durable receipt $label",
    async ({ claim, expectedMessage }) => {
      const { supportIssue, runtime } = recovery("stable sanitized body");
      mocks.claimSessionSqliteMigrationGithubIssue.mockReturnValueOnce(claim);

      await runDoctor(runtime);

      expectUnused(
        mocks.submitGithubIssue,
        mocks.reconcileGithubIssue,
        mocks.openUrl,
        mocks.clearSessionSqliteMigrationGithubIssueClaim,
      );
      expect(supportIssue).toMatchObject({
        github: { message: expect.stringContaining(expectedMessage), status: "failed" },
      });
    },
  );

  it("opens a sanitized fallback without logging its body or query URL", async () => {
    const { supportIssue, runtime } = recovery("private-report-text");
    mocks.submitGithubIssue.mockResolvedValueOnce({
      reason: "authentication-unavailable",
      status: "browser-fallback",
      url: fallbackUrl,
    });
    mocks.openUrl.mockResolvedValueOnce(true);

    await runDoctor(runtime);

    expect(mocks.openUrl).toHaveBeenCalledWith(fallbackUrl);
    expect(mocks.clearSessionSqliteMigrationGithubIssueClaim).not.toHaveBeenCalled();
    const output = runtime.log.mock.calls.flat().join("\n");
    expect(output).toContain("opened the sanitized fallback in your browser");
    expect(output).not.toContain("private-report-text");
    expect(output).not.toContain("issues/new?");
    expect((supportIssue as { github?: unknown }).github).toEqual({
      message: "GitHub authentication is unavailable.",
      status: "failed",
    });
  });

  it("retains the receipt after an indeterminate browser handoff", async () => {
    const supportIssue = createSupportIssue("private-report-text");
    const report = createRecoveryReport(supportIssue);
    mocks.runDoctorSessionSqlite.mockResolvedValue(report);
    repeatReceipt(supportIssue.title);
    mocks.submitGithubIssue.mockResolvedValueOnce({
      reason: "transport-unavailable",
      status: "browser-fallback",
      url: fallbackUrl,
    });
    mocks.openUrl.mockResolvedValueOnce(false);
    mocks.reconcileGithubIssue.mockResolvedValueOnce({ status: "not-found" });
    const runtime = createDoctorRuntime();

    const options = { ...approvedRecoveryOptions, json: true };

    await runDoctor(runtime, options);
    await runDoctor(runtime, options);

    expect(mocks.submitGithubIssue).toHaveBeenCalledOnce();
    expect(mocks.openUrl).toHaveBeenCalledWith(fallbackUrl);
    expect(mocks.reconcileGithubIssue).toHaveBeenCalledOnce();
    expect(mocks.clearSessionSqliteMigrationGithubIssueClaim).not.toHaveBeenCalled();
    expect(runtime.log).not.toHaveBeenCalled();
    expect((supportIssue as { github?: unknown }).github).toEqual({
      message:
        "A prior GitHub issue handoff may already have created this report; no duplicate was opened.",
      status: "failed",
    });
    expect(runtime.writeJson).toHaveBeenCalledTimes(2);
    expect(runtime.writeJson).toHaveBeenCalledWith(report, 2);
    const jsonOutput = JSON.stringify(runtime.writeJson.mock.calls);
    expect(jsonOutput).toContain("private-report-text");
    expect(jsonOutput).not.toContain("issues/new?");
    expect(jsonOutput).not.toContain(fallbackUrl);
  });

  it("releases the receipt when browser preflight proves no opener is available", async () => {
    const { runtime } = recovery("private-report-text");
    mocks.submitGithubIssue.mockResolvedValueOnce({
      reason: "transport-unavailable",
      status: "browser-fallback",
      url: fallbackUrl,
    });
    mocks.detectBrowserOpenSupport.mockResolvedValueOnce({ ok: false, reason: "no-display" });

    await runDoctor(runtime);

    expect(mocks.openUrl).not.toHaveBeenCalled();
    expectClaimReleased();
    expect(runtime.log.mock.calls.flat().join("\n")).toContain(
      "browser handoff unavailable; the sanitized report remains available in the recovery result",
    );
  });

  it("keeps an oversized fallback in the recovery result without opening a browser", async () => {
    const { supportIssue, runtime } = recovery("private-report-text".repeat(1_000));
    mocks.submitGithubIssue.mockResolvedValueOnce({
      cause: "authentication-unavailable",
      reason: "fallback-url-too-long",
      status: "fallback-unavailable",
    });

    await runDoctor(runtime);

    expect(mocks.openUrl).not.toHaveBeenCalled();
    expectClaimReleased();
    expect(supportIssue.body).toContain("private-report-text");
    const output = runtime.log.mock.calls.flat().join("\n");
    expect(output).toContain("too large for a safe browser fallback");
    expect(output).not.toContain("private-report-text");
    expect(output).not.toContain("openclaw ");
    expect((supportIssue as { github?: unknown }).github).toEqual({
      message:
        "GitHub issue creation is unavailable, and this report is too large for a safe browser fallback.",
      status: "failed",
    });
  });

  it.each([
    { label: "JSON output", json: true, nonInteractive: false, isTTY: true },
    { label: "noninteractive mode", json: false, nonInteractive: true, isTTY: true },
    { label: "redirected input", json: false, nonInteractive: false, isTTY: false },
  ])("records why GitHub issue creation is skipped for $label", async (mode) => {
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: mode.isTTY });
    const { report, runtime } = recovery();

    await runDoctor(runtime, {
      json: mode.json,
      nonInteractive: mode.nonInteractive,
      sessionSqlite: "recover",
      sessionSqliteGithubIssue: true,
    });

    expectUnused(mocks.promptYesNo, mocks.submitGithubIssue, mocks.openUrl);
    expect(report.supportIssue?.github).toEqual({
      message: "GitHub issue creation skipped: noninteractive recovery requires --yes.",
      status: "skipped",
    });
    if (mode.json) {
      expect(runtime.log).not.toHaveBeenCalled();
      expect(runtime.writeJson).toHaveBeenCalledWith(report, 2);
    } else {
      expect(runtime.log).toHaveBeenCalledWith(
        `session-sqlite recover: ${report.supportIssue?.github?.message}`,
      );
    }
    expect(JSON.stringify(runtime.writeJson.mock.calls)).not.toContain("issues/new?");
  });

  it("does not start issue transport when the operator declines", async () => {
    const { report, runtime } = recovery();
    mocks.promptYesNo.mockResolvedValueOnce(false);

    await runDoctor(runtime, { sessionSqlite: "recover", sessionSqliteGithubIssue: true });

    expect(mocks.promptYesNo).toHaveBeenCalledWith(
      "Create a GitHub issue in openclaw/openclaw with the sanitized recovery report?",
      false,
    );
    expectUnused(mocks.submitGithubIssue, mocks.openUrl);
    expect(report.supportIssue?.github).toEqual({
      message: "GitHub issue creation skipped: confirmation was declined.",
      status: "skipped",
    });
  });
});
