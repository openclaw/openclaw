import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LAUNCH_AGENT_THROTTLE_INTERVAL_SECONDS } from "./launchd-plist.js";
import {
  installLaunchAgent,
  isLaunchAgentListed,
  parseLaunchctlPrint,
  repairLaunchAgentBootstrap,
  resolveLaunchAgentPlistPath,
  restartLaunchAgent,
} from "./launchd.js";

function createDefaultLaunchdEnv(): Record<string, string | undefined> {
  return { HOME: "/Users/test", BOT_PROFILE: "default" };
}

const defaultProgramArguments = ["node", "-e", "process.exit(0)"];

const state = vi.hoisted(() => ({
  launchctlCalls: [] as string[][],
  listOutput: "",
  printOutput: "",
  bootstrapError: "" as string | undefined,
  dirs: new Set<string>(),
  files: new Map<string, string>(),
}));

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
    if (call[0] === "bootstrap" && state.bootstrapError) {
      return { stdout: "", stderr: state.bootstrapError, code: 1 };
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
  state.bootstrapError = undefined;
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
});

describe("launchctl list detection", () => {
  it("detects the resolved label in launchctl list", async () => {
    state.listOutput = "123 0 ai.hanzo.bot.gateway\n";
    const listed = await isLaunchAgentListed({
      env: { HOME: "/Users/test", BOT_PROFILE: "default" },
    });
    expect(listed).toBe(true);
  });

  it("returns false when the label is missing", async () => {
    state.listOutput = "123 0 com.other.service\n";
    const listed = await isLaunchAgentListed({
      env: { HOME: "/Users/test", BOT_PROFILE: "default" },
    });
    expect(listed).toBe(false);
  });
});

describe("launchd bootstrap repair", () => {
  it("bootstraps and kickstarts the resolved label", async () => {
    const env: Record<string, string | undefined> = {
      HOME: "/Users/test",
      BOT_PROFILE: "default",
    };
    const repair = await repairLaunchAgentBootstrap({ env });
    expect(repair.ok).toBe(true);

    const domain = typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501";
    const label = "ai.hanzo.bot.gateway";
    const plistPath = resolveLaunchAgentPlistPath(env);

    expect(state.launchctlCalls).toContainEqual(["bootstrap", domain, plistPath]);
    expect(state.launchctlCalls).toContainEqual(["kickstart", "-k", `${domain}/${label}`]);
  });
});

describe("launchd install", () => {
  it("enables service before bootstrap (clears persisted disabled state)", async () => {
    const env: Record<string, string | undefined> = {
      HOME: "/Users/test",
      BOT_PROFILE: "default",
    };
    await installLaunchAgent({
      env,
      stdout: new PassThrough(),
      programArguments: ["node", "-e", "process.exit(0)"],
    });

    const domain = typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501";
    const label = "ai.hanzo.bot.gateway";
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

  it("writes KeepAlive=true policy", async () => {
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
    const label = "ai.hanzo.bot.gateway";
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
      const label = "ai.hanzo.bot.gateway";
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
    expect(message).toContain("https://docs.hanzo.bot/gateway");
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
  it("uses default label when BOT_PROFILE is unset", () => {
    const env = { HOME: "/Users/test" };
    expect(resolveLaunchAgentPlistPath(env)).toBe(
      "/Users/test/Library/LaunchAgents/ai.hanzo.bot.gateway.plist",
    );
  });

  it("uses profile-specific label when BOT_PROFILE is set to a custom value", () => {
    const env = { HOME: "/Users/test", BOT_PROFILE: "jbphoenix" };
    expect(resolveLaunchAgentPlistPath(env)).toBe(
      "/Users/test/Library/LaunchAgents/ai.hanzo.bot.jbphoenix.plist",
    );
  });

  it("prefers BOT_LAUNCHD_LABEL over BOT_PROFILE", () => {
    const env = {
      HOME: "/Users/test",
      BOT_PROFILE: "jbphoenix",
      BOT_LAUNCHD_LABEL: "com.custom.label",
    };
    expect(resolveLaunchAgentPlistPath(env)).toBe(
      "/Users/test/Library/LaunchAgents/com.custom.label.plist",
    );
  });

  it("trims whitespace from BOT_LAUNCHD_LABEL", () => {
    const env = {
      HOME: "/Users/test",
      BOT_LAUNCHD_LABEL: "  com.custom.label  ",
    };
    expect(resolveLaunchAgentPlistPath(env)).toBe(
      "/Users/test/Library/LaunchAgents/com.custom.label.plist",
    );
  });

  it("ignores empty BOT_LAUNCHD_LABEL and falls back to profile", () => {
    const env = {
      HOME: "/Users/test",
      BOT_PROFILE: "myprofile",
      BOT_LAUNCHD_LABEL: "   ",
    };
    expect(resolveLaunchAgentPlistPath(env)).toBe(
      "/Users/test/Library/LaunchAgents/ai.hanzo.bot.myprofile.plist",
    );
  });
});
