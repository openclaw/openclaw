import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as nodeSqlite from "../../../node-sqlite.mjs";
import { runDoctorLintCli as runDoctorLintCliEntry } from "../../commands/doctor-lint.js";
import { parseReleasedDoctorLintReport } from "../../infra/test-fixtures/update-doctor-lint.v2026-9-5.js";
import { ExitError } from "../../runtime.js";
import { UpdateSchemaRefusalError } from "../../state/openclaw-update-schema-refusal.js";
import { registerMaintenanceCommands } from "./register.maintenance.js";

const mocks = vi.hoisted(() => ({
  doctorCommand: vi.fn(),
  triageCommand: vi.fn(),
  dashboardCommand: vi.fn(),
  resetCommand: vi.fn(),
  uninstallCommand: vi.fn(),
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    writeJson: vi.fn(),
    exit: vi.fn(),
  },
  runDoctorLintCli: vi.fn(),
}));

const { doctorCommand, triageCommand, dashboardCommand, resetCommand, uninstallCommand, runtime } =
  mocks;
const runDoctorLintCli = vi.mocked(runDoctorLintCliEntry);

vi.mock("../../commands/doctor.js", () => ({
  doctorCommand: mocks.doctorCommand,
}));

vi.mock("../../commands/triage.js", () => ({
  triageCommand: mocks.triageCommand,
}));

vi.mock("../../commands/dashboard.js", () => ({
  dashboardCommand: mocks.dashboardCommand,
}));

vi.mock("../../commands/reset.js", () => ({
  resetCommand: mocks.resetCommand,
}));

vi.mock("../../commands/uninstall.js", () => ({
  uninstallCommand: mocks.uninstallCommand,
}));

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

async function runCli(args: string[]) {
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

async function withTerminal(action: () => Promise<void>) {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  try {
    await action();
  } finally {
    if (descriptor) {
      Object.defineProperty(process.stdout, "isTTY", descriptor);
    } else {
      Reflect.deleteProperty(process.stdout, "isTTY");
    }
  }
}

beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.restoreAllMocks());

describe("registered maintenance commands", () => {
  it("keeps plain doctor read-only on unsupported Node", async () => {
    vi.spyOn(process.versions, "node", "get").mockReturnValue("22.23.2");
    const capabilities = await nodeSqlite.detectCurrentSqliteCapabilities();
    vi.spyOn(nodeSqlite, "detectCurrentSqliteCapabilities").mockResolvedValue({
      ...capabilities,
      text: false,
    });
    runDoctorLintCli.mockResolvedValue(1);
    await runCli(["doctor"]);
    expect(runDoctorLintCli).toHaveBeenCalledOnce();
    expect(doctorCommand).not.toHaveBeenCalled();
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it.each([
    { args: [], repair: false, force: false, yes: false },
    { args: ["--fix", "--force"], repair: true, force: true, yes: false },
    { args: ["--repair"], repair: true, force: false, yes: false },
    {
      args: "--yes --allow-exec --non-interactive --no-workspace-suggestions".split(" "),
      repair: false,
      force: false,
      yes: true,
    },
    { args: ["--generate-gateway-token"], repair: false, force: false, yes: false },
  ])("dispatches Doctor mutation posture $args", async ({ args, repair, force, yes }) => {
    await runCli(["doctor", ...args]);
    expect(doctorCommand).toHaveBeenCalledExactlyOnceWith(
      runtime,
      expect.objectContaining({
        repair,
        force,
        yes,
        workspaceSuggestions: !args.includes("--no-workspace-suggestions"),
        allowExec: args.includes("--allow-exec"),
        nonInteractive: args.includes("--non-interactive"),
      }),
      undefined,
    );
    expect(runDoctorLintCli).not.toHaveBeenCalled();
    expect(runtime.exit).toHaveBeenCalledWith(0);
  });

  it("redacts credentials in machine-mode Doctor failures", async () => {
    const token = "sk-abcdefghijklmnopqrstuv";
    doctorCommand.mockRejectedValueOnce(
      new Error(`maintenance failed: Authorization: Bearer ${token}`),
    );
    await runCli("doctor --state-sqlite compact --json".split(" "));
    expect(runtime.writeJson).toHaveBeenCalledWith(
      jsonFailure(expect.stringContaining("maintenance failed: Authorization: Bearer")),
    );
    expect(JSON.stringify(runtime.writeJson.mock.calls)).not.toContain(token);
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).toHaveBeenCalledWith(2);
  });

  it("preserves already-reported Doctor exits", async () => {
    doctorCommand.mockRejectedValueOnce(new ExitError(2));
    await runCli(["doctor", "--post-upgrade", "--json"]);
    expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(2);
    expect(runtime.writeJson).not.toHaveBeenCalled();
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("preserves structured recovery fields in Doctor JSON failures", async () => {
    doctorCommand.mockRejectedValueOnce(
      new UpdateSchemaRefusalError([], "2026.9.2", { targetVersion: "2026.9.4" }),
    );
    await runCli("doctor --state-sqlite compact --json".split(" "));
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

  it.each("inspect dry-run import validate compact restore recover".split(" "))(
    "dispatches session SQLite %s with its selectors",
    async (sessionSqlite) => {
      await runCli([
        "doctor",
        "--session-sqlite",
        sessionSqlite,
        "--session-sqlite-agent",
        "main",
        "--session-sqlite-store",
        "/tmp/sessions.json",
        "--json",
        ...(sessionSqlite === "recover" ? ["--github-issue", "--yes"] : []),
      ]);
      expect(doctorCommand).toHaveBeenCalledExactlyOnceWith(
        runtime,
        expect.objectContaining({
          sessionSqlite,
          sessionSqliteAgent: "main",
          sessionSqliteStore: "/tmp/sessions.json",
          json: true,
          sessionSqliteGithubIssue: sessionSqlite === "recover",
          yes: sessionSqlite === "recover",
        }),
        undefined,
      );
      expect(runDoctorLintCli).not.toHaveBeenCalled();
      expect(runtime.exit).toHaveBeenCalledWith(0);
    },
  );

  it.each([["--state-sqlite", "compact"], ["--post-upgrade"]])(
    "preserves standalone Doctor operation %j",
    async (...args) => {
      await runCli(["doctor", ...args, "--json"]);
      expect(doctorCommand).toHaveBeenCalledWith(
        runtime,
        expect.objectContaining(
          args[0] === "--state-sqlite"
            ? { stateSqlite: "compact", json: true }
            : { postUpgrade: true, json: true },
        ),
        undefined,
      );
      expect(runDoctorLintCli).not.toHaveBeenCalled();
      expect(runtime.exit).toHaveBeenCalledWith(0);
    },
  );

  const errors = {
    state: "doctor shared-state SQLite maintenance can only be combined with --json.",
    orphan:
      "doctor session SQLite options require --session-sqlite. Use `openclaw doctor --session-sqlite dry-run ...`.",
    operations:
      "doctor operations are mutually exclusive: choose one of --lint, --fix/--repair, --post-upgrade, --state-sqlite, or --session-sqlite.",
    github: "--github-issue requires --session-sqlite recover.",
    selectors: "doctor lint options require --lint. Use `openclaw doctor --lint ...`.",
    repair:
      "doctor --lint runs read-only lint checks and cannot be combined with --repair, --fix, or --force.",
    yes: "doctor --lint runs read-only lint checks and cannot be combined with --yes.",
    token:
      "doctor --lint runs read-only lint checks and cannot be combined with --generate-gateway-token.",
    session:
      "doctor --lint runs read-only lint checks and cannot be combined with --session-sqlite recover.",
    json: "doctor --json runs read-only lint checks and cannot be combined with --repair, --fix, or --force.",
  };
  it.each([
    ["--state-sqlite compact --session-sqlite compact", "state", false],
    ["--state-sqlite compact --lint --json", "state", true],
    ["--session-sqlite-agent main", "orphan", false],
    ["--session-sqlite-agent main --json", "orphan", true],
    ["--session-sqlite-store main --json", "orphan", true],
    ["--session-sqlite-all-agents --json", "orphan", true],
    ["--github-issue --json", "orphan", true],
    ["--lint --post-upgrade --json", "operations", true],
    ["--session-sqlite import --fix --json", "operations", true],
    ["--session-sqlite inspect --github-issue --json", "github", true],
    ["--severity-min error --json", "selectors", true],
    ["--all --json", "selectors", true],
    ["--skip a --json", "selectors", true],
    ["--only b --json", "selectors", true],
    ["--fix --only b", "selectors", false],
    ["--lint --repair", "repair", true],
    ["--lint --fix", "repair", true],
    ["--lint --force", "repair", true],
    ["--lint --yes", "yes", true],
    ["--lint --generate-gateway-token", "token", true],
    ["--lint --session-sqlite recover", "session", true],
    ["--json --repair", "json", true],
  ] as const)("rejects incompatible Doctor options %s", async (args, error, json) => {
    const message = errors[error];
    await runCli(["doctor", ...args.split(" ")]);
    expect(doctorCommand).not.toHaveBeenCalled();
    expect(runDoctorLintCli).not.toHaveBeenCalled();
    if (json) {
      expect(runtime.writeJson).toHaveBeenCalledWith(jsonFailure(message));
      expect(runtime.error).not.toHaveBeenCalled();
    } else {
      expect(runtime.error).toHaveBeenCalledWith(message);
      expect(runtime.writeJson).not.toHaveBeenCalled();
    }
    expect(runtime.exit).toHaveBeenCalledWith(2);
  });

  it("keeps interactive lint mutation conflicts on stderr", async () => {
    await withTerminal(() => runCli(["doctor", "--lint", "--repair"]));
    expect(doctorCommand).not.toHaveBeenCalled();
    expect(runDoctorLintCli).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("--repair"));
    expect(runtime.writeJson).not.toHaveBeenCalled();
    expect(runtime.exit).toHaveBeenCalledWith(2);
  });

  it.each([
    {
      args: "--lint --json --severity-min error --all --skip a --only b --allow-exec".split(" "),
      code: 1,
      options: {
        json: true,
        severityMin: "error",
        includeAllChecks: true,
        skipIds: ["a"],
        onlyIds: ["b"],
        allowExec: true,
        deep: false,
      },
    },
    {
      args: ["--json"],
      code: 0,
      options: {
        json: true,
        severityMin: undefined,
        includeAllChecks: false,
        skipIds: [],
        onlyIds: [],
        allowExec: false,
        deep: false,
      },
    },
  ])("runs lint with the exit policy for $args", async ({ args, code, options }) => {
    runDoctorLintCli.mockResolvedValueOnce(1);
    await runCli(["doctor", ...args]);
    expect(runDoctorLintCli).toHaveBeenCalledExactlyOnceWith(runtime, options);
    expect(doctorCommand).not.toHaveBeenCalled();
    expect(runtime.exit).toHaveBeenCalledWith(code);
  });

  it("redacts lint failure output in the released report format", async () => {
    const token = "sk-abcdefghijklmnopqrstuv";
    runDoctorLintCli.mockRejectedValueOnce(
      new Error(`lint failed: Authorization: Bearer ${token}`),
    );
    await runCli(["doctor", "--lint", "--json"]);
    expect(runtime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining(
        jsonFailure(expect.stringContaining("lint failed: Authorization: Bearer")),
      ),
    );
    expect(
      parseReleasedDoctorLintReport(JSON.stringify(runtime.writeJson.mock.calls.at(-1)?.[0])),
    ).toMatchObject({
      ok: false,
      checksRun: 0,
      findings: [{ severity: "error", message: expect.stringContaining("lint failed") }],
    });
    expect(JSON.stringify(runtime.writeJson.mock.calls)).not.toContain(token);
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).toHaveBeenCalledWith(2);
  });

  it("keeps interactive lint failures on stderr", async () => {
    runDoctorLintCli.mockRejectedValueOnce(new Error("lint failed"));
    await withTerminal(() => runCli(["doctor", "--lint"]));
    expect(runtime.error).toHaveBeenCalledWith("lint failed");
    expect(runtime.writeJson).not.toHaveBeenCalled();
    expect(runtime.exit).toHaveBeenCalledWith(2);
  });

  it.each([
    {
      args: "--json --no-export --non-interactive --update-result /tmp/failure.json".split(" "),
      options: {
        json: true,
        noExport: true,
        run: false,
        nonInteractive: true,
        updateResult: "/tmp/failure.json",
      },
    },
    { args: ["--run"], options: { json: false, noExport: false, run: true } },
    ..."claude codex cursor grok kimi muse opencode pi qwen".split(" ").map((agent) => ({
      args: ["--agent", agent],
      options: { json: false, noExport: false, run: false, agent },
    })),
  ])("forwards triage options $args", async ({ args, options }) => {
    await runCli(["triage", ...args]);
    expect(triageCommand).toHaveBeenCalledExactlyOnceWith(runtime, options);
  });

  it.each([
    ["--json --run", true, "triage --json cannot be combined with --run."],
    ["--non-interactive --run", false, "triage --non-interactive cannot be combined with --run."],
    ["--run --agent codex", false, "triage --run cannot be combined with --agent."],
    [
      "--agent unknown-agent",
      false,
      "Invalid --agent. Use claude, codex, cursor, grok, kimi, muse, opencode, pi, or qwen.",
    ],
  ] as const)("rejects incompatible triage options %s", async (args, json, message) => {
    await runCli(["triage", ...args.split(" ")]);
    expect(triageCommand).not.toHaveBeenCalled();
    expect(json ? runtime.writeJson : runtime.error).toHaveBeenCalledWith(
      json ? jsonFailure(message) : message,
    );
    expect(runtime.exit).toHaveBeenCalledWith(2);
  });

  it.each([
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
    await runCli(args.split(" "));
    expect(command).toHaveBeenCalledExactlyOnceWith(runtime, expect.objectContaining(options));
  });
});
