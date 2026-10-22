import type { SpawnSyncOptions, SpawnSyncReturns } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildGatewayWatchTmuxCommand,
  resolveGatewayWatchTmuxSessionName,
  runGatewayWatchTmuxMain as runGatewayWatchTmuxMainNative,
  runGatewayWatchServiceHandoff as runGatewayWatchServiceHandoffNative,
} from "../../scripts/gateway-watch-tmux.mts";

type SpawnSyncFixture = (
  command: string,
  args: string[],
  options: SpawnSyncOptions,
) => Partial<SpawnSyncReturns<string | Buffer>>;
type SpawnMock = ReturnType<typeof vi.fn<SpawnSyncFixture>>;

const native = vi.hoisted(() => {
  const overrides: Record<string, unknown> = {};
  return { overrides, spawnSync: vi.fn<SpawnSyncFixture>() };
});
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: native.spawnSync,
}));
vi.mock("node:process", async (importOriginal) => {
  const actual = await importOriginal<{ default: NodeJS.Process }>();
  return {
    default: new Proxy(actual.default, {
      get(target, key) {
        return Object.hasOwn(native.overrides, key)
          ? Reflect.get(native.overrides, key)
          : Reflect.get(target, key, target);
      },
    }),
  };
});

type RuntimeParams = NonNullable<Parameters<typeof runGatewayWatchTmuxMainNative>[0]>;
type RuntimeFixture = RuntimeParams & {
  spawnSync: SpawnSyncFixture;
  nodePath?: string;
  stderr?: { write(message: string): unknown };
  stdout?: { write(message: string): unknown };
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
};

function runNativeBoundary(run: (params: RuntimeParams) => number, fixture: RuntimeFixture) {
  const { spawnSync, nodePath, stderr, stdout, stdinIsTTY, stdoutIsTTY, ...params } = fixture;
  const output = stdout ?? process.stdout;
  native.overrides = {
    execPath: nodePath ?? process.execPath,
    stderr: stderr ?? process.stderr,
    stdin: { isTTY: stdinIsTTY ?? false },
    stdout: { write: (message: string) => output.write(message), isTTY: stdoutIsTTY ?? false },
  };
  native.spawnSync.mockImplementation(spawnSync);
  try {
    return run(params);
  } finally {
    native.overrides = {};
    native.spawnSync.mockReset();
  }
}

const createOutput = () => {
  const chunks: string[] = [];
  return {
    text: () => chunks.join(""),
    stream: {
      write: (message: string) => {
        chunks.push(message);
      },
    },
  };
};

function spawnCall(mock: SpawnMock, callIndex: number) {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected spawn call ${callIndex + 1}`);
  }
  return call;
}

function spawnShellCommand(mock: SpawnMock): string {
  const command = mock.mock.calls.find(([, args]) => typeof args[6] === "string")?.[1][6];
  if (command !== undefined) {
    return command;
  }
  throw new Error("Expected a tmux shell command");
}

function expectSpawn(mock: SpawnMock, callIndex: number, command: string, args: string[]) {
  const call = spawnCall(mock, callIndex);
  expect(call.slice(0, 2)).toEqual([command, args]);
  return call[2];
}

describe("gateway-watch tmux wrapper", () => {
  let stdout: ReturnType<typeof createOutput>;
  let stderr: ReturnType<typeof createOutput>;
  let spawnSync: SpawnMock;
  beforeEach(() => {
    stdout = createOutput();
    stderr = createOutput();
    spawnSync = vi
      .fn<SpawnSyncFixture>()
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "" })
      .mockReturnValue({ status: 0, stdout: "", stderr: "" });
  });
  const run = (overrides: Partial<RuntimeFixture> = {}, handoff = false) =>
    runNativeBoundary(
      handoff ? runGatewayWatchServiceHandoffNative : runGatewayWatchTmuxMainNative,
      {
        args: ["gateway", "--force"],
        cwd: "/repo",
        env: { SHELL: "/bin/zsh" },
        nodePath: handoff ? "/opt/node" : "/node",
        spawnSync,
        stdout: stdout.stream,
        stderr: stderr.stream,
        ...overrides,
      },
    );
  const runHandoff = (overrides: Partial<RuntimeFixture> = {}) => run(overrides, true);
  const serviceStatus = (service: object, portCli?: object) => ({
    status: 0,
    stdout: JSON.stringify({ service, gateway: { port: 18789 }, ...(portCli ? { portCli } : {}) }),
    stderr: "",
  });
  const handoffStatus = (service: object, portCli?: object, stop = false) =>
    stop
      ? vi
          .fn()
          .mockReturnValueOnce(serviceStatus(service, portCli))
          .mockReturnValueOnce({ status: 0 })
      : vi.fn().mockReturnValue(serviceStatus(service, portCli));
  const buildCommand = (overrides: Parameters<typeof buildGatewayWatchTmuxCommand>[0]) =>
    buildGatewayWatchTmuxCommand({
      args: ["gateway", "--force"],
      cwd: "/repo",
      nodePath: "/opt/node",
      sessionName: "openclaw-gateway-watch-main",
      ...overrides,
    });
  const expectTmux = (index: number, args: string[]) => expectSpawn(spawnSync, index, "tmux", args);
  const mainSession = "openclaw-gateway-watch-main";
  const expectRemain = (index: number, session = mainSession) =>
    expectTmux(index, ["set-option", "-w", "-t", session, "remain-on-exit", "on"]);
  const expectPane = (
    index: number,
    action: "new-session" | "respawn-pane",
    session = mainSession,
  ) => {
    const [command, args, options] = spawnCall(spawnSync, index);
    const create = action === "new-session";
    expect(command).toBe("tmux");
    expect(args.slice(0, 6)).toEqual([
      action,
      create ? "-d" : "-k",
      create ? "-s" : "-t",
      session,
      "-c",
      "/repo",
    ]);
    expect(options.encoding).toBe("utf8");
    if (create) {
      expect(args).toHaveLength(6);
    }
    return args[6];
  };
  it("derives stable session names from profile and port", () => {
    const session = (args: string[], env: NodeJS.ProcessEnv = {}) =>
      resolveGatewayWatchTmuxSessionName({ args, env });
    expect(session(["gateway", "--force"])).toBe("openclaw-gateway-watch-main");
    expect(
      session(["gateway", "--force", "--port", "19001"], { OPENCLAW_PROFILE: "Dev Profile" }),
    ).toBe("openclaw-gateway-watch-dev-profile-19001");
    expect(session(["--dev", "gateway", "--port=18789"])).toBe("openclaw-gateway-watch-dev");
    expect(session(["gateway", "--dev", "--port=18789"])).toBe("openclaw-gateway-watch-main");
    expect(
      session(["gateway", "--profile", "work", "--port=18789"], { OPENCLAW_PROFILE: "main" }),
    ).toBe("openclaw-gateway-watch-work");
    expect(session(["gateway", "--force"], { OPENCLAW_GATEWAY_PORT: "127.0.0.1:18789" })).toBe(
      "openclaw-gateway-watch-main",
    );
  });

  it("builds a login-shell command that runs the raw watcher in the repo", () => {
    const command = buildCommand({
      args: ["gateway", "--force", "--raw-stream-path", "a b.jsonl"],
      cwd: "/repo with spaces/openclaw",
      env: {
        OPENCLAW_DEV_SOURCE_ROOT: "/selected checkout",
        OPENCLAW_GATEWAY_PORT: "19001",
        OPENCLAW_GATEWAY_RESTART_TRACE: "1",
        OPENCLAW_GATEWAY_STARTUP_TRACE: "1",
        OPENCLAW_GATEWAY_WATCH_AUTO_DOCTOR: "0",
        OPENCLAW_PROFILE: "Dev Profile",
        OPENCLAW_TRACE_SYNC_IO: "0",
        SHELL: "/bin/zsh",
      },
    });

    expect(command).toContain("exec '/bin/zsh' -lc");
    expect(command).toContain("/repo with spaces/openclaw");
    expect(command).toContain("'OPENCLAW_GATEWAY_WATCH_TMUX_CHILD=1'");
    expect(command).toContain("'OPENCLAW_GATEWAY_WATCH_SESSION=openclaw-gateway-watch-main'");
    expect(command).toContain("'\\''-u'\\'' '\\''NO_COLOR'\\''");
    expect(command).toContain("'FORCE_COLOR=1'");
    expect(command).toContain("'OPENCLAW_DEV_SOURCE_ROOT=/selected checkout'");
    expect(command).toContain("'OPENCLAW_GATEWAY_PORT=19001'");
    expect(command).toContain("'OPENCLAW_GATEWAY_RESTART_TRACE=1'");
    expect(command).toContain("'OPENCLAW_GATEWAY_STARTUP_TRACE=1'");
    expect(command).toContain("'OPENCLAW_GATEWAY_WATCH_AUTO_DOCTOR=0'");
    expect(command).toContain("'OPENCLAW_PROFILE=Dev Profile'");
    expect(command).toContain("'OPENCLAW_TRACE_SYNC_IO=0'");
    expect(command).toContain("'\\''-u'\\'' '\\''OPENCLAW_SKIP_CHANNELS'\\''");
    expect(command).toContain("/opt/node");
    expect(command).toContain("scripts/watch-node.mjs");
    expect(command).toContain("gateway");
    expect(command).toContain("--force");
    expect(command).toContain("'a b.jsonl'");
    expect(command).toContain("scripts/gateway-watch-tmux.mts");
    expect(command).toContain("--handoff-managed-service");
    expect(command).not.toContain("scripts/run-node.mjs");
  });

  it("runs managed service handoff before watching and clears an omitted development selector", () => {
    const command = buildCommand({
      env: { SHELL: "/bin/zsh" },
    });

    expect(command).toContain("scripts/gateway-watch-tmux.mts");
    expect(command).toContain("'\\''-u'\\'' '\\''OPENCLAW_DEV_SOURCE_ROOT'\\''");
    expect(command).not.toContain("OPENCLAW_DEV_SOURCE_ROOT=");
    expect(command).toMatch(
      /gateway-watch-tmux\.mts.*handoff-managed-service.*&& exec.*scripts\/watch-node\.mjs/,
    );
    expect(command.indexOf("scripts/gateway-watch-tmux.mts")).toBeLessThan(
      command.indexOf("scripts/watch-node.mjs"),
    );
  });

  it("stops a loaded service on the watched port with CLI selector precedence", () => {
    spawnSync = vi
      .fn()
      .mockReturnValueOnce({
        status: 0,
        stdout: `build output\n${JSON.stringify({
          service: { loaded: true },
          gateway: { port: 18789 },
        })}`,
        stderr: "",
      })
      .mockReturnValueOnce({ status: 0 });

    const code = runHandoff({
      args: ["gateway", "--force", "--port", "18789", "--profile", "work"],
      env: { OPENCLAW_GATEWAY_PORT: "19001", OPENCLAW_PROFILE: "main" },
    });

    expect(code).toBe(0);
    expectSpawn(spawnSync, 0, "/opt/node", [
      "scripts/run-node.mjs",
      "--profile",
      "work",
      "gateway",
      "status",
      "--json",
      "--no-probe",
    ]);
    const stopOptions = expectSpawn(spawnSync, 1, "/opt/node", [
      "scripts/run-node.mjs",
      "--profile",
      "work",
      "gateway",
      "stop",
    ]);
    expect(stopOptions).toMatchObject({
      env: { OPENCLAW_GATEWAY_PORT: "18789" },
      stdio: "inherit",
    });
  });

  it.each([true, false])("leaves a different port running (explicit CLI=%s)", (explicit) => {
    spawnSync = handoffStatus({ loaded: true }, explicit ? undefined : { port: 19001 });
    expect(
      runHandoff(
        explicit
          ? {
              args: ["gateway", "--force", "--port=19001"],
              env: { OPENCLAW_GATEWAY_PORT: "18789" },
            }
          : { env: {} },
      ),
    ).toBe(0);
    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(stderr.text()).toContain("leaving managed Gateway on port 18789; watching port 19001");
  });

  it.each([
    ["Compose port", { loaded: true }, { OPENCLAW_GATEWAY_PORT: "127.0.0.1:18789" }, 2],
    ["unloaded service", { loaded: false }, {}, 1],
    ["disabled but running", { loaded: false, runtime: { status: "running" } }, {}, 2],
  ] as const)("handles %s during service handoff", (_label, service, env, calls) => {
    spawnSync = handoffStatus(service, undefined, calls === 2);
    expect(runHandoff({ env })).toBe(0);
    expect(spawnSync).toHaveBeenCalledTimes(calls);
  });

  it("fails handoff when the managed stop process cannot launch", () => {
    spawnSync = vi
      .fn()
      .mockReturnValueOnce(serviceStatus({ loaded: true }))
      .mockReturnValueOnce({ error: new Error("spawn failed"), status: null, signal: null });

    const code = runHandoff({ env: {} });

    expect(code).toBe(1);
    expect(stderr.text()).toContain(
      "failed to stop the managed Gateway service before watch: spawn failed",
    );
  });

  it("consumes benchmark flags and passes the CPU profile dir to the watched child", () => {
    const code = run({
      args: ["gateway", "--force", "--benchmark"],
    });

    expect(code).toBe(0);
    const command = spawnShellCommand(spawnSync);
    expect(command).toContain("'OPENCLAW_RUN_NODE_CPU_PROF_DIR=.artifacts/gateway-watch-profiles'");
    expect(command).toContain("'OPENCLAW_RUN_NODE_CPU_PROF_MAX_FILES=40'");
    expect(command).toContain("'OPENCLAW_TRACE_SYNC_IO=0'");
    expect(command).not.toContain("--benchmark");
    expect(command).toContain("'gateway'");
    expect(command).toContain("'--force'");
    expect(stderr.text()).toContain(
      "gateway:watch benchmark CPU profiles: .artifacts/gateway-watch-profiles",
    );
  });

  it("preserves explicit sync I/O tracing in benchmark mode", () => {
    const code = run({
      args: ["gateway", "--force", "--benchmark"],
      env: { OPENCLAW_TRACE_SYNC_IO: "1", SHELL: "/bin/zsh" },
    });

    expect(code).toBe(0);
    const command = spawnShellCommand(spawnSync);
    expect(command).toContain("'OPENCLAW_TRACE_SYNC_IO=1'");
    expect(command).toContain(
      "'OPENCLAW_RUN_NODE_OUTPUT_LOG=.artifacts/gateway-watch-profiles/gateway-watch-output.log'",
    );
    expect(command).toContain("'OPENCLAW_RUN_NODE_FILTER_SYNC_IO_STDERR=1'");
    expect(stderr.text()).toContain(
      "gateway:watch benchmark trace output: .artifacts/gateway-watch-profiles/gateway-watch-output.log",
    );
  });

  it("can remove --force from benchmarked watch runs", () => {
    const code = run({
      args: ["gateway", "--force", "--benchmark-no-force"],
    });

    expect(code).toBe(0);
    const command = spawnShellCommand(spawnSync);
    expect(command).toContain("'OPENCLAW_RUN_NODE_CPU_PROF_DIR=.artifacts/gateway-watch-profiles'");
    expect(command).not.toContain("--benchmark-no-force");
    expect(command).toContain("'gateway'");
    expect(command).not.toContain("'--force'");
    expect(stderr.text()).toContain("gateway:watch benchmark running without --force");
  });

  it("preserves an explicit color override for the tmux child", () => {
    const command = buildCommand({
      env: { FORCE_COLOR: "0", NO_COLOR: "1", SHELL: "/bin/zsh" },
    });

    expect(command).toContain("'FORCE_COLOR=0'");
    expect(command).not.toContain("'\\''-u'\\'' '\\''NO_COLOR'\\''");
    expect(command).not.toContain("'FORCE_COLOR=1'");
  });

  it.each([
    ["interactive", { TERM: "xterm-256color" }, false, "attach-session"],
    ["missing TERM", {}, false, undefined],
    ["limited TERM", { TERM: "DUMB" }, false, undefined],
    ["inside tmux", { TERM: "dumb", TMUX: "/tmp/tmux-501/default,1,0" }, true, "switch-client"],
    ["CI", { CI: "1" }, false, undefined],
  ] as const)("handles %s terminal attachment", (_name, env, existing, action) => {
    if (existing) {
      spawnSync.mockReset().mockReturnValue({ status: 0, stdout: "", stderr: "" });
    }
    const code = run({ env: { SHELL: "/bin/zsh", ...env }, stdinIsTTY: true, stdoutIsTTY: true });
    expect(code).toBe(0);
    if (action) {
      expect(
        expectTmux(existing ? 5 : 6, [action, "-t", "openclaw-gateway-watch-main"]).stdio,
      ).toBe("inherit");
      if (!existing) {
        expect(stdout.text()).not.toContain("tmux attach -t");
      }
    } else {
      expect(spawnSync).toHaveBeenCalledTimes(6);
      expect(stdout.text()).toContain("tmux attach -t openclaw-gateway-watch-main");
    }
  });

  it("respawns the existing tmux pane on repeated runs", () => {
    spawnSync = vi.fn().mockReturnValue({ status: 0, stdout: "", stderr: "" });

    const code = run({
      args: ["gateway", "--force", "--port=19001"],
      env: { OPENCLAW_GATEWAY_WATCH_AUTO_DOCTOR: "0", OPENCLAW_PROFILE: "dev", SHELL: "/bin/zsh" },
    });

    expect(code).toBe(0);
    expectRemain(1, "openclaw-gateway-watch-dev-19001");
    const command = expectPane(2, "respawn-pane", "openclaw-gateway-watch-dev-19001");
    expect(command).toContain("scripts/watch-node.mjs");
    expect(command).toContain("OPENCLAW_GATEWAY_WATCH_AUTO_DOCTOR=0");
    expect(command).toContain("OPENCLAW_SKIP_CHANNELS");
    expect(stderr.text()).toContain(
      "gateway:watch restarted in tmux session openclaw-gateway-watch-dev-19001",
    );
  });

  it("recreates a stale session when its active pane target is missing", () => {
    spawnSync = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "can't find window: 0" })
      .mockReturnValue({ status: 0, stdout: "", stderr: "" });

    const code = run({ env: { CI: "1", SHELL: "/bin/zsh" } });

    expect(code).toBe(0);
    expectRemain(1);
    expect(expectTmux(2, ["kill-session", "-t", "openclaw-gateway-watch-main"]).encoding).toBe(
      "utf8",
    );
    expectPane(3, "new-session");
    expectRemain(4);
    expect(expectPane(5, "respawn-pane")).toContain("scripts/watch-node.mjs");
  });

  it("runs the raw foreground watcher when tmux mode is disabled", () => {
    spawnSync = vi.fn().mockReturnValue({ status: 0, stdout: "", stderr: "" });

    const code = run({ env: { OPENCLAW_GATEWAY_WATCH_TMUX: "0" } });

    expect(code).toBe(0);
    expect(spawnSync).toHaveBeenCalledWith(
      "/node",
      ["scripts/watch-node.mjs", "gateway", "--force"],
      {
        cwd: "/repo",
        env: { OPENCLAW_GATEWAY_WATCH_TMUX: "0" },
        stdio: "inherit",
      },
    );
  });

  it("prints a raw-mode hint when tmux is unavailable", () => {
    spawnSync = vi.fn().mockReturnValue({
      error: Object.assign(new Error("spawn tmux ENOENT"), { code: "ENOENT" }),
    });

    const code = run({ env: {} });

    expect(code).toBe(1);
    expect(stderr.text()).toContain("tmux is not installed or not on PATH");
  });
});
