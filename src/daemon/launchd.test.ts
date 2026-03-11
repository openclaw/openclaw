import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  LAUNCH_AGENT_THROTTLE_INTERVAL_SECONDS,
  LAUNCH_AGENT_UMASK_DECIMAL,
} from "./launchd-plist.js";
import {
  bootstrapWithRetry,
  installLaunchAgent,
  isLaunchAgentListed,
  parseLaunchctlPrint,
  repairLaunchAgentBootstrap,
  restartLaunchAgent,
  resolveLaunchAgentPlistPath,
  waitForPidExitWithEscalation,
} from "./launchd.js";

const state = vi.hoisted(() => ({
  launchctlCalls: [] as string[][],
  listOutput: "",
  printOutput: "",
  bootstrapError: "",
  // Bootstrap errors to return sequentially (shifts on each bootstrap call).
  // When empty, falls back to bootstrapError for all remaining calls.
  bootstrapErrorSequence: [] as string[],
  dirs: new Set<string>(),
  dirModes: new Map<string, number>(),
  files: new Map<string, string>(),
  fileModes: new Map<string, number>(),
}));
const defaultProgramArguments = ["node", "-e", "process.exit(0)"];

function normalizeLaunchctlArgs(file: string, args: string[]): string[] {
  if (file === "launchctl") {
    return args;
  }
  const idx = args.indexOf("launchctl");
  if (idx >= 0) {
    return args.slice(idx + 1);
  }
  return args;
}

vi.mock("./exec-file.js", () => ({
  execFileUtf8: vi.fn(async (file: string, args: string[]) => {
    const call = normalizeLaunchctlArgs(file, args);
    state.launchctlCalls.push(call);
    if (call[0] === "list") {
      return { stdout: state.listOutput, stderr: "", code: 0 };
    }
    if (call[0] === "print") {
      return { stdout: state.printOutput, stderr: "", code: 0 };
    }
    if (call[0] === "bootstrap") {
      const seqError = state.bootstrapErrorSequence.shift();
      const err = seqError ?? state.bootstrapError;
      if (err) {
        return { stdout: "", stderr: err, code: 1 };
      }
    }
    return { stdout: "", stderr: "", code: 0 };
  }),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const wrapped = {
    ...actual,
    access: vi.fn(async (p: string) => {
      const key = String(p);
      if (state.files.has(key) || state.dirs.has(key)) {
        return;
      }
      throw new Error(`ENOENT: no such file or directory, access '${key}'`);
    }),
    mkdir: vi.fn(async (p: string, opts?: { mode?: number }) => {
      const key = String(p);
      state.dirs.add(key);
      state.dirModes.set(key, opts?.mode ?? 0o777);
    }),
    stat: vi.fn(async (p: string) => {
      const key = String(p);
      if (state.dirs.has(key)) {
        return { mode: state.dirModes.get(key) ?? 0o777 };
      }
      if (state.files.has(key)) {
        return { mode: state.fileModes.get(key) ?? 0o666 };
      }
      throw new Error(`ENOENT: no such file or directory, stat '${key}'`);
    }),
    chmod: vi.fn(async (p: string, mode: number) => {
      const key = String(p);
      if (state.dirs.has(key)) {
        state.dirModes.set(key, mode);
        return;
      }
      if (state.files.has(key)) {
        state.fileModes.set(key, mode);
        return;
      }
      throw new Error(`ENOENT: no such file or directory, chmod '${key}'`);
    }),
    unlink: vi.fn(async (p: string) => {
      state.files.delete(String(p));
    }),
    writeFile: vi.fn(async (p: string, data: string, opts?: { mode?: number }) => {
      const key = String(p);
      state.files.set(key, data);
      state.dirs.add(String(key.split("/").slice(0, -1).join("/")));
      state.fileModes.set(key, opts?.mode ?? 0o666);
    }),
  };
  return { ...wrapped, default: wrapped };
});

beforeEach(() => {
  state.launchctlCalls.length = 0;
  state.listOutput = "";
  state.printOutput = "";
  state.bootstrapError = "";
  state.bootstrapErrorSequence.length = 0;
  state.dirs.clear();
  state.dirModes.clear();
  state.files.clear();
  state.fileModes.clear();
  vi.clearAllMocks();
});

describe("launchd runtime parsing", () => {
  it("parses state, pid, and exit status", () => {
    const output = [
      "state = running",
      "pid = 4242",
      "last exit status = 1",
      "last exit reason = exited",
    ].join("\n");
    expect(parseLaunchctlPrint(output)).toEqual({
      state: "running",
      pid: 4242,
      lastExitStatus: 1,
      lastExitReason: "exited",
    });
  });

  it("does not set pid when pid = 0", () => {
    const output = ["state = running", "pid = 0"].join("\n");
    const info = parseLaunchctlPrint(output);
    expect(info.pid).toBeUndefined();
    expect(info.state).toBe("running");
  });

  it("sets pid for positive values", () => {
    const output = ["state = running", "pid = 1234"].join("\n");
    const info = parseLaunchctlPrint(output);
    expect(info.pid).toBe(1234);
  });

  it("does not set pid for negative values", () => {
    const output = ["state = waiting", "pid = -1"].join("\n");
    const info = parseLaunchctlPrint(output);
    expect(info.pid).toBeUndefined();
    expect(info.state).toBe("waiting");
  });

  it("rejects pid and exit status values with junk suffixes", () => {
    const output = [
      "state = waiting",
      "pid = 123abc",
      "last exit status = 7ms",
      "last exit reason = exited",
    ].join("\n");
    expect(parseLaunchctlPrint(output)).toEqual({
      state: "waiting",
      lastExitReason: "exited",
    });
  });
});

describe("launchctl list detection", () => {
  it("detects the resolved label in launchctl list", async () => {
    state.listOutput = "123 0 ai.openclaw.gateway\n";
    const listed = await isLaunchAgentListed({
      env: { HOME: "/Users/test", OPENCLAW_PROFILE: "default" },
    });
    expect(listed).toBe(true);
  });

  it("returns false when the label is missing", async () => {
    state.listOutput = "123 0 com.other.service\n";
    const listed = await isLaunchAgentListed({
      env: { HOME: "/Users/test", OPENCLAW_PROFILE: "default" },
    });
    expect(listed).toBe(false);
  });
});

describe("launchd bootstrap repair", () => {
  it("retries bootstrap on EIO and recovers", async () => {
    const eioError = "Bootstrap failed: 5: Input/output error";
    state.bootstrapErrorSequence.push(eioError);

    const env: Record<string, string | undefined> = {
      HOME: "/Users/test",
      OPENCLAW_PROFILE: "default",
    };

    vi.useFakeTimers();
    try {
      const repairPromise = repairLaunchAgentBootstrap({ env });
      await vi.advanceTimersByTimeAsync(1000);
      const repair = await repairPromise;
      expect(repair.ok).toBe(true);
      // Initial attempt (EIO) + one retry = 2 bootstrap calls.
      expect(state.launchctlCalls.filter((c) => c[0] === "bootstrap").length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("enables, bootstraps, and kickstarts the resolved label", async () => {
    const env: Record<string, string | undefined> = {
      HOME: "/Users/test",
      OPENCLAW_PROFILE: "default",
    };
    const repair = await repairLaunchAgentBootstrap({ env });
    expect(repair.ok).toBe(true);

    const domain = typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501";
    const label = "ai.openclaw.gateway";
    const plistPath = resolveLaunchAgentPlistPath(env);
    const serviceId = `${domain}/${label}`;

    const enableIndex = state.launchctlCalls.findIndex(
      (c) => c[0] === "enable" && c[1] === serviceId,
    );
    const bootstrapIndex = state.launchctlCalls.findIndex(
      (c) => c[0] === "bootstrap" && c[1] === domain && c[2] === plistPath,
    );
    const kickstartIndex = state.launchctlCalls.findIndex(
      (c) => c[0] === "kickstart" && c[1] === "-k" && c[2] === serviceId,
    );

    expect(enableIndex).toBeGreaterThanOrEqual(0);
    expect(bootstrapIndex).toBeGreaterThanOrEqual(0);
    expect(kickstartIndex).toBeGreaterThanOrEqual(0);
    expect(enableIndex).toBeLessThan(bootstrapIndex);
    expect(bootstrapIndex).toBeLessThan(kickstartIndex);
  });
});

describe("launchd install", () => {
  function createDefaultLaunchdEnv(): Record<string, string | undefined> {
    return {
      HOME: "/Users/test",
      OPENCLAW_PROFILE: "default",
    };
  }

  it("enables service before bootstrap (clears persisted disabled state)", async () => {
    const env = createDefaultLaunchdEnv();
    await installLaunchAgent({
      env,
      stdout: new PassThrough(),
      programArguments: defaultProgramArguments,
    });

    const domain = typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501";
    const label = "ai.openclaw.gateway";
    const plistPath = resolveLaunchAgentPlistPath(env);
    const serviceId = `${domain}/${label}`;

    const enableIndex = state.launchctlCalls.findIndex(
      (c) => c[0] === "enable" && c[1] === serviceId,
    );
    const bootstrapIndex = state.launchctlCalls.findIndex(
      (c) => c[0] === "bootstrap" && c[1] === domain && c[2] === plistPath,
    );
    expect(enableIndex).toBeGreaterThanOrEqual(0);
    expect(bootstrapIndex).toBeGreaterThanOrEqual(0);
    expect(enableIndex).toBeLessThan(bootstrapIndex);
  });

  it("writes TMPDIR to LaunchAgent environment when provided", async () => {
    const env = createDefaultLaunchdEnv();
    const tmpDir = "/var/folders/xy/abc123/T/";
    await installLaunchAgent({
      env,
      stdout: new PassThrough(),
      programArguments: defaultProgramArguments,
      environment: { TMPDIR: tmpDir },
    });

    const plistPath = resolveLaunchAgentPlistPath(env);
    const plist = state.files.get(plistPath) ?? "";
    expect(plist).toContain("<key>EnvironmentVariables</key>");
    expect(plist).toContain("<key>TMPDIR</key>");
    expect(plist).toContain(`<string>${tmpDir}</string>`);
  });

  it("writes KeepAlive=true policy with restrictive umask", async () => {
    const env = createDefaultLaunchdEnv();
    await installLaunchAgent({
      env,
      stdout: new PassThrough(),
      programArguments: defaultProgramArguments,
    });

    const plistPath = resolveLaunchAgentPlistPath(env);
    const plist = state.files.get(plistPath) ?? "";
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<true/>");
    expect(plist).not.toContain("<key>SuccessfulExit</key>");
    expect(plist).toContain("<key>Umask</key>");
    expect(plist).toContain(`<integer>${LAUNCH_AGENT_UMASK_DECIMAL}</integer>`);
    expect(plist).toContain("<key>ThrottleInterval</key>");
    expect(plist).toContain(`<integer>${LAUNCH_AGENT_THROTTLE_INTERVAL_SECONDS}</integer>`);
  });

  it("tightens writable bits on launch agent dirs and plist", async () => {
    const env = createDefaultLaunchdEnv();
    state.dirs.add(env.HOME!);
    state.dirModes.set(env.HOME!, 0o777);
    state.dirs.add("/Users/test/Library");
    state.dirModes.set("/Users/test/Library", 0o777);

    await installLaunchAgent({
      env,
      stdout: new PassThrough(),
      programArguments: defaultProgramArguments,
    });

    const plistPath = resolveLaunchAgentPlistPath(env);
    expect(state.dirModes.get(env.HOME!)).toBe(0o755);
    expect(state.dirModes.get("/Users/test/Library")).toBe(0o755);
    expect(state.dirModes.get("/Users/test/Library/LaunchAgents")).toBe(0o755);
    expect(state.fileModes.get(plistPath)).toBe(0o644);
  });

  it("restarts LaunchAgent with bootout-enable-bootstrap-kickstart order", async () => {
    const env = createDefaultLaunchdEnv();
    await restartLaunchAgent({
      env,
      stdout: new PassThrough(),
    });

    const domain = typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501";
    const label = "ai.openclaw.gateway";
    const plistPath = resolveLaunchAgentPlistPath(env);
    const serviceId = `${domain}/${label}`;
    const bootoutIndex = state.launchctlCalls.findIndex(
      (c) => c[0] === "bootout" && c[1] === serviceId,
    );
    const enableIndex = state.launchctlCalls.findIndex(
      (c) => c[0] === "enable" && c[1] === serviceId,
    );
    const bootstrapIndex = state.launchctlCalls.findIndex(
      (c) => c[0] === "bootstrap" && c[1] === domain && c[2] === plistPath,
    );
    const kickstartIndex = state.launchctlCalls.findIndex(
      (c) => c[0] === "kickstart" && c[1] === "-k" && c[2] === serviceId,
    );

    expect(bootoutIndex).toBeGreaterThanOrEqual(0);
    expect(enableIndex).toBeGreaterThanOrEqual(0);
    expect(bootstrapIndex).toBeGreaterThanOrEqual(0);
    expect(kickstartIndex).toBeGreaterThanOrEqual(0);
    expect(bootoutIndex).toBeLessThan(enableIndex);
    expect(enableIndex).toBeLessThan(bootstrapIndex);
    expect(bootstrapIndex).toBeLessThan(kickstartIndex);
  });

  it("waits for previous launchd pid to exit before bootstrapping", async () => {
    const env = createDefaultLaunchdEnv();
    state.printOutput = ["state = running", "pid = 4242"].join("\n");
    const killSpy = vi.spyOn(process, "kill");
    killSpy
      .mockImplementationOnce(() => true) // first kill(4242, 0): alive
      .mockImplementationOnce(() => {
        // second kill(4242, 0): gone
        const err = new Error("no such process") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      });

    vi.useFakeTimers();
    try {
      const restartPromise = restartLaunchAgent({
        env,
        stdout: new PassThrough(),
      });
      await vi.advanceTimersByTimeAsync(250);
      await restartPromise;
      expect(killSpy).toHaveBeenCalledWith(4242, 0);
      const domain = typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501";
      const label = "ai.openclaw.gateway";
      const bootoutIndex = state.launchctlCalls.findIndex(
        (c) => c[0] === "bootout" && c[1] === `${domain}/${label}`,
      );
      const bootstrapIndex = state.launchctlCalls.findIndex((c) => c[0] === "bootstrap");
      expect(bootoutIndex).toBeGreaterThanOrEqual(0);
      expect(bootstrapIndex).toBeGreaterThanOrEqual(0);
      expect(bootoutIndex).toBeLessThan(bootstrapIndex);
    } finally {
      vi.useRealTimers();
      killSpy.mockRestore();
    }
  });

  it("bootstrap retries on EIO and succeeds when process finally exits", async () => {
    const env = createDefaultLaunchdEnv();
    const eioError = "Bootstrap failed: 5: Input/output error";
    // First two bootstrap attempts return EIO; third succeeds.
    state.bootstrapErrorSequence.push(eioError, eioError);

    vi.useFakeTimers();
    try {
      const restartPromise = restartLaunchAgent({ env, stdout: new PassThrough() });
      // Advance through both retry delays (500 ms + 1000 ms).
      await vi.advanceTimersByTimeAsync(2000);
      await restartPromise;
      const bootstrapCalls = state.launchctlCalls.filter((c) => c[0] === "bootstrap");
      expect(bootstrapCalls.length).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bootstrap does not retry on non-EIO errors", async () => {
    const env = createDefaultLaunchdEnv();
    state.bootstrapError = "Operation not permitted";

    await expect(restartLaunchAgent({ env, stdout: new PassThrough() })).rejects.toThrow(
      "launchctl bootstrap failed: Operation not permitted",
    );
    const bootstrapCalls = state.launchctlCalls.filter((c) => c[0] === "bootstrap");
    expect(bootstrapCalls.length).toBe(1);
  });

  it("shows actionable guidance when launchctl gui domain does not support bootstrap", async () => {
    state.bootstrapError = "Bootstrap failed: 125: Domain does not support specified action";
    const env = createDefaultLaunchdEnv();
    let message = "";
    try {
      await installLaunchAgent({
        env,
        stdout: new PassThrough(),
        programArguments: defaultProgramArguments,
      });
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("logged-in macOS GUI session");
    expect(message).toContain("wrong user (including sudo)");
    expect(message).toContain("https://docs.openclaw.ai/gateway");
  });

  it("surfaces generic bootstrap failures without GUI-specific guidance", async () => {
    state.bootstrapError = "Operation not permitted";
    const env = createDefaultLaunchdEnv();

    await expect(
      installLaunchAgent({
        env,
        stdout: new PassThrough(),
        programArguments: defaultProgramArguments,
      }),
    ).rejects.toThrow("launchctl bootstrap failed: Operation not permitted");
  });
});

describe("waitForPidExitWithEscalation", () => {
  it("returns immediately when pid is invalid", async () => {
    // No kill calls should be made for invalid pids (0, -1, NaN, 1, Infinity).
    const killSpy = vi.spyOn(process, "kill");
    await waitForPidExitWithEscalation(0);
    await waitForPidExitWithEscalation(-1);
    await waitForPidExitWithEscalation(NaN);
    await waitForPidExitWithEscalation(1);
    await waitForPidExitWithEscalation(Infinity);
    expect(killSpy).not.toHaveBeenCalled();
    killSpy.mockRestore();
  });

  it("returns immediately when the process is already gone (ESRCH on first check)", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      const err = new Error("no such process") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    });
    await waitForPidExitWithEscalation(9999);
    expect(killSpy).toHaveBeenCalledTimes(1);
    killSpy.mockRestore();
  });

  it("escalates to SIGKILL after the graceful window and resolves once the process exits", async () => {
    let sigkillReceived = false;
    let probesAfterKill = 0;

    const killSpy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (signal === "SIGKILL") {
        sigkillReceived = true;
        return true;
      }
      if (signal === 0) {
        if (!sigkillReceived) {
          // Still in graceful window — report alive.
          return true;
        }
        probesAfterKill++;
        if (probesAfterKill >= 2) {
          // Process reaped after two post-SIGKILL probes.
          const err = new Error("no such process") as NodeJS.ErrnoException;
          err.code = "ESRCH";
          throw err;
        }
        return true;
      }
      return true;
    });

    vi.useFakeTimers();
    try {
      const waitPromise = waitForPidExitWithEscalation(1234);
      // Advance past the graceful window (15 s) to trigger SIGKILL.
      await vi.advanceTimersByTimeAsync(15_200);
      // Advance through the post-SIGKILL polling window.
      await vi.advanceTimersByTimeAsync(600);
      await waitPromise;

      expect(sigkillReceived).toBe(true);
      expect(killSpy).toHaveBeenCalledWith(1234, "SIGKILL");
    } finally {
      vi.useRealTimers();
      killSpy.mockRestore();
    }
  });

  it("does not send SIGKILL when process exits at the graceful deadline", async () => {
    // Simulate process exiting during the last sleep before the deadline.
    // The final isProcessAlive guard before SIGKILL must prevent sending SIGKILL.
    let callCount = 0;
    const killSpy = vi.spyOn(process, "kill").mockImplementation((_, signal) => {
      if (signal === 0) {
        callCount++;
        if (callCount >= 2) {
          // Gone before SIGKILL is attempted.
          const err = new Error("no such process") as NodeJS.ErrnoException;
          err.code = "ESRCH";
          throw err;
        }
        return true;
      }
      return true;
    });

    vi.useFakeTimers();
    try {
      const waitPromise = waitForPidExitWithEscalation(7777);
      // Advance past the graceful window so the loop exits.
      await vi.advanceTimersByTimeAsync(15_200);
      await waitPromise;
      // SIGKILL must not have been sent because the final guard detected exit.
      expect(killSpy).not.toHaveBeenCalledWith(7777, "SIGKILL");
    } finally {
      vi.useRealTimers();
      killSpy.mockRestore();
    }
  });

  it("treats EPERM as process-alive and continues waiting", async () => {
    let callCount = 0;
    const killSpy = vi.spyOn(process, "kill").mockImplementation((_, signal) => {
      if (signal === 0) {
        callCount++;
        if (callCount === 1) {
          // First check: EPERM means process exists (different user).
          const err = new Error("operation not permitted") as NodeJS.ErrnoException;
          err.code = "EPERM";
          throw err;
        }
        // Second check: ESRCH means gone.
        const err = new Error("no such process") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      }
      return true;
    });

    vi.useFakeTimers();
    try {
      const waitPromise = waitForPidExitWithEscalation(5678);
      await vi.advanceTimersByTimeAsync(400);
      await waitPromise;
      // Must have probed at least twice (EPERM then ESRCH).
      expect(callCount).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
      killSpy.mockRestore();
    }
  });
});

describe("bootstrapWithRetry", () => {
  const domain = typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501";
  const plistPath = "/Users/test/Library/LaunchAgents/ai.openclaw.gateway.plist";

  it("returns success immediately when bootstrap succeeds on the first attempt", async () => {
    const result = await bootstrapWithRetry(domain, plistPath);
    expect(result.code).toBe(0);
    const bootstrapCalls = state.launchctlCalls.filter((c) => c[0] === "bootstrap");
    expect(bootstrapCalls.length).toBe(1);
  });

  it("retries on EIO and succeeds once the process table clears", async () => {
    const eioMsg = "Bootstrap failed: 5: Input/output error";
    state.bootstrapErrorSequence.push(eioMsg, eioMsg);

    vi.useFakeTimers();
    try {
      const retryPromise = bootstrapWithRetry(domain, plistPath);
      // Advance through retry delays: 500 ms, 1000 ms.
      await vi.advanceTimersByTimeAsync(2000);
      const result = await retryPromise;
      expect(result.code).toBe(0);
      const bootstrapCalls = state.launchctlCalls.filter((c) => c[0] === "bootstrap");
      expect(bootstrapCalls.length).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("also retries on the 'input/output error' message variant", async () => {
    // Some macOS versions emit the text without the errno prefix.
    state.bootstrapErrorSequence.push("Bootstrap failed: input/output error");

    vi.useFakeTimers();
    try {
      const retryPromise = bootstrapWithRetry(domain, plistPath);
      await vi.advanceTimersByTimeAsync(1000);
      const result = await retryPromise;
      expect(result.code).toBe(0);
      const bootstrapCalls = state.launchctlCalls.filter((c) => c[0] === "bootstrap");
      expect(bootstrapCalls.length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry on unsupported GUI domain error (errno 125)", async () => {
    state.bootstrapError = "Bootstrap failed: 125: Domain does not support specified action";
    const result = await bootstrapWithRetry(domain, plistPath);
    expect(result.code).toBe(1);
    const bootstrapCalls = state.launchctlCalls.filter((c) => c[0] === "bootstrap");
    expect(bootstrapCalls.length).toBe(1);
  });

  it("does not retry on generic permission errors", async () => {
    state.bootstrapError = "Operation not permitted";
    const result = await bootstrapWithRetry(domain, plistPath);
    expect(result.code).toBe(1);
    expect(state.launchctlCalls.filter((c) => c[0] === "bootstrap").length).toBe(1);
  });

  it("exhausts all retries and returns the last failure when EIO persists", async () => {
    const eioMsg = "Bootstrap failed: 5: Input/output error";
    // Fill all 4 retry slots + the initial attempt = 5 EIO failures.
    for (let i = 0; i < 5; i++) {
      state.bootstrapErrorSequence.push(eioMsg);
    }

    vi.useFakeTimers();
    try {
      const retryPromise = bootstrapWithRetry(domain, plistPath);
      // Exponential delays: 500+1000+2000+4000 = 7500 ms total.
      await vi.advanceTimersByTimeAsync(8_000);
      const result = await retryPromise;
      expect(result.code).toBe(1);
      expect((result.stderr || result.stdout).trim()).toBe(eioMsg);
      // Initial attempt + 4 retries = 5 bootstrap calls.
      expect(state.launchctlCalls.filter((c) => c[0] === "bootstrap").length).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("resolveLaunchAgentPlistPath", () => {
  it.each([
    {
      name: "uses default label when OPENCLAW_PROFILE is unset",
      env: { HOME: "/Users/test" },
      expected: "/Users/test/Library/LaunchAgents/ai.openclaw.gateway.plist",
    },
    {
      name: "uses profile-specific label when OPENCLAW_PROFILE is set to a custom value",
      env: { HOME: "/Users/test", OPENCLAW_PROFILE: "jbphoenix" },
      expected: "/Users/test/Library/LaunchAgents/ai.openclaw.jbphoenix.plist",
    },
    {
      name: "prefers OPENCLAW_LAUNCHD_LABEL over OPENCLAW_PROFILE",
      env: {
        HOME: "/Users/test",
        OPENCLAW_PROFILE: "jbphoenix",
        OPENCLAW_LAUNCHD_LABEL: "com.custom.label",
      },
      expected: "/Users/test/Library/LaunchAgents/com.custom.label.plist",
    },
    {
      name: "trims whitespace from OPENCLAW_LAUNCHD_LABEL",
      env: {
        HOME: "/Users/test",
        OPENCLAW_LAUNCHD_LABEL: "  com.custom.label  ",
      },
      expected: "/Users/test/Library/LaunchAgents/com.custom.label.plist",
    },
    {
      name: "ignores empty OPENCLAW_LAUNCHD_LABEL and falls back to profile",
      env: {
        HOME: "/Users/test",
        OPENCLAW_PROFILE: "myprofile",
        OPENCLAW_LAUNCHD_LABEL: "   ",
      },
      expected: "/Users/test/Library/LaunchAgents/ai.openclaw.myprofile.plist",
    },
  ])("$name", ({ env, expected }) => {
    expect(resolveLaunchAgentPlistPath(env)).toBe(expected);
  });
});
