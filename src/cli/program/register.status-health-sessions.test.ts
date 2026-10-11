import "../../test-utils/prepare-compiled-subprocesses.js";
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExpectedCliError } from "../failure-output.js";
import { registerStatusHealthSessionsCommands } from "./register.status-health-sessions.js";

const mocks = vi.hoisted(() => ({
  statusCommand: vi.fn(),
  healthCommand: vi.fn(),
  sessionsCommand: vi.fn(),
  sessionsCleanupCommand: vi.fn(),
  sessionsTailCommand: vi.fn(),
  sessionsCompactCommand: vi.fn(),
  sessionsLifecycleCommand: vi.fn(),
  exportTrajectoryCommand: vi.fn(),
  ownerLoaded: vi.fn(),
  setVerbose: vi.fn(),
  runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
}));
vi.mock("../../commands/status.js", () => ({ statusCommand: mocks.statusCommand }));
vi.mock("../../commands/health.js", () => ({ healthCommand: mocks.healthCommand }));
vi.mock("../../commands/sessions.js", () => ({ sessionsCommand: mocks.sessionsCommand }));
vi.mock("../../commands/sessions-cleanup.js", () => {
  mocks.ownerLoaded();
  return { sessionsCleanupCommand: mocks.sessionsCleanupCommand };
});
vi.mock("../../commands/sessions-tail.js", () => {
  mocks.ownerLoaded();
  return { sessionsTailCommand: mocks.sessionsTailCommand };
});
vi.mock("../../commands/sessions-compact.js", () => {
  mocks.ownerLoaded();
  return { sessionsCompactCommand: mocks.sessionsCompactCommand };
});
vi.mock("../../commands/sessions-lifecycle.js", async (importOriginal) => {
  mocks.ownerLoaded();
  return {
    ...(await importOriginal<typeof import("../../commands/sessions-lifecycle.js")>()),
    sessionsLifecycleCommand: mocks.sessionsLifecycleCommand,
  };
});
vi.mock("../../commands/export-trajectory.js", () => {
  mocks.ownerLoaded();
  return { exportTrajectoryCommand: mocks.exportTrajectoryCommand };
});
vi.mock("../../globals.js", () => ({ setVerbose: mocks.setVerbose }));
vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
  defaultRuntime: mocks.runtime,
}));

function program() {
  const cli = new Command();
  registerStatusHealthSessionsCommands(cli);
  return cli;
}
async function run(args: string | string[]) {
  await program().parseAsync(typeof args === "string" ? args.split(" ") : args, { from: "user" });
}
function expectOptions(owner: typeof mocks.sessionsCommand, options: Record<string, unknown>) {
  expect(owner).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(options), mocks.runtime);
}
async function runSession(placement: string, command: string, options: string[], extra = "") {
  await run([
    "sessions",
    ...(placement === "parent" ? [...options, command] : [command, ...options]),
    ...extra.split(" ").filter(Boolean),
  ]);
}
async function expectRejection(
  args: string[],
  owner: typeof mocks.sessionsCommand,
  message: string,
) {
  const execution = run(args);
  await expect(execution).rejects.toBeInstanceOf(ExpectedCliError);
  await expect(execution).rejects.toMatchObject({ message });
  expect(owner).not.toHaveBeenCalled();
  expect(mocks.ownerLoaded).not.toHaveBeenCalled();
  expect(mocks.runtime.error).not.toHaveBeenCalled();
  expect(mocks.runtime.exit).not.toHaveBeenCalled();
}
const key = "agent:work:main";
const blankStore = ["--store", ""];
const selection = ["--agent", "work", "--all-agents", "--active", "120", "--limit", "25"];
const listOptions = {
  json: true,
  store: "",
  agent: "work",
  allAgents: true,
  active: "120",
  limit: "25",
};

describe("registerStatusHealthSessionsCommands", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    [
      "sessions --active 5 cleanup",
      mocks.sessionsCleanupCommand,
      "`sessions cleanup` does not support the parent `sessions` option --active; session-list filters cannot scope session maintenance.",
    ],
    [
      "sessions --json tail",
      mocks.sessionsTailCommand,
      "`sessions tail` does not support the parent `sessions` option --json; trajectory tail emits human-readable progress and selects sessions separately.",
    ],
    [
      "sessions --all-agents export-trajectory",
      mocks.exportTrajectoryCommand,
      "`sessions export-trajectory` does not support the parent `sessions` option --all-agents; trajectory export targets one session and cannot apply session-list filters.",
    ],
    [
      `sessions --store /tmp/other.sqlite archive ${key}`,
      mocks.sessionsLifecycleCommand,
      "`sessions archive` does not support the parent `sessions` option --store; the gateway resolves target stores from each key and --agent.",
    ],
    [
      `sessions --store /tmp/other.sqlite --all-agents --limit 25 --verbose compact ${key}`,
      mocks.sessionsCompactCommand,
      "`sessions compact` does not support the parent `sessions` options --store, --all-agents, --limit, --verbose; the gateway resolves the target store from <key> and --agent.",
    ],
    [
      `sessions delete ${key} --timeout 0 --json`,
      mocks.sessionsLifecycleCommand,
      "--timeout must be a positive integer (milliseconds).",
    ],
    [
      `sessions compact ${key} --max-lines 0 --json`,
      mocks.sessionsCompactCommand,
      "--max-lines must be a positive integer.",
    ],
    [
      `sessions compact ${key} --timeout 0 --json`,
      mocks.sessionsCompactCommand,
      "--timeout must be a positive integer (milliseconds).",
    ],
  ] as const)("rejects %s before loading the session owner", async (args, owner, message) => {
    await expectRejection(args.split(" "), owner, message);
  });

  it("dispatches status with debug, scope and parsed timeout", async () => {
    await run("status --json --all --deep --usage --agent beta --debug --timeout 5000");
    expect(mocks.setVerbose).toHaveBeenCalledWith(true);
    expectOptions(mocks.statusCommand, {
      json: true,
      all: true,
      deep: true,
      usage: true,
      agent: "beta",
      timeoutMs: 5000,
      verbose: true,
    });
  });
  it("dispatches health with a parsed timeout", async () => {
    await run("health --json --timeout 2500 --verbose");
    expect(mocks.setVerbose).toHaveBeenCalledWith(true);
    expectOptions(mocks.healthCommand, { json: true, timeoutMs: 2500, verbose: true });
  });
  it("rejects an invalid probe timeout without dispatch", async () => {
    await run("status --timeout nope");
    expect(mocks.runtime.error).toHaveBeenCalledWith(
      "--timeout must be a positive integer (milliseconds)",
    );
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
    expect(mocks.statusCommand).not.toHaveBeenCalled();
  });

  it("forwards bare sessions options including an explicitly blank store", async () => {
    await run(["sessions", ...blankStore, "--json", "--verbose", ...selection]);
    expect(mocks.setVerbose).toHaveBeenCalledWith(true);
    expectOptions(mocks.sessionsCommand, listOptions);
  });
  it("dispatches the list alias with omitted selectors (#81139)", async () => {
    await run("sessions list");
    expectOptions(mocks.sessionsCommand, {
      json: false,
      allAgents: false,
      agent: undefined,
      store: undefined,
    });
  });
  it.each(["parent", "leaf"])("list preserves %s options and blank store", async (placement) => {
    const options = [...blankStore, "--json", "--verbose", ...selection];
    await runSession(placement, "list", options);
    expect(mocks.setVerbose).toHaveBeenCalledWith(true);
    expectOptions(mocks.sessionsCommand, listOptions);
  });
  it.each(["parent", "leaf"])("cleanup preserves %s options and blank store", async (placement) => {
    const options = [...blankStore, "--all-agents", "--json"];
    await runSession(
      placement,
      "cleanup",
      options,
      `--dry-run --enforce --fix-missing --fix-dm-scope --active-key ${key}`,
    );
    expectOptions(mocks.sessionsCleanupCommand, {
      store: "",
      agent: undefined,
      allAgents: true,
      dryRun: true,
      enforce: true,
      fixMissing: true,
      fixDmScope: true,
      activeKey: key,
      json: true,
    });
  });
  it.each(["parent", "leaf"])("tail preserves %s options and blank store", async (placement) => {
    const options = [...blankStore, "--agent", "work"];
    await runSession(placement, "tail", options, `--session-key ${key} --tail 5 --follow`);
    expectOptions(mocks.sessionsTailCommand, {
      sessionKey: key,
      store: "",
      agent: "work",
      allAgents: false,
      follow: true,
      tail: "5",
    });
  });
  it.each(["parent", "leaf"])("export preserves %s options and blank store", async (placement) => {
    const options = [...blankStore, "--json"];
    const request = "eyJzZXNzaW9uS2V5IjoiYWdlbnQ6bWFpbjp0ZWxlZ3JhbTpkaXJlY3Q6b3duZXIifQ";
    await runSession(
      placement,
      "export-trajectory",
      options,
      `--session-key ${key} --workspace /workspace --output bug-123 --request-json-base64 ${request}`,
    );
    expectOptions(mocks.exportTrajectoryCommand, {
      sessionKey: key,
      output: "bug-123",
      workspace: "/workspace",
      store: "",
      json: true,
      requestJsonBase64: request,
    });
  });

  it.each([false, true])("compact leaf override=%s (#91378)", async (override) => {
    await run(
      `sessions --agent ${override ? "main" : "work"} --json compact ${key}${override ? " --agent work" : ""}`,
    );
    expectOptions(mocks.sessionsCompactCommand, { key, agent: "work", json: true });
  });
  it("forwards archive keys, inherited scope and RPC options", async () => {
    await run(
      `sessions --agent work --json archive ${key} agent:work:scratch --dry-run --url ws://gateway.test --token test-token --password test-password --timeout 45000`,
    );
    expect(mocks.sessionsLifecycleCommand).toHaveBeenCalledExactlyOnceWith(
      "archive",
      expect.objectContaining({
        keys: [key, "agent:work:scratch"],
        agent: "work",
        dryRun: true,
        url: "ws://gateway.test",
        token: "test-token",
        password: "test-password",
        timeout: "45000",
        json: true,
      }),
      mocks.runtime,
    );
  });
  it("forwards delete keys with leaf scope and confirmation", async () => {
    await run(`sessions --agent main delete ${key} agent:work:scratch --agent work --yes --json`);
    expect(mocks.sessionsLifecycleCommand).toHaveBeenCalledExactlyOnceWith(
      "delete",
      expect.objectContaining({
        keys: [key, "agent:work:scratch"],
        agent: "work",
        dryRun: false,
        yes: true,
        json: true,
      }),
      mocks.runtime,
    );
  });
  it("documents retained delete archives and local memory cleanup", () => {
    const sessions = program().commands.find((command) => command.name() === "sessions");
    const command = sessions?.commands.find((child) => child.name() === "delete");
    let help = "";
    command?.configureOutput({ writeOut: (text) => (help += text) }).outputHelp();
    expect(help).toContain(
      "Retained deleted-session archives can remain eligible for memory search",
    );
    expect(help).toContain("openclaw memory forget --agent <agent-id> --session <id-or-key>");
    expect(help).toContain("on the Gateway host or container using its state and configuration");
    expect(help).toContain("including for global keys");
  });
});
