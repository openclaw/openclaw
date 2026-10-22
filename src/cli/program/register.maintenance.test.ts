import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as nodeSqlite from "../../../node-sqlite.mjs";
import { runDoctorLintCli as runDoctorLintCliEntry } from "../../commands/doctor-lint.js";
import { parseReleasedDoctorLintReport } from "../../infra/test-fixtures/update-doctor-lint.v2026-9-5.js";
import { ExitError } from "../../runtime.js";
import { UpdateSchemaRefusalError } from "../../state/openclaw-update-schema-refusal.js";
import { withCliTty } from "../run-main.bare-root.test-support.js";
import { expectNoCalls } from "./program.test-helpers.js";
import { registerMaintenanceCommands } from "./register.maintenance.js";

const mocks = vi.hoisted(() => ({
  doctorCommand: vi.fn(),
  prepareStartupClientCredentials: vi.fn(),
  triageCommand: vi.fn(),
  dashboardCommand: vi.fn(),
  resetCommand: vi.fn(),
  uninstallCommand: vi.fn(),
  runtime: { log: vi.fn(), error: vi.fn(), writeJson: vi.fn(), exit: vi.fn() },
  runDoctorLintCli: vi.fn(),
}));

const { doctorCommand, triageCommand, dashboardCommand, resetCommand, uninstallCommand, runtime } =
  mocks;
const runDoctorLintCli = vi.mocked(runDoctorLintCliEntry);

// mock-isolation: Verify maintenance dispatch without executing repair, reset, or uninstall operations.
vi.mock("../../commands/doctor.js", () => ({ doctorCommand: mocks.doctorCommand }));
// mock-isolation: Verify the narrow credential dispatch without accessing operator credentials.
vi.mock("../../commands/startup-client-credentials.js", () => ({
  prepareStartupClientCredentials: mocks.prepareStartupClientCredentials,
}));
// mock-isolation: Verify maintenance dispatch without executing repair, reset, or uninstall operations.
vi.mock("../../commands/triage.js", () => ({ triageCommand: mocks.triageCommand }));
// mock-isolation: Verify maintenance dispatch without executing repair, reset, or uninstall operations.
vi.mock("../../commands/dashboard.js", () => ({ dashboardCommand: mocks.dashboardCommand }));
// mock-isolation: Verify maintenance dispatch without executing repair, reset, or uninstall operations.
vi.mock("../../commands/reset.js", () => ({ resetCommand: mocks.resetCommand }));
// mock-isolation: Verify maintenance dispatch without executing repair, reset, or uninstall operations.
vi.mock("../../commands/uninstall.js", () => ({ uninstallCommand: mocks.uninstallCommand }));

vi.mock("../../commands/doctor-lint.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../commands/doctor-lint.js")>()),
  runDoctorLintCli: mocks.runDoctorLintCli,
}));

vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
  defaultRuntime: mocks.runtime,
}));

function jsonFailure(message: string) {
  return { ok: false, error: { type: "cli_error", message } };
}

function expectDoctorOptions(options: object) {
  expect(doctorCommand.mock.calls).toEqual([
    [runtime, expect.objectContaining(options), undefined],
  ]);
  expectNoCalls(runDoctorLintCli);
  expect(runtime.exit).toHaveBeenCalledWith(0);
}

function expectFailure(message: string, json: boolean) {
  expect(json ? runtime.writeJson : runtime.error).toHaveBeenCalledWith(
    json ? jsonFailure(message) : message,
  );
  expectNoCalls(json ? runtime.error : runtime.writeJson);
  expect(runtime.exit).toHaveBeenCalledWith(2);
}

async function runCli(input: string) {
  const args = input.trim().split(/\s+/);
  const program = new Command();
  registerMaintenanceCommands(program);
  const previousArgv = process.argv;
  process.argv = [process.execPath, "openclaw", ...args];
  try {
    await program.parseAsync(args, { from: "user" });
  } catch (error) {
    if (!(error instanceof ExitError)) {
      throw error;
    }
    runtime.exit(error.code);
  } finally {
    process.argv = previousArgv;
  }
}

beforeEach(() => vi.resetAllMocks());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("registered maintenance commands", () => {
  it("keeps plain doctor read-only on unsupported Node", async () => {
    vi.stubGlobal("process", {
      ...process,
      versions: { ...process.versions, bun: undefined, node: "22.23.2" },
    });
    const capabilities = await nodeSqlite.detectCurrentSqliteCapabilities();
    vi.spyOn(nodeSqlite, "detectCurrentSqliteCapabilities").mockResolvedValue({
      ...capabilities,
      text: false,
    });
    runDoctorLintCli.mockResolvedValue(1);
    await runCli("doctor");
    expect(runDoctorLintCli).toHaveBeenCalledOnce();
    expect(doctorCommand).not.toHaveBeenCalled();
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it.each([
    ["--fix --force", true, undefined],
    ["--fix --full-integrity-check", false, true],
  ] as const)("dispatches Doctor mutation posture %s", async (args, force, fullIntegrityCheck) => {
    await runCli(`doctor ${args}`);
    expectDoctorOptions({
      repair: true,
      force,
      yes: false,
      workspaceSuggestions: true,
      allowExec: false,
      nonInteractive: false,
    });
    expect(doctorCommand.mock.calls[0]?.[1].fullIntegrityCheck).toBe(fullIntegrityCheck);
  });

  it.each([
    ["--repair", false],
    ["--fix", false],
    ["--repair", true],
  ] as const)(
    "dispatches only client credential preparation with %s (json=%s)",
    async (repair, json) => {
      await runCli(
        `doctor --client-credentials ${repair} --non-interactive ${json ? "--json" : ""}`,
      );
      expect(mocks.prepareStartupClientCredentials.mock.calls).toEqual([
        [{ env: process.env, runtime }],
      ]);
      expectNoCalls(doctorCommand, runDoctorLintCli, runtime.log, runtime.error);
      if (json) {
        expect(runtime.writeJson).toHaveBeenCalledExactlyOnceWith({ ok: true });
      } else {
        expectNoCalls(runtime.writeJson);
      }
      expect(runtime.exit).toHaveBeenCalledWith(0);
    },
  );

  it.each([
    ["", "requires --repair (or --fix) and --non-interactive."],
    ["--repair", "requires --repair (or --fix) and --non-interactive."],
    ["--non-interactive", "requires --repair (or --fix) and --non-interactive."],
    ...["--lint", "--post-upgrade", "--session-sqlite inspect", "--force", "--yes"].map(
      (option) => [
        `--repair --non-interactive ${option}`,
        "can only be combined with --repair (or --fix), --non-interactive, and --json.",
      ],
    ),
  ])("rejects ambiguous credential preparation options %s", async (options, reason) => {
    await runCli(`doctor --client-credentials ${options} --json`);
    expectNoCalls(mocks.prepareStartupClientCredentials, doctorCommand, runDoctorLintCli);
    expectFailure(`doctor --client-credentials ${reason}`, true);
  });

  it.each([
    ["--state-sqlite compact", doctorCommand, "maintenance failed"],
    ["--lint", runDoctorLintCli, "lint failed"],
    [
      "--client-credentials --repair --non-interactive",
      mocks.prepareStartupClientCredentials,
      "credential preparation failed",
    ],
  ] as const)("redacts credentials in %s JSON failures", async (args, handler, message) => {
    const token = "sk-abcdefghijklmnopqrstuv";
    handler.mockRejectedValueOnce(new Error(`${message}: Authorization: Bearer ${token}`));
    await runCli(`doctor ${args} --json`);
    const expected = jsonFailure(expect.stringContaining(`${message}: Authorization: Bearer`));
    expect(runtime.writeJson).toHaveBeenCalledWith(
      args === "--lint" ? expect.objectContaining(expected) : expected,
    );
    if (args === "--lint") {
      expect(
        parseReleasedDoctorLintReport(JSON.stringify(runtime.writeJson.mock.calls.at(-1)?.[0])),
      ).toMatchObject({
        ok: false,
        checksRun: 0,
        findings: [{ severity: "error", message: expect.stringContaining(message) }],
      });
    }
    expect(JSON.stringify(runtime.writeJson.mock.calls)).not.toContain(token);
    expectNoCalls(runtime.error);
    expect(runtime.exit).toHaveBeenCalledWith(2);
  });

  it("preserves structured recovery fields in Doctor JSON failures", async () => {
    doctorCommand.mockRejectedValueOnce(
      new UpdateSchemaRefusalError([], "2026.9.2", { targetVersion: "2026.9.4" }),
    );
    await runCli("doctor --state-sqlite compact --json");
    expect(runtime.writeJson).toHaveBeenCalledExactlyOnceWith({
      ok: false,
      error: {
        type: "cli_error",
        message: expect.stringContaining("Doctor refused update-time schema repair"),
        code: "update-schema-bump-unfenced",
        databases: [],
        updaterVersion: "2026.9.2",
        targetVersion: "2026.9.4",
        commands: expect.arrayContaining(["openclaw doctor --fix"]),
      },
    });
    expect(runtime.exit).toHaveBeenCalledWith(2);
  });

  it("dispatches session SQLite recover with its selectors", async () => {
    await runCli(
      "doctor --session-sqlite recover --session-sqlite-agent main --session-sqlite-store /tmp/sessions.json --json --github-issue --yes",
    );
    expectDoctorOptions({
      sessionSqlite: "recover",
      sessionSqliteAgent: "main",
      sessionSqliteStore: "/tmp/sessions.json",
      json: true,
      sessionSqliteGithubIssue: true,
      yes: true,
    });
  });

  const readOnlyConflict = (mode: string, option: string) =>
    `doctor ${mode} runs read-only lint checks and cannot be combined with ${option}.`;
  const errors = {
    state: "doctor shared-state SQLite maintenance can only be combined with --json.",
    orphan:
      "doctor session SQLite options require --session-sqlite. Use `openclaw doctor --session-sqlite dry-run ...`.",
    operations:
      "doctor operations are mutually exclusive: choose one of --lint, --fix/--repair, --post-upgrade, --state-sqlite, or --session-sqlite.",
    github: "--github-issue requires --session-sqlite recover.",
    selectors: "doctor lint options require --lint. Use `openclaw doctor --lint ...`.",
    repair: readOnlyConflict("--lint", "--repair, --fix, or --force"),
    yes: readOnlyConflict("--lint", "--yes"),
    token: readOnlyConflict("--lint", "--generate-gateway-token"),
    session: readOnlyConflict("--lint", "--session-sqlite recover"),
    json: readOnlyConflict("--json", "--repair, --fix, or --force"),
  };
  it.each([
    ["--state-sqlite compact --lint --json", "state", true],
    ["--state-sqlite compact --client-credentials --json", "state", true],
    ["--session-sqlite-agent main", "orphan", false],
    ["--lint --post-upgrade --json", "operations", true],
    ["--session-sqlite inspect --github-issue --json", "github", true],
    ["--only b --json", "selectors", true],
    ["--lint --repair", "repair", true],
    ["--lint --yes", "yes", true],
    ["--lint --generate-gateway-token", "token", true],
    ["--lint --session-sqlite recover", "session", true],
    ["--json --repair", "json", true],
  ] as const)("rejects incompatible Doctor options %s", async (args, error, json) => {
    const message = errors[error];
    await runCli(`doctor ${args}`);
    expectNoCalls(doctorCommand, runDoctorLintCli);
    expectFailure(message, json);
  });

  it.each([true, false])("runs lint with explicit=%s exit policy", async (explicit) => {
    runDoctorLintCli.mockResolvedValueOnce(1);
    await runCli(
      explicit
        ? "doctor --lint --json --severity-min error --all --skip a --only b --allow-exec"
        : "doctor --json",
    );
    expect(runDoctorLintCli).toHaveBeenCalledExactlyOnceWith(runtime, {
      json: true,
      severityMin: explicit ? "error" : undefined,
      includeAllChecks: explicit,
      skipIds: explicit ? ["a"] : [],
      onlyIds: explicit ? ["b"] : [],
      allowExec: explicit,
      deep: false,
    });
    expect(doctorCommand).not.toHaveBeenCalled();
    expect(runtime.exit).toHaveBeenCalledWith(explicit ? 1 : 0);
  });

  it("keeps interactive lint failures on stderr", async () => {
    runDoctorLintCli.mockRejectedValueOnce(new Error("lint failed"));
    await withCliTty(true, () => runCli("doctor --lint"));
    expectFailure("lint failed", false);
  });

  it.each([
    [
      "triage --json --no-export --non-interactive --update-result /tmp/failure.json",
      triageCommand,
      {
        json: true,
        noExport: true,
        run: false,
        nonInteractive: true,
        updateResult: "/tmp/failure.json",
      },
    ],
    [
      "triage --agent qwen",
      triageCommand,
      { json: false, noExport: false, run: false, agent: "qwen" },
    ],
    ["dashboard --no-open --json", dashboardCommand, { noOpen: true, json: true }],
    [
      "reset --scope full --yes --non-interactive --dry-run",
      resetCommand,
      { scope: "full", yes: true, nonInteractive: true, dryRun: true },
    ],
    [
      "uninstall --all --yes --non-interactive --dry-run",
      uninstallCommand,
      { all: true, yes: true, nonInteractive: true, dryRun: true },
    ],
  ] as const)("dispatches %s", async (args, command, options) => {
    await runCli(args);
    expect(command).toHaveBeenCalledExactlyOnceWith(
      runtime,
      command === triageCommand ? options : expect.objectContaining(options),
    );
  });

  it.each([
    ["--json --run", true, "triage --json cannot be combined with --run."],
    ["--non-interactive --run", false, "triage --non-interactive cannot be combined with --run."],
    ["--run --agent codex", false, "triage --run cannot be combined with --agent."],
    [
      "--agent unknown-agent",
      false,
      "Invalid --agent. Use agy, claude, codex, cursor, grok, kimi, muse, opencode, pi, qwen.",
    ],
  ] as const)("rejects incompatible triage options %s", async (args, json, message) => {
    await runCli(`triage ${args}`);
    expectNoCalls(triageCommand);
    expectFailure(message, json);
  });
});
