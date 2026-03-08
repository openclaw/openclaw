import path from "node:path";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  LAUNCH_AGENT_THROTTLE_INTERVAL_SECONDS,
  LAUNCH_AGENT_UMASK_DECIMAL,
} from "./launchd-plist.js";
import {
  installLaunchAgent,
  isLaunchAgentListed,
  isLaunchAgentLoaded,
  parseLaunchctlPrint,
  repairLaunchAgentBootstrap,
  restartLaunchAgent,
  resolveLaunchAgentPlistPath,
  stopLaunchAgent,
} from "./launchd.js";

const state = vi.hoisted(() => ({
  launchctlCalls: [] as string[][],
  listOutput: "",
  printOutput: "",
  bootstrapError: "",
  killError: "",
  loadedTargets: new Set<string>(),
  dirs: new Set<string>(),
  files: new Map<string, string>(),
}));
const defaultProgramArguments = ["node", "-e", "process.exit(0)"];

function resolveGuiDomain(): string {
  return typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501";
}

function createDefaultLaunchdEnv(): Record<string, string | undefined> {
  return {
    HOME: "/Users/test",
    OPENCLAW_PROFILE: "default",
  };
}

function resolveDefaultServiceTarget(): string {
  return `${resolveGuiDomain()}/ai.openclaw.gateway`;
}

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
      const target = call[1] ?? "";
      if (state.loadedTargets.has(target)) {
        return { stdout: "state = running\npid = 4242\n", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "Could not find service", code: 1 };
    }
    if (call[0] === "bootstrap") {
      if (state.bootstrapError) {
        return { stdout: "", stderr: state.bootstrapError, code: 1 };
      }
      const domain = call[1] ?? "";
      const plistPath = call[2] ?? "";
      if (domain && plistPath) {
        const label = path.posix.basename(plistPath, ".plist");
        state.loadedTargets.add(`${domain}/${label}`);
      }
      return { stdout: "", stderr: "", code: 0 };
    }
    if (call[0] === "bootout") {
      const domain = call[1] ?? "";
      const target =
        call[2] && call[2].endsWith(".plist")
          ? `${domain}/${path.posix.basename(call[2], ".plist")}`
          : domain;
      if (target) {
        state.loadedTargets.delete(target);
      }
      return { stdout: "", stderr: "", code: 0 };
    }
    if (call[0] === "kickstart") {
      const target = call.at(-1);
      if (target) {
        state.loadedTargets.add(target);
      }
      return { stdout: "", stderr: "", code: 0 };
    }
    if (call[0] === "kill" && state.killError) {
      return { stdout: "", stderr: state.killError, code: 1 };
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
    mkdir: vi.fn(async (p: string) => {
      state.dirs.add(String(p));
    }),
    unlink: vi.fn(async (p: string) => {
      state.files.delete(String(p));
    }),
    writeFile: vi.fn(async (p: string, data: string) => {
      const key = String(p);
      state.files.set(key, data);
      state.dirs.add(String(key.split("/").slice(0, -1).join("/")));
    }),
  };
  return { ...wrapped, default: wrapped };
});

beforeEach(() => {
  state.launchctlCalls.length = 0;
  state.listOutput = "";
  state.printOutput = "";
  state.bootstrapError = "";
  state.killError = "";
  state.loadedTargets.clear();
  state.loadedTargets.add(resolveDefaultServiceTarget());
  state.dirs.clear();
  state.files.clear();
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
  it("bootstraps and kickstarts the resolved label", async () => {
    const env: Record<string, string | undefined> = {
      HOME: "/Users/test",
      OPENCLAW_PROFILE: "default",
    };
    const repair = await repairLaunchAgentBootstrap({ env });
    expect(repair.ok).toBe(true);

    const domain = typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501";
    const label = "ai.openclaw.gateway";
    const plistPath = resolveLaunchAgentPlistPath(env);

    expect(state.launchctlCalls).toContainEqual(["bootstrap", domain, plistPath]);
    expect(state.launchctlCalls).toContainEqual(["kickstart", "-k", `${domain}/${label}`]);
  });
});

describe("launchd stop", () => {
  it("kills the process without unloading LaunchAgent registration", async () => {
    const env = createDefaultLaunchdEnv();
    const serviceTarget = resolveDefaultServiceTarget();

    await stopLaunchAgent({
      env,
      stdout: new PassThrough(),
    });

    expect(state.launchctlCalls).toContainEqual(["kill", "SIGTERM", serviceTarget]);
    expect(state.launchctlCalls.some((call) => call[0] === "bootout")).toBe(false);
    await expect(isLaunchAgentLoaded({ env })).resolves.toBe(true);
  });

  it("treats missing launchd process as already stopped", async () => {
    state.killError = "No such process";
    await expect(
      stopLaunchAgent({
        env: createDefaultLaunchdEnv(),
        stdout: new PassThrough(),
      }),
    ).resolves.toBeUndefined();
  });
});

describe("launchd install", () => {
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

  it("restarts LaunchAgent with bootout-bootstrap-kickstart order", async () => {
    const env = createDefaultLaunchdEnv();
    await restartLaunchAgent({
      env,
      stdout: new PassThrough(),
    });

    const domain = typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501";
    const label = "ai.openclaw.gateway";
    const plistPath = resolveLaunchAgentPlistPath(env);
    const bootoutIndex = state.launchctlCalls.findIndex(
      (c) => c[0] === "bootout" && c[1] === `${domain}/${label}`,
    );
    const bootstrapIndex = state.launchctlCalls.findIndex(
      (c) => c[0] === "bootstrap" && c[1] === domain && c[2] === plistPath,
    );
    const kickstartIndex = state.launchctlCalls.findIndex(
      (c) => c[0] === "kickstart" && c[1] === "-k" && c[2] === `${domain}/${label}`,
    );

    expect(bootoutIndex).toBeGreaterThanOrEqual(0);
    expect(bootstrapIndex).toBeGreaterThanOrEqual(0);
    expect(kickstartIndex).toBeGreaterThanOrEqual(0);
    expect(bootoutIndex).toBeLessThan(bootstrapIndex);
    expect(bootstrapIndex).toBeLessThan(kickstartIndex);
  });

  it("waits for previous launchd pid to exit before bootstrapping", async () => {
    const env = createDefaultLaunchdEnv();
    state.printOutput = ["state = running", "pid = 4242"].join("\n");
    const killSpy = vi.spyOn(process, "kill");
    killSpy
      .mockImplementationOnce(() => true)
      .mockImplementationOnce(() => {
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
