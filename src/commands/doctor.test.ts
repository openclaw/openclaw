import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DoctorSessionSqliteReport } from "./doctor-session-sqlite.js";

const marker = `openclaw-report:${"a".repeat(64)}`;
const supportTitle = "Session SQLite migration recovery report (run-1)";
const retryWarning =
  "A prior GitHub issue handoff may already have created this report; no duplicate was opened.";

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

vi.mock("./doctor-post-upgrade.js", () => ({ runPostUpgradeProbes: mocks.runPostUpgradeProbes }));

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

vi.mock("../cli/prompt.js", () => ({ promptYesNo: mocks.promptYesNo }));

vi.mock("../plugins/installed-plugin-index-store-path.js", () => ({
  resolveInstalledPluginIndexStorePath: mocks.resolveInstalledPluginIndexStorePath,
}));

const { doctorCommand } = await import("./doctor.js");

const createDoctorRuntime = () => ({
  log: vi.fn(),
  error: vi.fn(),
  writeStdout: vi.fn(),
  writeJson: vi.fn(),
  exit: vi.fn((code: number) => {
    throw new Error(`exit:${code}`);
  }),
});

function createSessionReport(mode: DoctorSessionSqliteReport["mode"]): DoctorSessionSqliteReport {
  return {
    mode,
    ...(mode === "recover"
      ? { migrationRun: { manifestPath: "/tmp/run-1.json", runId: "run-1" } }
      : {}),
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
  return { body, title: supportTitle };
}

function recoveryFixture(body = "sanitized body", repeat = false) {
  const supportIssue = createSupportIssue(body);
  const report = { ...createSessionReport("recover"), supportIssue };
  if (repeat) {
    mocks.runDoctorSessionSqlite.mockResolvedValue(report);
    const issue = { marker, status: "attempted", title: supportIssue.title };
    mocks.claimSessionSqliteMigrationGithubIssue
      .mockReturnValueOnce({ issue, status: "claimed" })
      .mockReturnValueOnce({ issue, status: "existing" });
  } else {
    mocks.runDoctorSessionSqlite.mockResolvedValueOnce(report);
  }
  return { supportIssue, report };
}

function expectUnsentReceiptReleased() {
  expect(mocks.clearSessionSqliteMigrationGithubIssueClaim).toHaveBeenCalledWith(
    "/tmp/run-1.json",
    marker,
    expect.objectContaining({ assertCurrent: expect.any(Function) }),
  );
}

function expectUncalled(...functions: Array<{ mock: { calls: unknown[][] } }>) {
  for (const fn of functions) {
    expect(fn.mock.calls).toEqual([]);
  }
}

const fallbackUrl =
  "https://github.com/openclaw/openclaw/issues/new?title=run-1&body=private-report-text";

let runtime: ReturnType<typeof createDoctorRuntime>;
async function runDoctor(options: Parameters<typeof doctorCommand>[1], exitCode = 0) {
  await expect(doctorCommand(runtime, options)).rejects.toThrow(`exit:${exitCode}`);
  expect(runtime.exit).toHaveBeenCalledWith(exitCode);
}

function expectJson(report: unknown) {
  expect(runtime.writeJson).toHaveBeenCalledWith(report, 2);
  expect(runtime.log).not.toHaveBeenCalled();
}

async function repeatRecovery(
  options: Parameters<typeof doctorCommand>[1] = approvedRecoveryOptions,
) {
  await runDoctor(options);
  await runDoctor(options);
  expect(mocks.submitGithubIssue).toHaveBeenCalledOnce();
  expect(mocks.reconcileGithubIssue).toHaveBeenCalledOnce();
  expect(mocks.clearSessionSqliteMigrationGithubIssueClaim).not.toHaveBeenCalled();
}

const approvedRecoveryOptions = {
  sessionSqlite: "recover",
  sessionSqliteGithubIssue: true,
  yes: true,
} as const;

const stdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");

afterEach(() => {
  if (stdinIsTTY) {
    Object.defineProperty(process.stdin, "isTTY", stdinIsTTY);
  } else {
    Reflect.deleteProperty(process.stdin, "isTTY");
  }
});

beforeEach(() => {
  runtime = createDoctorRuntime();
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
  mocks.runDoctorSessionSqlite.mockResolvedValueOnce(createSessionReport("recover"));
  await runDoctor(approvedRecoveryOptions);
  expect(runtime.log).toHaveBeenCalledWith(
    "session-sqlite recover: nothing to recover; no report filed",
  );
  expectUncalled(mocks.submitGithubIssue, mocks.promptYesNo, mocks.openUrl);
});

it("writes post-upgrade JSON through the runtime before exiting with findings", async () => {
  const report = {
    probesRun: ["plugin.index_unavailable"],
    findings: [{ level: "error", code: "plugin.index_unavailable", message: "missing index" }],
  };
  mocks.runPostUpgradeProbes.mockResolvedValueOnce(report);
  await runDoctor({ postUpgrade: true, json: true }, 1);
  expectJson(report);
});

it("passes an unconfigured update channel to post-upgrade probes", async () => {
  mocks.readSourceConfigBestEffort.mockResolvedValueOnce({
    update: { channel: undefined },
    plugins: { enabled: false, deny: ["whatsapp"] },
  });
  mocks.runPostUpgradeProbes.mockResolvedValueOnce({ probesRun: [], findings: [] });
  await runDoctor({ postUpgrade: true });
  expect(mocks.readSourceConfigBestEffort).toHaveBeenCalledOnce();
  expect(mocks.runPostUpgradeProbes).toHaveBeenCalledWith({ updateChannel: undefined });
  expect(runtime.log).toHaveBeenCalledWith("post-upgrade: no findings");
});

it("writes session sqlite JSON through the runtime before exiting cleanly", async () => {
  const report = createSessionReport("inspect");
  mocks.runDoctorSessionSqlite.mockResolvedValueOnce(report);
  await runDoctor({ json: true, sessionSqlite: "inspect", sessionSqliteAgent: "main" });
  expect(mocks.runDoctorSessionSqlite).toHaveBeenCalledWith(
    { agent: "main", mode: "inspect" },
    undefined,
  );
  expect(mocks.withDoctorSqliteMaintenanceLock).not.toHaveBeenCalled();
  expect(runtime.writeJson).toHaveBeenCalledWith(report, 2);
});

it("holds exclusive state ownership for destructive session sqlite modes", async () => {
  mocks.runDoctorSessionSqlite.mockResolvedValueOnce(createSessionReport("restore"));
  await runDoctor({ sessionSqlite: "restore", sessionSqliteAllAgents: true });
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
  mocks.runDoctorSessionSqlite.mockResolvedValueOnce(createSessionReport("compact"));
  const stateDir = path.resolve(process.env.OPENCLAW_STATE_DIR ?? ".openclaw");
  const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
  const sqlitePath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
  await runDoctor({ sessionSqlite: "compact", sessionSqliteStore: storePath });
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
  expectUncalled(mocks.withDoctorSqliteMaintenanceLock, mocks.runDoctorSessionSqlite);
});

it("writes shared-state sqlite compaction JSON through the runtime", async () => {
  const report = { mode: "compact", path: "/tmp/openclaw.sqlite", reclaimedBytes: 12_288 };
  mocks.runDoctorStateSqliteCompact.mockResolvedValueOnce(report);
  await runDoctor({ json: true, stateSqlite: "compact" });
  expect(mocks.runDoctorStateSqliteCompact).toHaveBeenCalledWith();
  expectJson(report);
});

it("creates a GitHub issue for --yes recovery without interactive input", async () => {
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
  const { supportIssue } = recoveryFixture();
  supportIssue.bodyPath = "/tmp/session.failure.md";
  mocks.submitGithubIssue.mockResolvedValueOnce({
    status: "created",
    url: "https://github.com/openclaw/openclaw/issues/123",
  });
  await runDoctor({ ...approvedRecoveryOptions, nonInteractive: true });
  expect(mocks.promptYesNo).not.toHaveBeenCalled();
  expect(mocks.submitGithubIssue).toHaveBeenCalledWith({
    body: supportIssue.body,
    browserFallback: {
      status: "available",
      url: "https://github.com/openclaw/openclaw/issues/new?title=run-1",
    },
    marker,
    title: supportIssue.title,
  });
  expect(runtime.log).toHaveBeenCalledWith(
    "session-sqlite recover: created GitHub issue https://github.com/openclaw/openclaw/issues/123",
  );
  expect(mocks.clearSessionSqliteMigrationGithubIssueClaim).not.toHaveBeenCalled();
});

it("reconciles a prior recovery handoff without issuing a second create", async () => {
  recoveryFixture("stable sanitized body", true);
  mocks.submitGithubIssue.mockResolvedValueOnce({
    reason: "creation-outcome-unknown",
    status: "outcome-unknown",
  });
  await repeatRecovery();
  expect(runtime.log).toHaveBeenCalledWith(`session-sqlite recover: ${retryWarning}`);
});

it.each([
  { claim: undefined, expectedMessage: "could not be saved", label: "cannot be saved" },
  {
    claim: {
      issue: {
        marker: `openclaw-report:${"b".repeat(64)}`,
        status: "attempted" as const,
        title: supportTitle,
      },
      status: "existing" as const,
    },
    expectedMessage: "is inconsistent",
    label: "is inconsistent",
  },
])(
  "does not start transport when its durable receipt $label",
  async ({ claim, expectedMessage }) => {
    const { supportIssue } = recoveryFixture("stable sanitized body");
    mocks.claimSessionSqliteMigrationGithubIssue.mockReturnValueOnce(claim);

    await runDoctor(approvedRecoveryOptions);

    expectUncalled(
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

it("retains the receipt after an indeterminate browser handoff", async () => {
  const { supportIssue, report } = recoveryFixture("private-report-text", true);
  mocks.submitGithubIssue.mockResolvedValueOnce({
    reason: "transport-unavailable",
    status: "browser-fallback",
    url: fallbackUrl,
  });
  mocks.openUrl.mockResolvedValueOnce(false);
  await repeatRecovery({ ...approvedRecoveryOptions, json: true });
  expect(mocks.openUrl).toHaveBeenCalledWith(fallbackUrl);
  expect(supportIssue.github).toEqual({ message: retryWarning, status: "failed" });
  expect(runtime.writeJson).toHaveBeenCalledTimes(2);
  expectJson(report);
  const jsonOutput = JSON.stringify(runtime.writeJson.mock.calls);
  expect(jsonOutput).toContain("private-report-text");
  expect(jsonOutput).not.toContain("issues/new?");
  expect(jsonOutput).not.toContain(fallbackUrl);
});

type FallbackCase = {
  outcome: "opened" | "no-display" | "oversized";
  message: string;
  transport: Awaited<ReturnType<typeof import("../infra/github-issue.js").submitGithubIssue>>;
};
it.each<FallbackCase>`
  outcome         | message                                                                                         | transport
  ${"opened"}     | ${"opened the sanitized fallback in your browser"}                                              | ${{ reason: "authentication-unavailable", status: "browser-fallback", url: fallbackUrl }}
  ${"no-display"} | ${"browser handoff unavailable; the sanitized report remains available in the recovery result"} | ${{ reason: "transport-unavailable", status: "browser-fallback", url: fallbackUrl }}
  ${"oversized"}  | ${"too large for a safe browser fallback"}                                                      | ${{ cause: "authentication-unavailable", reason: "fallback-url-too-long", status: "fallback-unavailable" }}
`(
  "handles $outcome without disclosing private report text",
  async ({ outcome, message, transport }) => {
    const { supportIssue } = recoveryFixture(
      "private-report-text".repeat(outcome === "oversized" ? 1_000 : 1),
    );
    mocks.submitGithubIssue.mockResolvedValueOnce(transport);
    if (outcome === "opened") {
      mocks.openUrl.mockResolvedValueOnce(true);
    } else if (outcome === "no-display") {
      mocks.detectBrowserOpenSupport.mockResolvedValueOnce({ ok: false, reason: "no-display" });
    }
    await runDoctor(approvedRecoveryOptions);
    const output = runtime.log.mock.calls.flat().join("\n");
    expect(output).toContain(message);
    expect(output).not.toContain("private-report-text");
    if (outcome === "opened") {
      expect(mocks.openUrl).toHaveBeenCalledWith(fallbackUrl);
      expect(mocks.clearSessionSqliteMigrationGithubIssueClaim).not.toHaveBeenCalled();
      expect(output).not.toContain("issues/new?");
      expect(supportIssue.github).toEqual({
        message: "GitHub authentication is unavailable.",
        status: "failed",
      });
    } else {
      expect(mocks.openUrl).not.toHaveBeenCalled();
      expectUnsentReceiptReleased();
      if (outcome === "oversized") {
        expect(supportIssue.body).toContain("private-report-text");
        expect(output).not.toContain("openclaw ");
        expect(supportIssue.github).toEqual({
          message:
            "GitHub issue creation is unavailable, and this report is too large for a safe browser fallback.",
          status: "failed",
        });
      }
    }
  },
);

it.each([
  { label: "JSON output", json: true, nonInteractive: false, isTTY: true },
  { label: "noninteractive mode", json: false, nonInteractive: true, isTTY: true },
  { label: "redirected input", json: false, nonInteractive: false, isTTY: false },
  { label: "declined confirmation", json: false, nonInteractive: false, isTTY: true },
])("records why GitHub issue creation is skipped for $label", async (mode) => {
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: mode.isTTY });
  const declined = mode.label === "declined confirmation";
  if (declined) {
    mocks.promptYesNo.mockResolvedValueOnce(false);
  }
  const { report } = recoveryFixture();
  await runDoctor({
    json: mode.json,
    nonInteractive: mode.nonInteractive,
    sessionSqlite: "recover",
    sessionSqliteGithubIssue: true,
  });
  expectUncalled(mocks.submitGithubIssue, mocks.openUrl);
  if (declined) {
    expect(mocks.promptYesNo).toHaveBeenCalledWith(
      "Create a GitHub issue in openclaw/openclaw with the sanitized recovery report?",
      false,
    );
  } else {
    expect(mocks.promptYesNo).not.toHaveBeenCalled();
  }
  expect(report.supportIssue?.github).toEqual({
    message: declined
      ? "GitHub issue creation skipped: confirmation was declined."
      : "GitHub issue creation skipped: noninteractive recovery requires --yes.",
    status: "skipped",
  });
  if (mode.json) {
    expectJson(report);
  } else {
    expect(runtime.log).toHaveBeenCalledWith(
      `session-sqlite recover: ${report.supportIssue?.github?.message}`,
    );
  }
  expect(JSON.stringify(runtime.writeJson.mock.calls)).not.toContain("issues/new?");
});
