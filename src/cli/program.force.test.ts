import type { ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ExecFileSyncMock = (
  command: string,
  args: string[],
  options: ExecFileSyncOptionsWithStringEncoding,
) => string;

const execFileSyncMock = vi.hoisted(() => vi.fn<ExecFileSyncMock>());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFileSync: execFileSyncMock,
  };
});

const probePortUsageMock = vi.hoisted(() => vi.fn());

vi.mock("../infra/ports-probe.js", () => ({
  probePortUsage: (...args: unknown[]) => probePortUsageMock(...args),
}));

import { getWindowsSystem32ExePath } from "../infra/windows-install-roots.js";
import { forceFreePortAndWait } from "./ports.js";

type PortProcess = Awaited<ReturnType<typeof forceFreePortAndWait>>["killed"][number];

function usePlatform(platform: NodeJS.Platform) {
  let originalKill: typeof process.kill;
  let originalPlatform: NodeJS.Platform;
  const defaultKillMock = vi.fn<typeof process.kill>();
  beforeEach(() => {
    vi.clearAllMocks();
    originalKill = process.kill.bind(process);
    process.kill = defaultKillMock.mockReturnValue(true);
    originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    process.kill = originalKill;
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });
  return defaultKillMock;
}

const nodeListener = "p42\ncnode\n";
const waitOptions = { timeoutMs: 500, intervalMs: 100 };
const toolError = (
  message: string,
  details: { code?: string; status?: number; stdout?: string; stderr?: string },
) => Object.assign(new Error(message), details);
const throwError = (error: Error) => () => {
  throw error;
};

describe("gateway --force helpers", () => {
  const defaultKillMock = usePlatform("linux");
  beforeEach(() => {
    probePortUsageMock.mockReset().mockResolvedValue("busy");
  });

  it.each<[string, Error]>([
    ["lsof has no matches", toolError("no matches", { status: 1 })],
    ["lsof is unavailable", toolError("not found", { code: "ENOENT" })],
  ])("returns without cleanup when %s and the bind probe reports free", async (_name, error) => {
    probePortUsageMock.mockResolvedValue("free");
    execFileSyncMock.mockImplementation(throwError(error));

    const result = await forceFreePortAndWait(18789, waitOptions);

    expect(result).toEqual({
      killed: [],
      waitedMs: 0,
      escalatedToSigkill: false,
    });
    expect(execFileSyncMock).toHaveBeenCalledOnce();
    expect(probePortUsageMock).toHaveBeenCalledWith(18789);
  });

  it("fails closed for a later malformed PID when fuser cannot identify a listener", async () => {
    execFileSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes("lsof")) {
        return "p456\ncpython\npabc\ncnode\n";
      }
      throw toolError("no matches", { status: 1, stdout: "", stderr: "" });
    });

    await expect(forceFreePortAndWait(18789, { timeoutMs: 0 })).rejects.toThrow(
      /still busy.*no listener PID/i,
    );

    expect(execFileSyncMock).toHaveBeenCalledWith(
      "fuser",
      ["-k", "-TERM", "18789/tcp"],
      expect.anything(),
    );
    expect(defaultKillMock).not.toHaveBeenCalled();
  });

  it("continues when a discovered listener exits before it can be signaled", async () => {
    probePortUsageMock.mockResolvedValue("free");
    execFileSyncMock
      .mockReturnValueOnce(["p42", "cnode", "p99", "cssh", ""].join("\n"))
      .mockReturnValue("");
    const killMock = vi
      .fn()
      .mockImplementationOnce(throwError(toolError("no such process", { code: "ESRCH" })));
    process.kill = killMock;

    expect((await forceFreePortAndWait(18789)).killed).toEqual<PortProcess[]>([
      { pid: 42, command: "node" },
      { pid: 99, command: "ssh" },
    ]);
    expect(killMock.mock.calls).toEqual([
      [42, "SIGTERM"],
      [99, "SIGTERM"],
    ]);
    expect(probePortUsageMock).not.toHaveBeenCalled();
  });

  it("does not suppress listener ownership-guard errors", async () => {
    execFileSyncMock.mockReturnValue(nodeListener);
    const guardError = toolError("ownership verification failed", { code: "ESRCH" });
    await expect(
      forceFreePortAndWait(18789, {
        beforeSignal: throwError(guardError),
      }),
    ).rejects.toThrow(guardError);
    expect(defaultKillMock).not.toHaveBeenCalled();
  });

  it("propagates EPERM from process.kill without fuser fallback", async () => {
    execFileSyncMock.mockReturnValue(nodeListener);
    probePortUsageMock.mockResolvedValue("free");
    const rejectSignal = vi.fn(throwError(toolError("permission denied", { code: "EPERM" })));
    process.kill = rejectSignal;

    await expect(forceFreePortAndWait(18789)).rejects.toThrow(/failed to kill pid 42/);

    expect(rejectSignal).toHaveBeenCalledOnce();
    expect(probePortUsageMock).not.toHaveBeenCalled();
    expect(execFileSyncMock).toHaveBeenCalledOnce();
  });

  it("retries until the port is free", async () => {
    vi.useFakeTimers();
    execFileSyncMock
      .mockReturnValueOnce(nodeListener)
      .mockReturnValueOnce(nodeListener)
      .mockReturnValueOnce(nodeListener)
      .mockReturnValue("");

    const promise = forceFreePortAndWait(18789, { ...waitOptions, sigtermTimeoutMs: 400 });

    await vi.runAllTimersAsync();
    const res = await promise;

    expect(defaultKillMock).toHaveBeenCalledWith(42, "SIGTERM");
    expect(res).toEqual({
      killed: [{ pid: 42, command: "node" }],
      escalatedToSigkill: false,
      waitedMs: 100,
    });
  });

  it("bounds oversized force-free intervals by the remaining timeout", async () => {
    vi.useFakeTimers();
    execFileSyncMock.mockReturnValue(nodeListener);
    const beforeSignal = vi.fn();

    const rejected = expect(
      forceFreePortAndWait(18789, {
        timeoutMs: 2,
        intervalMs: Number.MAX_SAFE_INTEGER,
        sigtermTimeoutMs: 1,
        beforeSignal,
      }),
    ).rejects.toThrow(/still has listeners/);

    await vi.runAllTimersAsync();
    await rejected;

    expect(defaultKillMock).toHaveBeenCalledWith(42, "SIGTERM");
    expect(defaultKillMock).toHaveBeenCalledWith(42, "SIGKILL");
    expect(beforeSignal).toHaveBeenCalledWith({ port: 18789, pid: 42, signal: "SIGTERM" });
    expect(beforeSignal).toHaveBeenCalledWith({ port: 18789, pid: 42, signal: "SIGKILL" });
  });

  it.each(["owner changes", "stderr diagnostics"])(
    "signals only guarded fuser PIDs: %s",
    async (scenario) => {
      let fuserPids = [4242];
      execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
        if (cmd.includes("lsof")) {
          throw toolError("spawnSync lsof EACCES", { code: "EACCES" });
        }
        if (scenario === "stderr diagnostics") {
          throw toolError("fuser diagnostics", {
            status: 1,
            stdout: "4242 5151oops\n",
            stderr: "18789/tcp: 5252\nfuser warning for device 6161\n",
          });
        }
        if (args.includes("-k")) {
          throw new Error("guarded fuser cleanup must not use resource-targeted kill");
        }
        return `${fuserPids.join(" ")}\n`;
      });
      probePortUsageMock.mockResolvedValueOnce("busy").mockResolvedValue("free");
      const beforeSignal = vi.fn(() => {
        if (scenario === "owner changes") {
          fuserPids = [5252];
        }
      });

      const result = await forceFreePortAndWait(18789, { ...waitOptions, beforeSignal });

      expect(result.killed).toEqual<PortProcess[]>([{ pid: 4242 }]);
      expect(beforeSignal.mock.calls).toEqual([[{ port: 18789, pid: 4242, signal: "SIGTERM" }]]);
      expect(defaultKillMock.mock.calls).toEqual([[4242, "SIGTERM"]]);
      expect(execFileSyncMock).toHaveBeenCalledWith("fuser", ["18789/tcp"], expect.anything());
    },
  );

  it("uses fuser SIGKILL escalation when port stays busy", async () => {
    vi.useFakeTimers();
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd.includes("lsof")) {
        throw toolError("spawnSync lsof EACCES", { code: "EACCES" });
      }
      if (args.includes("-TERM") || args.includes("-KILL")) {
        return "1337\n";
      }
      return "";
    });

    probePortUsageMock
      .mockResolvedValueOnce("busy")
      .mockResolvedValueOnce("busy")
      .mockResolvedValueOnce("busy")
      .mockResolvedValueOnce("busy")
      .mockResolvedValue("free");

    const promise = forceFreePortAndWait(18789, {
      timeoutMs: 300,
      intervalMs: 100,
      sigtermTimeoutMs: 100,
    });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toMatchObject({ escalatedToSigkill: true, waitedMs: 100 });
    const killCall = execFileSyncMock.mock.calls.find(
      ([cmd, args]) => cmd === "fuser" && Array.isArray(args) && args.includes("-KILL"),
    );
    expect(killCall?.[1]).toEqual(["-k", "-KILL", "18789/tcp"]);
    expect(killCall?.[2]).toMatchObject({ encoding: "utf-8" });
  });

  it("throws when lsof is unavailable and fuser is missing", async () => {
    // An inconclusive four-host probe must continue into the cleanup tools.
    probePortUsageMock.mockResolvedValue("unknown");
    execFileSyncMock.mockImplementation((cmd: string) => {
      throw toolError(`spawnSync ${cmd} ENOENT`, { code: "ENOENT" });
    });

    await expect(forceFreePortAndWait(18789, { timeoutMs: 200, intervalMs: 100 })).rejects.toThrow(
      /fuser not found/i,
    );
  });
});

describe("gateway --force helpers (Windows netstat path)", () => {
  const defaultKillMock = usePlatform("win32");

  const makeNetstatOutput = (port: number, ...pids: number[]) =>
    [
      "Proto  Local Address          Foreign Address        State           PID",
      ...pids.map(
        (pid) => `  TCP    0.0.0.0:${port}           0.0.0.0:0              LISTENING       ${pid}`,
      ),
    ].join("\r\n");

  it("throws a descriptive error when netstat fails", async () => {
    execFileSyncMock.mockImplementation(throwError(new Error("access denied")));
    await expect(forceFreePortAndWait(18789)).rejects.toThrow(/netstat failed/);
  });

  it("kills Windows listeners and returns metadata", async () => {
    execFileSyncMock.mockReturnValueOnce(makeNetstatOutput(18789, 42, 42, 99)).mockReturnValue("");

    const { killed } = await forceFreePortAndWait(18789);

    expect(execFileSyncMock).toHaveBeenCalledWith(
      getWindowsSystem32ExePath("netstat.exe"),
      ["-ano"],
      { env: expect.any(Object), encoding: "utf-8", killSignal: "SIGKILL", timeout: 10_000 },
    );
    expect(defaultKillMock.mock.calls).toEqual([
      [42, "SIGTERM"],
      [99, "SIGTERM"],
    ]);
    expect(killed).toEqual<PortProcess[]>([{ pid: 42 }, { pid: 99 }]);
  });
});
