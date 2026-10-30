import "../../test-utils/prepare-compiled-subprocesses.js";
import { Command } from "commander";
import { beforeEach, expect, it, vi } from "vitest";
import { ExpectedCliError } from "../failure-output.js";
import { expectNoCalls } from "./program.test-helpers.js";
import { registerStatusHealthSessionsCommands } from "./register.status-health-sessions.js";

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  health: vi.fn(),
  list: vi.fn(),
  cleanup: vi.fn(),
  tail: vi.fn(),
  compact: vi.fn(),
  lifecycle: vi.fn(),
  exportTrajectory: vi.fn(),
  ownerLoaded: vi.fn(),
  setVerbose: vi.fn(),
  runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
}));
// mock-isolation: Capture dispatch and lazy loading without reading or mutating session state.
vi.mock("../../commands/status.js", () => ({ statusCommand: mocks.status }));
// mock-isolation: Capture dispatch without reading live health state.
vi.mock("../../commands/health.js", () => ({ healthCommand: mocks.health }));
// mock-isolation: Capture dispatch without reading session state.
vi.mock("../../commands/sessions.js", () => ({ sessionsCommand: mocks.list }));
// mock-isolation: Capture lazy loading without mutating session state.
vi.mock("../../commands/sessions-cleanup.js", () => {
  mocks.ownerLoaded();
  return { sessionsCleanupCommand: mocks.cleanup };
});
// mock-isolation: Capture lazy loading without reading session state.
vi.mock("../../commands/sessions-tail.js", () => {
  mocks.ownerLoaded();
  return { sessionsTailCommand: mocks.tail };
});
// mock-isolation: Capture lazy loading without mutating session state.
vi.mock("../../commands/sessions-compact.js", () => {
  mocks.ownerLoaded();
  return { sessionsCompactCommand: mocks.compact };
});
vi.mock("../../commands/sessions-lifecycle.js", async (importOriginal) => {
  mocks.ownerLoaded();
  return {
    ...(await importOriginal<typeof import("../../commands/sessions-lifecycle.js")>()),
    sessionsLifecycleCommand: mocks.lifecycle,
  };
});
// mock-isolation: Capture lazy loading without exporting session state.
vi.mock("../../commands/export-trajectory.js", () => {
  mocks.ownerLoaded();
  return { exportTrajectoryCommand: mocks.exportTrajectory };
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
function expectOptions(owner: typeof mocks.list, options: Record<string, unknown>) {
  expect(owner).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(options), mocks.runtime);
}
function expectLifecycle(operation: string, options: Record<string, unknown>) {
  expect(mocks.lifecycle).toHaveBeenCalledExactlyOnceWith(
    operation,
    expect.objectContaining(options),
    mocks.runtime,
  );
}
const timeoutError = "--timeout must be a positive integer (milliseconds).";
const key = "agent:work:main";
const request = "eyJzZXNzaW9uS2V5IjoiYWdlbnQ6bWFpbjp0ZWxlZ3JhbTpkaXJlY3Q6b3duZXIifQ";

beforeEach(() => vi.clearAllMocks());

it.each([
  [
    "sessions --active 5 cleanup",
    mocks.cleanup,
    "`sessions cleanup` does not support the parent `sessions` option --active; session-list filters cannot scope session maintenance.",
  ],
  [
    `sessions --store /tmp/other.sqlite archive ${key}`,
    mocks.lifecycle,
    "`sessions archive` does not support the parent `sessions` option --store; the gateway resolves target stores from each key and --agent.",
  ],
  [
    `sessions --store /tmp/other.sqlite --all-agents --limit 25 --verbose compact ${key}`,
    mocks.compact,
    "`sessions compact` does not support the parent `sessions` options --store, --all-agents, --limit, --verbose; the gateway resolves the target store from <key> and --agent.",
  ],
  [`sessions delete ${key} --timeout 0 --json`, mocks.lifecycle, timeoutError],
  [
    `sessions compact ${key} --max-lines 0 --json`,
    mocks.compact,
    "--max-lines must be a positive integer.",
  ],
  [`sessions compact ${key} --timeout 0 --json`, mocks.compact, timeoutError],
] as const)("rejects %s before loading the session owner", async (args, owner, message) => {
  const execution = run(args);
  await expect(execution).rejects.toBeInstanceOf(ExpectedCliError);
  await expect(execution).rejects.toMatchObject({ message });
  expectNoCalls(owner, mocks.ownerLoaded, mocks.runtime.error, mocks.runtime.exit);
});

it.each([
  [
    "status --json --all --deep --usage --agent beta --debug --timeout 5000",
    mocks.status,
    { agent: "beta", timeoutMs: 5000, verbose: true },
  ],
  ["health --json --timeout 2500 --verbose", mocks.health, { timeoutMs: 2500, verbose: true }],
] as const)("dispatches %s with verbose and parsed timeout", async (args, owner, options) => {
  await run(args);
  expect(mocks.setVerbose).toHaveBeenCalledWith(true);
  expectOptions(owner, options);
});
it("rejects an invalid probe timeout without dispatch", async () => {
  await run("status --timeout nope");
  expect(mocks.runtime.error).toHaveBeenCalledWith(
    "--timeout must be a positive integer (milliseconds)",
  );
  expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  expect(mocks.status).not.toHaveBeenCalled();
});

it.each([
  [
    "--json --verbose --agent work --all-agents --active 120 --limit 25 list",
    mocks.list,
    { json: true, agent: "work", allAgents: true, active: "120", limit: "25" },
  ],
  [
    `--all-agents --json cleanup --dry-run --enforce --fix-missing --fix-dm-scope --active-key ${key}`,
    mocks.cleanup,
    {
      agent: undefined,
      allAgents: true,
      dryRun: true,
      enforce: true,
      fixMissing: true,
      fixDmScope: true,
      activeKey: key,
      json: true,
    },
  ],
  [
    `--agent work tail --session-key ${key} --tail 5 --follow`,
    mocks.tail,
    { sessionKey: key, agent: "work", allAgents: false, follow: true, tail: "5" },
  ],
  [
    `--json export-trajectory --session-key ${key} --workspace /workspace --output bug-123 --request-json-base64 ${request}`,
    mocks.exportTrajectory,
    {
      sessionKey: key,
      output: "bug-123",
      workspace: "/workspace",
      json: true,
      requestJsonBase64: request,
    },
  ],
] as const)("preserves parent options and blank store: %s", async (args, owner, expected) => {
  await run(["sessions", "--store", "", ...args.split(" ")]);
  expectOptions(owner, { store: "", ...expected });
  if (owner === mocks.list) {
    expect(mocks.setVerbose).toHaveBeenCalledWith(true);
  }
});

it("compact inherits parent agent and JSON options (#91378)", async () => {
  await run(`sessions --agent work --json compact ${key}`);
  expectOptions(mocks.compact, { key, agent: "work", json: true });
});
it("forwards archive keys, inherited scope and RPC options", async () => {
  await run(
    `sessions --agent work --json archive ${key} agent:work:scratch --dry-run --url ws://gateway.test --token test-token --password test-password --timeout 45000`,
  );
  expectLifecycle("archive", {
    keys: [key, "agent:work:scratch"],
    agent: "work",
    dryRun: true,
    url: "ws://gateway.test",
    token: "test-token",
    password: "test-password",
    timeout: "45000",
    json: true,
  });
});
it("forwards delete keys with leaf scope and confirmation", async () => {
  await run(`sessions --agent main delete ${key} agent:work:scratch --agent work --yes --json`);
  expectLifecycle("delete", {
    keys: [key, "agent:work:scratch"],
    agent: "work",
    dryRun: false,
    yes: true,
    json: true,
  });
});
it("documents retained delete archives and local memory cleanup", () => {
  const sessions = program().commands.find((command) => command.name() === "sessions");
  const command = sessions?.commands.find((child) => child.name() === "delete");
  let help = "";
  command?.configureOutput({ writeOut: (text) => (help += text) }).outputHelp();
  expect(help).toContain("Retained deleted-session archives can remain eligible for memory search");
  expect(help).toContain("openclaw memory forget --agent <agent-id> --session <id-or-key>");
  expect(help).toContain("on the Gateway host or container using its state and configuration");
  expect(help).toContain("including for global keys");
});
