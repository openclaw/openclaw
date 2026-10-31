import { Command } from "commander";
import { beforeEach, expect, it, vi } from "vitest";
import { registerProxyCli } from "./proxy-cli.js";

const handlers = vi.hoisted(() => ({
  runDebugProxyCoverageCommand: vi.fn(),
  runDebugProxyQueryCommand: vi.fn(),
  runDebugProxySessionsCommand: vi.fn(),
  runDebugProxyStartCommand: vi.fn(),
  runProxyValidateCommand: vi.fn(),
}));

// mock-isolation: exercise CLI routing without opening proxy listeners or capture stores.
vi.mock("./proxy-cli.runtime.js", () => ({
  ...handlers,
  runDebugProxyPurgeCommand: vi.fn(),
  runDebugProxyRunCommand: vi.fn(),
  readDebugProxyBlobCommand: vi.fn(),
}));

function createProgram() {
  const program = new Command().exitOverride().configureOutput({
    writeErr: () => undefined,
    writeOut: () => undefined,
  });
  registerProxyCli(program);
  return program;
}

beforeEach(() => vi.resetAllMocks());

const argv = (...args: string[]) => ["node", "openclaw", "proxy", ...args];

it("registers the debug proxy subcommands", () => {
  const proxy = createProgram().commands.find((command) => command.name() === "proxy");
  expect(proxy?.commands.map((command) => command.name())).toEqual(
    "start run validate coverage sessions query blob purge".split(" "),
  );
});

it.each([
  {
    args: ["coverage", "--json"],
    invoke: handlers.runDebugProxyCoverageCommand,
    expected: undefined,
  },
  {
    args: ["sessions", "--json", "--limit", "5"],
    invoke: handlers.runDebugProxySessionsCommand,
    expected: { json: true, limit: 5 },
  },
  {
    args: ["query", "--json", "--preset", "double-sends", "--session", "capture-1"],
    invoke: handlers.runDebugProxyQueryCommand,
    expected: { json: true, preset: "double-sends", sessionId: "capture-1" },
  },
])("passes --json through proxy reporting command $args", async ({ args, invoke, expected }) => {
  await createProgram().parseAsync(argv(...args));

  if (expected === undefined) {
    expect(invoke).toHaveBeenCalledWith();
  } else {
    expect(invoke).toHaveBeenCalledWith(expected);
  }
});

it.each([
  [["sessions", "--limit", "abc"], /--limit must be an integer/],
  [["sessions", "--limit", "0"], /--limit must be a positive integer/],
  [["start", "--port", "-1"], /--port must be between 0 and 65535/],
  [["run", "--port", "65536"], /--port must be between 0 and 65535/],
])("rejects invalid numeric option %s", (args, expected) => {
  expect(() => createProgram().parse(argv(...args))).toThrow(expected);
});

it("normalizes signed decimal numeric options through the shared parser", async () => {
  const program = createProgram();

  await program.parseAsync(argv("start", "--port", "+08080"));
  await program.parseAsync(argv("validate", "--timeout-ms", "+01000"));
  await program.parseAsync(argv("sessions", "--limit", "+05"));

  expect(handlers.runDebugProxyStartCommand).toHaveBeenCalledWith({
    host: "127.0.0.1",
    port: 8080,
  });
  expect(handlers.runProxyValidateCommand).toHaveBeenCalledWith({
    allowedUrls: undefined,
    apnsAuthority: undefined,
    apnsReachability: undefined,
    deniedUrls: undefined,
    json: undefined,
    proxyCaFile: undefined,
    proxyUrl: undefined,
    timeoutMs: 1000,
  });
  expect(handlers.runDebugProxySessionsCommand).toHaveBeenCalledWith({ limit: 5 });
});
