// Covers gateway port availability and diagnostics behavior.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import net from "node:net";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { listenServer, withNativeSsConnection } from "./ports.test-support.js";
import {
  getWindowsPowerShellExePath,
  getWindowsSystem32ExePath,
  getWindowsWmicExePath,
} from "./windows-install-roots.js";

const runCommandWithTimeoutMock = vi.hoisted(() => vi.fn());

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
}));

let inspectPortConnections: typeof import("./ports-inspect.js").inspectPortConnections;
let inspectPortUsage: typeof import("./ports-inspect.js").inspectPortUsage;
let inspectPortUsages: typeof import("./ports-inspect.js").inspectPortUsages;
let ensurePortAvailable: typeof import("./ports.js").ensurePortAvailable;
let handlePortError: typeof import("./ports.js").handlePortError;
let PortInUseError: typeof import("./ports.js").PortInUseError;

const describeUnix = process.platform === "win32" ? describe.skip : describe;
const describeWindows = process.platform === "win32" ? describe : describe.skip;

type CommandResult = { stdout: string; stderr: string; code: number };
type CommandReply = CommandResult | Error;

const failedCommand = (): CommandResult => ({ stdout: "", stderr: "", code: 1 });
const commandOutput = (stdout: string, code = 0, stderr = ""): CommandResult => ({
  stdout,
  stderr,
  code,
});

async function resolveCommandReply(reply: CommandReply | undefined): Promise<CommandResult> {
  if (reply instanceof Error) {
    throw reply;
  }
  return reply ?? failedCommand();
}

function mockUnixCommands(params: {
  lsof?: CommandReply;
  ss?: CommandReply;
  commandLine?: string | ((pid: string | undefined) => string);
  user?: string;
  parentPid?: string;
  processInfo?: CommandReply;
}): void {
  runCommandWithTimeoutMock.mockImplementation(async (argv: string[]) => {
    const command = argv[0];
    if (typeof command !== "string") {
      return failedCommand();
    }
    if (command.includes("lsof")) {
      return resolveCommandReply(params.lsof);
    }
    if (command === "ss") {
      return resolveCommandReply(params.ss);
    }
    if (command === "ps") {
      if (argv.includes("user=")) {
        return params.user === undefined ? failedCommand() : commandOutput(`${params.user}\n`);
      }
      if (params.processInfo !== undefined) {
        return resolveCommandReply(params.processInfo);
      }
      if (params.commandLine === undefined && params.parentPid === undefined) {
        return failedCommand();
      }
      const commandLine =
        typeof params.commandLine === "function"
          ? params.commandLine(argv[2])
          : (params.commandLine ?? "");
      return commandOutput(`${params.parentPid ?? "0"} ${commandLine}\n`);
    }
    return failedCommand();
  });
}

function mockWindowsCommands(params: {
  netstat?: CommandReply;
  tasklist?: CommandReply | ((argv: string[]) => CommandReply);
  powershell?: CommandReply;
  wmic?: CommandReply;
}): void {
  mockProcessPlatform("win32");
  runCommandWithTimeoutMock.mockImplementation(async (argv: string[]) => {
    const command = argv[0];
    const reply =
      command === getWindowsSystem32ExePath("netstat.exe")
        ? (params.netstat ?? commandOutput("TCP 127.0.0.1:18789 0.0.0.0:0 LISTENING 4242\n"))
        : command === getWindowsSystem32ExePath("tasklist.exe")
          ? typeof params.tasklist === "function"
            ? params.tasklist(argv)
            : params.tasklist
          : command === getWindowsPowerShellExePath()
            ? params.powershell
            : command === getWindowsWmicExePath()
              ? params.wmic
              : undefined;
    return resolveCommandReply(reply);
  });
}

function expectLsofArgs(selector: string) {
  const calls = runCommandWithTimeoutMock.mock.calls.filter(
    ([argv]) => typeof argv?.[0] === "string" && argv[0].includes("lsof"),
  );
  expect(calls).toHaveLength(1);
  expect(calls[0]?.[0]?.[0]).toMatch(/lsof$/);
  expect(calls[0]?.[0]?.slice(1)).toEqual(["-nP", selector, "-sTCP:LISTEN", "-FpFcn"]);
}

beforeAll(async () => {
  ({ inspectPortConnections, inspectPortUsage, inspectPortUsages } =
    await import("./ports-inspect.js"));
  ({ ensurePortAvailable, handlePortError, PortInUseError } = await import("./ports.js"));
});

beforeEach(() => {
  runCommandWithTimeoutMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ports helpers", () => {
  it("keeps process inspection behind the busy-port diagnostics boundary", () => {
    const source = readFileSync(new URL("./ports.ts", import.meta.url), "utf8");

    expect(source).not.toMatch(/(?:import|export)[^;]+from "\.\/ports-inspect\.js"/u);
    expect(source).toContain('await import("./ports-inspect.js")');
  });

  it.for([undefined, "127.0.0.1"])("rejects a busy port scoped to %s", async (host, { skip }) => {
    await using server = net.createServer();
    const { port } = await listenServer(skip, server, 0, host);
    await expect(ensurePortAvailable(port, host)).rejects.toBeInstanceOf(PortInUseError);
  });

  it("handlePortError exits nicely on EADDRINUSE", async () => {
    const runtime = {
      error: vi.fn(),
      log: vi.fn(),
      exit: vi.fn() as unknown as (code: number) => never,
    };
    // Avoid slow OS port inspection; this test only cares about messaging + exit behavior.
    await handlePortError(new PortInUseError(1234, "details"), 1234, "context", runtime).catch(
      () => {},
    );
    const messages = runtime.error.mock.calls.map((call) => stripAnsi(String(call[0] ?? "")));
    expect(messages.join("\n")).toContain("context failed: port 1234 is already in use.");
    expect(messages.join("\n")).toContain("Resolve by stopping the process");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it.each([
    { details: "openclaw-gateway", openclaw: false },
    { details: "node dist/index.js", openclaw: false },
    { details: "node src/index.ts", openclaw: false },
  ])(
    "keeps port guidance independent of diagnostic text ($details)",
    async ({ details, openclaw }) => {
      const runtime = {
        error: vi.fn(),
        log: vi.fn(),
        exit: vi.fn() as unknown as (code: number) => never,
      };

      await handlePortError(
        new PortInUseError(18789, details),
        18789,
        "gateway start",
        runtime,
      ).catch(() => {});

      const messages = runtime.error.mock.calls.map((call) => stripAnsi(String(call[0] ?? "")));
      expect(messages.join("\n").includes("another OpenClaw instance is already running")).toBe(
        openclaw,
      );
    },
  );
});

describeUnix("inspectPortUsage", () => {
  it.for(["127.0.0.1", "0.0.0.0"])(
    "preserves the relevant %s listener in single and batched loopback inspection",
    async (host, { skip }) => {
      await using server = net.createServer();
      const { port } = await listenServer(skip, server, 0, host);
      const address = `TCP ${host === "0.0.0.0" ? "*" : host}:${port} (LISTEN)`;
      mockUnixCommands({
        lsof: commandOutput(
          `p111\ncgateway\nn${address}\np222\ncother\nnTCP 127.0.0.2:${port} (LISTEN)\n`,
        ),
      });
      const single = await inspectPortUsage(port, { probeHosts: ["127.0.0.1"] });
      const batch = await inspectPortUsages([port], {
        probeHostsByPort: new Map([[port, ["127.0.0.1"]]]),
      });
      for (const result of [single, batch.get(port)]) {
        expect(result?.status).toBe("busy");
        expect(result?.listeners).toEqual([{ pid: 111, command: "gateway", address }]);
      }
    },
  );

  it.for([
    { probeHost: "127.0.0.1", unrelatedWildcard: "[::]" },
    { probeHost: "::1", unrelatedWildcard: "0.0.0.0" },
  ])(
    "does not attribute an opposite-family wildcard listener to $probeHost",
    async ({ probeHost, unrelatedWildcard }, { skip }) => {
      await using server = net.createServer();
      const address = await listenServer(skip, server, 0, probeHost);
      const port = address.port;

      mockUnixCommands({
        lsof: commandOutput(`p222\ncother\nnTCP ${unrelatedWildcard}:${port} (LISTEN)\n`),
      });

      const result = await inspectPortUsage(port, { probeHosts: [probeHost] });

      expect(result.status).toBe("busy");
      expect(result.listeners).toEqual([]);
    },
  );

  it("ignores another interface when inspection is scoped to the gateway loopback", async ({
    skip,
  }) => {
    await using server = net.createServer();
    const address = await listenServer(skip, server, 0, "127.0.0.2");
    const port = address.port;

    mockUnixCommands({
      lsof: commandOutput(`p${process.pid}\ncnode\nnTCP 127.0.0.2:${port} (LISTEN)\n`),
    });

    const allInterfaces = await inspectPortUsage(port);
    const gatewayLoopback = await inspectPortUsage(port, {
      probeHosts: ["127.0.0.1"],
    });

    expect(allInterfaces.status).toBe("busy");
    expect(gatewayLoopback).toMatchObject({
      status: "free",
      listeners: [],
      hints: [],
    });
  });

  it.for([
    ["empty scan", commandOutput(""), 0, undefined, undefined],
    ["quiet exit one", commandOutput("ignored output", 1, " \n"), 0, undefined, undefined],
    ["nonzero scan", commandOutput("", 2), 1, undefined, undefined],
    ["unavailable lsof", new Error("lsof unavailable"), 1, ["Error: lsof unavailable"], undefined],
    [
      "both failing",
      commandOutput("lsof output\n", 1, "lsof error\n"),
      1,
      ["lsof error\nlsof output", "ss error\nss output"],
      commandOutput("ss output\n", 2, "ss error\n"),
    ],
  ] as const)("preserves %s diagnostics", async ([, lsof, ssCalls, errors, ss], { skip }) => {
    await using server = net.createServer();
    const address = await listenServer(skip, server, 0, "127.0.0.1");
    mockUnixCommands({ lsof, ss });

    const result = await inspectPortUsage(address.port);
    expect(result).toMatchObject({
      port: address.port,
      status: "busy",
      listeners: [],
      errors,
    });
    expect(result?.hints).toContain(
      "Port is in use but process details are unavailable (install lsof or run as an admin user).",
    );
    expect(runCommandWithTimeoutMock.mock.calls.filter(([argv]) => argv[0] === "ss")).toHaveLength(
      ssCalls,
    );
  });

  it.each(["lsof", "ss"])(
    "shares bounded Unix process metadata lookups across ports (%s)",
    async (source) => {
      const listenerCount = 25;
      const pids = Array.from({ length: listenerCount }, (_, index) => 1_000 + index);
      const rows = (record: (pid: number) => string) => pids.map(record).join("\n");
      let activeProcessLookups = 0;
      let maxConcurrentProcessLookups = 0;
      let processLookupCount = 0;
      runCommandWithTimeoutMock.mockImplementation(async (argv: string[]) => {
        const command = argv[0];
        if (typeof command !== "string") {
          return failedCommand();
        }
        if (command.includes("lsof")) {
          if (source === "ss") {
            return commandOutput("", 2);
          }
          return commandOutput(
            rows(
              (pid) =>
                `p${pid}\ncnode\nnTCP 127.0.0.1:18789 (LISTEN)\nnTCP 127.0.0.1:19001 (LISTEN)`,
            ) + "\np9999\ncunrelated\nnTCP 127.0.0.1:3000 (LISTEN)\n",
          );
        }
        if (command === "ss") {
          const port = argv.at(-1)?.split(":").at(-1);
          return commandOutput(
            rows(
              (pid) => `LISTEN 0 128 127.0.0.1:${port} 0.0.0.0:* users:(("node",pid=${pid},fd=1))`,
            ),
          );
        }
        if (command === "ps") {
          processLookupCount += 1;
          activeProcessLookups += 1;
          maxConcurrentProcessLookups = Math.max(maxConcurrentProcessLookups, activeProcessLookups);
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 1);
          });
          activeProcessLookups -= 1;
          return commandOutput(
            argv.includes("user=") ? "fixture-user\n" : `1 node fixture-${argv[2]}\n`,
          );
        }
        return failedCommand();
      });

      const results = await inspectPortUsages([18789, 19001]);

      if (source === "lsof") {
        expectLsofArgs("-iTCP");
      }
      expect(processLookupCount).toBeLessThanOrEqual(listenerCount * 2);
      expect(maxConcurrentProcessLookups).toBeLessThanOrEqual(20);
      for (const result of results.values()) {
        expect(result.listeners).toMatchObject(
          pids.map((pid) => ({
            pid,
            commandLine: `node fixture-${pid}`,
            user: "fixture-user",
            ppid: 1,
          })),
        );
      }
    },
  );

  it.each([
    [
      "PPID zero",
      commandOutput("  0 node argument with  spaces\n"),
      "fixture-user",
      { user: "fixture-user", commandLine: "node argument with  spaces" },
    ],
    ["missing command", commandOutput("  1\n"), "fixture-user", { user: "fixture-user", ppid: 1 }],
    [
      "padded UTF-8 username",
      commandOutput("  1 node argument with  spaces\n"),
      "  用戶 é name  ",
      { user: "用戶 é name", commandLine: "node argument with  spaces", ppid: 1 },
    ],
    ["missing process", commandOutput("", 1), undefined, {}],
    ["command query failure", commandOutput("", 1), "fixture-user", { user: "fixture-user" }],
    [
      "user query failure",
      commandOutput("  1 node fixture\n"),
      undefined,
      { ppid: 1, commandLine: "node fixture" },
    ],
    ["malformed row", commandOutput("\n"), undefined, {}],
    ["known runtime", commandOutput("1 node\n"), "u", {}, 111],
    ["child", commandOutput("1 node\n"), "u", { ppid: 1, commandLine: "node", user: "u" }, 1],
    ["foreign", commandOutput("1 node\n"), "u", { ppid: 1, commandLine: "node", user: "u" }, 222],
  ] as const)(
    "preserves socket evidence with %s metadata",
    async (_name, output, user, metadata, knownRuntimePid?: number) => {
      mockUnixCommands({
        lsof: commandOutput("p111\ncnode\nnTCP *:18789 (LISTEN)\n"),
        processInfo: output,
        user,
      });
      const result = await inspectPortUsage(18789, { knownRuntimePid });
      expect(result.listeners).toEqual([
        { pid: 111, command: "node", address: "TCP *:18789 (LISTEN)", ...metadata },
      ]);
      expect(
        runCommandWithTimeoutMock.mock.calls.filter(([argv]) => argv[0] === "ps"),
      ).toHaveLength(knownRuntimePid === 111 ? 0 : 2);
    },
  );

  it("reports lsof connections per socket and refreshes process metadata", async () => {
    mockUnixCommands({
      lsof: commandOutput(
        "p111\ncnode\nnTCP 127.0.0.1:50123->127.0.0.1:18789 (ESTABLISHED)\n" +
          "nTCP 127.0.0.1:50124->127.0.0.1:18789 (ESTABLISHED)\n" +
          "p222\ncnode\nnTCP 127.0.0.1:18789->127.0.0.1:50123 (ESTABLISHED)\n" +
          "p444\ncnode\nnTCP 127.0.0.1:50125->[::ffff:127.0.0.1]:18789 (ESTABLISHED)\n" +
          "p555\ncnode\nnTCP 127.0.0.1:50126->127.0.0.1:18789abc (ESTABLISHED)\n" +
          "p666\ncnode\nnTCP 127.0.0.1:50127->127.0.0.1:99999 (ESTABLISHED)\n" +
          "p333\ncBrowser\nnTCP 127.0.0.1:50124->198.51.100.7:18789 (ESTABLISHED)\n",
      ),
      commandLine: "node logs",
      user: "tester",
      parentPid: "1",
    });

    const result = await inspectPortConnections(18789);

    expect(result.connections).toMatchObject([
      {
        pid: 111,
        direction: "client",
        commandLine: "node logs",
        user: "tester",
        ppid: 1,
        address: "TCP 127.0.0.1:50123->127.0.0.1:18789 (ESTABLISHED)",
      },
      {
        pid: 111,
        direction: "client",
        commandLine: "node logs",
        user: "tester",
        ppid: 1,
        address: "TCP 127.0.0.1:50124->127.0.0.1:18789 (ESTABLISHED)",
      },
      { pid: 222, direction: "server" },
      { pid: 444, direction: "client" },
    ]);
    mockUnixCommands({
      lsof: commandOutput("p111\ncnode\nnTCP 127.0.0.1:50123->127.0.0.1:18789 (ESTABLISHED)\n"),
      commandLine: "node replacement-process",
      user: "replacement-user",
      parentPid: "7",
    });
    const refreshed = await inspectPortConnections(18789);
    expect(refreshed.connections[0]).toMatchObject({
      commandLine: "node replacement-process",
      user: "replacement-user",
      ppid: 7,
    });
  });

  it("deduplicates repeated lsof listener records for one process address", async () => {
    mockUnixCommands({
      lsof: commandOutput("p111\ncnode\nnTCP *:18789 (LISTEN)\nnTCP *:18789 (LISTEN)\n"),
    });

    const result = await inspectPortUsage(18789);

    expectLsofArgs("-iTCP:18789");
    expect(result.listeners).toMatchObject([{ pid: 111, address: "TCP *:18789 (LISTEN)" }]);
  });

  it("assigns each batched listener to its own port", async () => {
    mockUnixCommands({
      lsof: commandOutput(
        "p111\ncnode\nnTCP *:18789 (LISTEN)\np222\ncdeno\nnTCP 127.0.0.1:19001 (LISTEN)\n",
      ),
    });
    const results = await inspectPortUsages([18789, 19001]);
    for (const [port, pid, command, address] of [
      [18789, 111, "node", "TCP *:18789 (LISTEN)"],
      [19001, 222, "deno", "TCP 127.0.0.1:19001 (LISTEN)"],
    ] as const) {
      expect(results.get(port)).toMatchObject({
        port,
        status: "busy",
        listeners: [{ pid, command, address }],
      });
    }
  });

  it.each(["", "111abc"])(
    "preserves malformed lsof PID %j without inventing a process",
    async (pid) => {
      mockUnixCommands({
        lsof: commandOutput(
          `p${pid}\ncnode\nnTCP *:18789 (LISTEN)\np111\ncbun\nnTCP 127.0.0.1:18789 (LISTEN)\n`,
        ),
      });

      const result = await inspectPortUsage(18789);

      expect(result.status).toBe("busy");
      expect(result.listeners).toMatchObject([
        { command: "node", address: "TCP *:18789 (LISTEN)" },
        { pid: 111, command: "bun", address: "TCP 127.0.0.1:18789 (LISTEN)" },
      ]);
      expect(result.listeners[0]?.pid).toBeUndefined();
      expect(result.hints).toContain("Another process is listening on this port.");
    },
  );

  it("preserves ss rows with IPv6, unknown processes, and multiple process owners", async () => {
    mockUnixCommands({
      lsof: commandOutput("", 2),
      ss: commandOutput(
        [
          '0 0 [::1]:50123 [::1]:18789 users:(("node users:1",pid=111,fd=12),("other",pid=222,fd=13))',
          '0 0 [::]:18789 [::1]:50124 users:(("node worker:2",pid=333,fd=14))',
          "0 0 127.0.0.1:50125 [::ffff:127.0.0.1]:18789",
          '0 0 127.0.0.1:50126 198.51.100.7:18789 users:(("remote :1",pid=444,fd=15))',
          "0 0 127.0.0.1:50127 127.0.0.1:187890",
          "0 0 127.0.0.1:50128 127.0.0.1:18789abc",
          "0 0 127.0.0.1:50129 127.0.0.1:99999",
          "malformed row",
          "",
        ].join("\n"),
      ),
    });

    const result = await inspectPortConnections(18789);

    expect(
      result.connections.map(({ address, direction, pid, command }) => [
        address,
        direction,
        pid,
        command,
      ]),
    ).toEqual([
      ["TCP [::1]:50123->[::1]:18789 (ESTABLISHED)", "client", 111, "node users:1"],
      ["TCP [::]:18789->[::1]:50124 (ESTABLISHED)", "server", 333, "node worker:2"],
      [
        "TCP 127.0.0.1:50125->[::ffff:127.0.0.1]:18789 (ESTABLISHED)",
        "client",
        undefined,
        undefined,
      ],
    ]);
  });

  it("preserves ss rows for exact-port listeners without reading process text as socket fields", async () => {
    mockUnixCommands({
      lsof: Object.assign(new Error("spawn lsof ENOENT"), { code: "ENOENT" }),
      ss: commandOutput(
        [
          'LISTEN 0 128 [::1]:1878 [::]:* users:(("node worker:1",pid=111,fd=12))',
          "LISTEN 0 128 127.0.0.1:1878 0.0.0.0:*",
          'LISTEN 0 128 127.0.0.1:8080 0.0.0.0:* users:(("app",pid=100,fd=3))',
          'LISTEN 0 128 127.0.0.1:1879 0.0.0.0:* users:(("other",pid=456,fd=7))',
          // A valid prefix neighbor must be rejected independently of the invalid port below.
          'LISTEN 0 128 127.0.0.1:18789 0.0.0.0:* users:(("prefix",pid=444,fd=8))',
          'LISTEN 0 128 127.0.0.1:187890 0.0.0.0:* users:(("other",pid=222,fd=13))',
          'ESTAB 0 0 127.0.0.1:1878 127.0.0.1:50123 users:(("LISTEN :1",pid=333,fd=14))',
        ].join("\n"),
      ),
    });

    const result = await inspectPortUsage(1878);

    expect(result.status).toBe("busy");
    expect(result.listeners).toEqual([
      { address: "[::1]:1878", pid: 111, command: "node worker:1" },
      { address: "127.0.0.1:1878" },
    ]);
    expect(result.errors).toBeUndefined();
  });
});

describe("inspectPortUsage on Windows", () => {
  it.each([false, true])(
    "shares one socket snapshot and PID lookup across ports (WMIC fallback: %s)",
    async (fallback) => {
      const commandLine = "node openclaw fixture-gateway";
      mockWindowsCommands({
        netstat: commandOutput(
          "TCP 127.0.0.1:18789 0.0.0.0:0 LISTENING 4242\r\n" +
            "TCP [::1]:18789 [::]:0 LISTENING 4242\r\n" +
            "TCP 127.0.0.1:19001 0.0.0.0:0 LISTENING 4242\r\n" +
            "TCP [::1]:19001 [::]:0 LISTENING 4242\r\n",
        ),
        tasklist: commandOutput('"node.exe","4242","Console","1","10,000 K"\r\n'),
        powershell: fallback ? failedCommand() : commandOutput(commandLine),
        wmic: commandOutput(`CommandLine=${commandLine}\r\n`),
      });

      const results = await inspectPortUsages([18789, 19001, 18789]);

      expect([...results.keys()]).toEqual([18789, 19001]);
      for (const port of [18789, 19001]) {
        expect(results.get(port)).toMatchObject({
          port,
          status: "busy",
          listeners: [
            { pid: 4242, address: `127.0.0.1:${port}`, command: "node.exe", commandLine },
            { pid: 4242, address: `[::1]:${port}`, command: "node.exe", commandLine },
          ],
        });
      }
      expect(runCommandWithTimeoutMock).toHaveBeenCalledTimes(fallback ? 4 : 3);
    },
  );

  it("classifies SSH through locale-independent tasklist CSV output", async () => {
    mockWindowsCommands({
      tasklist: (argv) =>
        argv.includes("CSV")
          ? commandOutput('"ssh.exe","4242","Console","1","10,000 K"\r\n')
          : commandOutput("Abbildname: ssh.exe\r\n"),
    });

    const result = await inspectPortUsage(18789);

    expect(result.listeners[0]?.command).toBe("ssh.exe");
    expect(result.hints).toContain(
      "SSH tunnel already bound to this port. Close the tunnel or use a different local port in -L.",
    );
    expect(result.hints).not.toContain("Another process is listening on this port.");
  });

  it.each([
    ['"ssh,helper.exe","4242","Console","1","10,000 K"\r\n', "ssh,helper.exe"],
    ['"ssh.exe","4243","Console","1","10,000 K"\r\n', undefined],
    ["INFORMATION: Keine Tasks entsprechen den angegebenen Kriterien.\r\n", undefined],
    ["ssh.exe,4242,Console,1,10,000 K\r\n", undefined],
    ['"ssh.exe","4242"\r\n', undefined],
    [commandOutput("", 1, "access denied"), undefined],
    [new Error("tasklist timed out"), undefined],
  ])("preserves process metadata across tasklist results: %s", async (output, command) => {
    mockWindowsCommands({
      tasklist: typeof output === "string" ? commandOutput(output) : output,
      powershell: commandOutput("node fixture"),
    });
    const result = await inspectPortUsage(18789);
    expect(result.listeners[0]?.command).toBe(command);
    expect(result.listeners[0]?.commandLine).toBe("node fixture");
    expect(result.hints).toContain("Another process is listening on this port.");
  });

  it("reports established gateway client connections from netstat", async () => {
    mockWindowsCommands({
      netstat: commandOutput(
        "  TCP    127.0.0.1:50123    127.0.0.1:18789    ESTABLISHED    4242\r\n" +
          "  TCP    127.0.0.1:50124    198.51.100.7:18789  ESTABLISHED    5000\r\n",
      ),
      tasklist: commandOutput('"node.exe","4242","Console","1","10,000 K"\r\n'),
      powershell: commandOutput("node openclaw logs\r\n"),
    });

    const result = await inspectPortConnections(18789);

    expect(result.connections).toMatchObject([
      { pid: 4242, command: "node.exe", direction: "client", commandLine: "node openclaw logs" },
    ]);
  });

  it("reports localized Windows listener rows without requiring English state text", async () => {
    mockWindowsCommands({
      netstat: commandOutput(
        "  TCP    127.0.0.1:18789    0.0.0.0:0        ABHOEREN       4242\r\n" +
          "  TCP    [::1]:18789        [::]:0           ABHOEREN       4243\r\n" +
          "  TCP    127.0.0.1:187890    0.0.0.0:0        LISTENING      9000\r\n" +
          "  TCP    [::1]:187890       [::]:0           LISTENING      9001\r\n" +
          "  TCP    127.0.0.1:18789    127.0.0.1:0      ABHOEREN       8999\r\n" +
          "  TCP    127.0.0.1:18789    127.0.0.1:50123  HERGESTELLT    9000\r\n",
      ),
      tasklist: commandOutput(
        '"node.exe","4242","Console","1","10,000 K"\r\n' +
          '"node.exe","4243","Console","1","10,000 K"\r\n',
      ),
      powershell: commandOutput("node.exe C:\\openclaw\\dist\\index.js gateway run\r\n"),
    });

    const result = await inspectPortUsage(18789);

    expect(result.status).toBe("busy");
    expect(result.listeners.map((listener) => listener.pid)).toEqual([4242, 4243]);
  });
});

describeWindows("native tasklist CSV contract", () => {
  it("emits a quoted image and exact PID row", () => {
    const result = spawnSync(
      getWindowsSystem32ExePath("tasklist.exe"),
      ["/FI", `PID eq ${process.pid}`, "/FO", "CSV", "/NH"],
      { encoding: "utf8", windowsHide: true },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(new RegExp(`^"[^"]+","${process.pid}",`, "m"));
  });
});

describe.skipIf(process.platform !== "linux")("native ss process metadata contract", () => {
  it("preserves a spaced and colon-bearing native TCP client name", async (context) => {
    await withNativeSsConnection(context, async ({ port, clientPort, pid, stdout }) => {
      mockUnixCommands({ lsof: commandOutput("", 2), ss: commandOutput(stdout) });
      const result = await inspectPortConnections(port);
      expect(result.connections).toContainEqual({
        pid,
        command: "node worker:1",
        direction: "client",
        address: `TCP 127.0.0.1:${clientPort}->127.0.0.1:${port} (ESTABLISHED)`,
      });
    });
  }, 30_000);
});
