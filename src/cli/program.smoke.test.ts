import "../test-utils/prepare-compiled-subprocesses.js";
import { beforeEach, expect, it, vi } from "vitest";
import {
  programGatewayCallMock as gateway,
  configureCommand,
  ensureConfigReadyMock,
  runtime,
  setupCommandMock,
  setupWizardCommandMock,
  systemAgentRunMock as agent,
  tuiRunMock as tui,
} from "./program.test-mocks.js";
import { buildProgram } from "./program/build-program.js";

vi.mock("./config-cli.js", () => ({
  registerConfigCli: (program: {
    command: (name: string) => { action: (fn: () => unknown) => void };
  }) => {
    program.command("config").action(() => configureCommand({}, runtime));
  },
  runConfigGet: vi.fn(),
  runConfigUnset: vi.fn(),
}));

let program: ReturnType<typeof buildProgram>;
const run = (...argv: string[]) => program.parseAsync(argv, { from: "user" });
function expectTui(options: object) {
  expect(tui).toHaveBeenNthCalledWith(1, expect.objectContaining(options));
}
beforeEach(() => {
  program = buildProgram();
  vi.clearAllMocks();
  tui.mockResolvedValue(undefined);
  agent.mockResolvedValue(undefined);
  ensureConfigReadyMock.mockResolvedValue(undefined);
});

it("runs tui with explicit timeout override", async () => {
  await run("tui", "--timeout-ms", "45000");
  expectTui({ timeoutMs: 45000, historyLimit: 200 });
  expect(tui.mock.calls[0]?.[0]).not.toHaveProperty("agentId");
});

it.each([
  {
    target: "movies-a1166b81",
    response: { ok: true, key: "agent:main:thread:resolved" },
    request: { method: "sessions.resolve", params: { shortId: "a1166b81", slugHint: "movies" } },
    options: { local: false, session: "agent:main:thread:resolved" },
  },
  {
    target: "https://gateway.example/dashboard/ops",
    response: { defaultId: "main", mainKey: "main", scope: "global", agents: [] },
    request: { method: "agents.list", params: {} },
    options: { local: false, session: "global", agentId: "ops" },
  },
])(
  "resolves the tui target $target before launch",
  async ({ target, response, request, options }) => {
    gateway.mockResolvedValue(response);
    await run("tui", target);
    expect(gateway).toHaveBeenCalledWith(expect.objectContaining(request));
    expectTui(options);
  },
);

it("preserves the resolved global owner when launching tui from an agent key", async () => {
  gateway.mockResolvedValue({ ok: true, key: "global", agentId: "ops" });
  await run("tui", "agent:ops:main");
  expectTui({ session: "global", agentId: "ops" });
});

it.each([
  {
    args: [
      "https://gateway.example/dashboard/main/movies-a1166b81",
      "--url",
      "wss://other.example",
    ],
    error: expect.stringContaining("pass one target"),
  },
  { args: ["--history-limit", "10x"], error: "--history-limit must be a positive integer." },
  { args: ["--history-limit", "1001"], error: "--history-limit must be at most 1000." },
])("rejects invalid tui arguments $args", async ({ args, error }) => {
  await expect(run("tui", ...args)).rejects.toThrow("exit");
  expect(runtime.error).toHaveBeenCalledWith(error);
  expect(tui).not.toHaveBeenCalled();
});

it("runs setup one-shot requests", async () => {
  await run("setup", "--message", "status");
  expect(agent).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({ message: "status", yes: false, json: false }),
    runtime,
  );
});

it("warns and ignores invalid tui timeout override", async () => {
  await run("tui", "--timeout-ms", "nope");
  expect(runtime.error).toHaveBeenCalledWith('warning: invalid --timeout-ms "nope"; ignoring');
  expectTui({ timeoutMs: undefined });
});

it("preserves oversized history limits for local chat", async () => {
  await run("chat", "--history-limit", "1001");
  expectTui({ local: true, historyLimit: 1001 });
  expect(runtime.error).not.toHaveBeenCalled();
});

it("runs setup wizard when wizard flags are present", async () => {
  await run("setup", "--remote-url", "ws://example");
  expect(setupCommandMock).not.toHaveBeenCalled();
  expect(setupWizardCommandMock).toHaveBeenCalledTimes(1);
});
