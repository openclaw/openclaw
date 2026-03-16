import { constants as fsConstants } from "node:fs";
import os from "node:os";
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
  parseLaunchctlPrint,
  repairLaunchAgentBootstrap,
  restartLaunchAgent,
  resolveLaunchAgentPlistPath,
} from "./launchd.js";

const state = vi.hoisted(() => ({
  launchctlCalls: [] as string[][],
  listOutput: "",
  printOutput: "",
  bootstrapError: "",
  kickstartError: "",
  kickstartFailuresRemaining: 0,
  dirs: new Set<string>(),
  symlinks: new Set<string>(),
  dirModes: new Map<string, number>(),
  files: new Map<string, string>(),
  fileModes: new Map<string, number>(),
}));

vi.mock("node:os", () => ({
  default: {
    homedir: vi.fn(() => "/Users/test"),
    userInfo: vi.fn(() => ({ homedir: "/Users/test" })),
  },
  homedir: vi.fn(() => "/Users/test"),
  userInfo: vi.fn(() => ({ homedir: "/Users/test" })),
}));
const launchdRestartHandoffState = vi.hoisted(() => ({
  isCurrentProcessLaunchdServiceLabel: vi.fn<(label: string) => boolean>(() => false),
  scheduleDetachedLaunchdRestartHandoff: vi.fn((_params: unknown) => ({ ok: true, pid: 7331 })),
}));
const cleanStaleGatewayProcessesSync = vi.hoisted(() =>
  vi.fn<(port?: number) => number[]>(() => []),
);
const defaultProgramArguments = ["node", "-e", "process.exit(0)"];

function expectLaunchctlEnableBootstrapOrder(env: Record<string, string | undefined>) {
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

  return { domain, label, serviceId, bootstrapIndex };
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
      return { stdout: state.printOutput, stderr: "", code: 0 };
    }
    if (call[0] === "bootstrap" && state.bootstrapError) {
      return { stdout: "", stderr: state.bootstrapError, code: 1 };
    }
    if (call[0] === "kickstart" && state.kickstartError && state.kickstartFailuresRemaining > 0) {
      state.kickstartFailuresRemaining -= 1;
      return { stdout: "", stderr: state.kickstartError, code: 1 };
    }
    return { stdout: "", stderr: "", code: 0 };
  }),
}));

vi.mock("./launchd-restart-handoff.js", () => ({
  isCurrentProcessLaunchdServiceLabel: (label: string) =>
    launchdRestartHandoffState.isCurrentProcessLaunchdServiceLabel(label),
  scheduleDetachedLaunchdRestartHandoff: (params: unknown) =>
    launchdRestartHandoffState.scheduleDetachedLaunchdRestartHandoff(params),
}));

vi.mock("../infra/restart-stale-pids.js", () => ({
  cleanStaleGatewayProcessesSync: (port?: number) => cleanStaleGatewayProcessesSync(port),
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
      if (state.symlinks.has(key)) {
        return;
      }
      state.dirs.add(key);
      state.dirModes.set(key, opts?.mode ?? 0o777);
    }),
    lstat: vi.fn(async (p: string) => {
      const key = String(p);
      if (state.symlinks.has(key)) {
        return {
          mode: 0o777,
          isDirectory: () => false,
          isSymbolicLink: () => true,
        };
      }
      if (state.dirs.has(key)) {
        return {
          mode: state.dirModes.get(key) ?? 0o777,
          isDirectory: () => true,
          isSymbolicLink: () => false,
        };
      }
      if (state.files.has(key)) {
        return {
          mode: state.fileModes.get(key) ?? 0o666,
          isDirectory: () => false,
          isSymbolicLink: () => false,
        };
      }
      const error = new Error(
        `ENOENT: no such file or directory, lstat '${key}'`,
      ) as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
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
    open: vi.fn(async (p: string, _flags?: number, mode?: number) => {
      const key = String(p);
      if (state.symlinks.has(key)) {
        const error = new Error(
          `ELOOP: too many symbolic links encountered, open '${key}'`,
        ) as NodeJS.ErrnoException;
        error.code = "ELOOP";
        throw error;
      }
      if ((_flags ?? 0) & fsConstants.O_EXCL && state.files.has(key)) {
        const error = new Error(
          `EEXIST: file already exists, open '${key}'`,
        ) as NodeJS.ErrnoException;
        error.code = "EEXIST";
        throw error;
      }
      state.fileModes.set(key, typeof mode === "number" ? mode : 0o666);
      return {
        writeFile: async (data: string) => {
          state.files.set(key, data);
          state.fileModes.set(key, typeof mode === "number" ? mode : 0o666);
        },
        chmod: async (nextMode: number) => {
          state.fileModes.set(key, nextMode);
        },
        close: async () => {},
      };
    }),
    rename: vi.fn(async (from: string, to: string) => {
      const fromKey = String(from);
      const toKey = String(to);
      const content = state.files.get(fromKey);
      if (content === undefined) {
        throw new Error(`ENOENT: no such file or directory, rename '${fromKey}'`);
      }
      state.files.set(toKey, content);
      state.fileModes.set(toKey, state.fileModes.get(fromKey) ?? 0o666);
      state.files.delete(fromKey);
      state.fileModes.delete(fromKey);
      state.symlinks.delete(toKey);
    }),
    unlink: vi.fn(async (p: string) => {
      const key = String(p);
      state.files.delete(key);
      state.symlinks.delete(key);
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
  state.kickstartError = "";
  state.kickstartFailuresRemaining = 0;
  state.dirs.clear();
  state.symlinks.clear();
  state.dirModes.clear();
  state.files.clear();
  state.fileModes.clear();
  cleanStaleGatewayProcessesSync.mockReset();
  cleanStaleGatewayProcessesSync.mockReturnValue([]);
  launchdRestartHandoffState.isCurrentProcessLaunchdServiceLabel.mockReset();
  launchdRestartHandoffState.isCurrentProcessLaunchdServiceLabel.mockReturnValue(false);
  launchdRestartHandoffState.scheduleDetachedLaunchdRestartHandoff.mockReset();
  launchdRestartHandoffState.scheduleDetachedLaunchdRestartHandoff.mockReturnValue({
    ok: true,
    pid: 7331,
  });
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
  it("enables, bootstraps, and kickstarts the resolved label", async () => {
    const env: Record<string, string | undefined> = {
      HOME: "/Users/test",
      OPENCLAW_PROFILE: "default",
    };
    const repair = await repairLaunchAgentBootstrap({ env });
    expect(repair.ok).toBe(true);

    const { serviceId, bootstrapIndex } = expectLaunchctlEnableBootstrapOrder(env);
    const kickstartIndex = state.launchctlCalls.findIndex(
      (c) => c[0] === "kickstart" && c[1] === "-k" && c[2] === serviceId,
    );
    expect(kickstartIndex).toBeGreaterThanOrEqual(0);
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

  it("enables service before bootstrap without self-restarting the fresh agent", async () => {
    const env = createDefaultLaunchdEnv();
    await installLaunchAgent({
      env,
      stdout: new PassThrough(),
      programArguments: defaultProgramArguments,
    });

    const { serviceId } = expectLaunchctlEnableBootstrapOrder(env);
    const installKickstartIndex = state.launchctlCalls.findIndex(
      (c) => c[0] === "kickstart" && c[2] === serviceId,
    );
    expect(installKickstartIndex).toBe(-1);
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

  it("uses the process homedir instead of a conflicting HOME override for plist paths", async () => {
    const env = {
      ...createDefaultLaunchdEnv(),
      HOME: "/tmp/attacker-home",
    };

    await installLaunchAgent({
      env,
      stdout: new PassThrough(),
      programArguments: defaultProgramArguments,
    });

    expect(resolveLaunchAgentPlistPath(env)).toBe(
      "/Users/test/Library/LaunchAgents/ai.openclaw.gateway.plist",
    );
    expect(
      state.files.has("/tmp/attacker-home/Library/LaunchAgents/ai.openclaw.gateway.plist"),
    ).toBe(false);
  });

  it("falls back to os.homedir when userInfo lookup is unavailable", () => {
    vi.mocked(os.userInfo).mockImplementationOnce(() => {
      throw new Error("user lookup failed");
    });
    vi.mocked(os.homedir).mockReturnValueOnce("/Users/fallback-home");

    expect(
      resolveLaunchAgentPlistPath({
        ...createDefaultLaunchdEnv(),
        HOME: "/tmp/attacker-home",
      }),
    ).toBe("/Users/fallback-home/Library/LaunchAgents/ai.openclaw.gateway.plist");
  });

  it("fails closed when trusted homedir cannot be resolved", () => {
    vi.mocked(os.userInfo).mockImplementationOnce(() => {
      throw new Error("user lookup failed");
    });
    vi.mocked(os.homedir).mockReturnValueOnce("   ");

    expect(() =>
      resolveLaunchAgentPlistPath({
        ...createDefaultLaunchdEnv(),
        HOME: "/tmp/attacker-home",
      }),
    ).toThrow("Unable to resolve trusted user home for launchd operations.");
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
    state.dirs.add("/Users/test/Library");
    state.dirModes.set("/Users/test/Library", 0o777);

    await installLaunchAgent({
      env,
      stdout: new PassThrough(),
      programArguments: defaultProgramArguments,
    });

    const plistPath = resolveLaunchAgentPlistPath(env);
    expect(state.dirModes.get("/Users/test/Library")).toBe(0o755);
    expect(state.dirModes.get("/Users/test/Library/LaunchAgents")).toBe(0o755);
    expect(state.fileModes.get(plistPath)).toBe(0o600);
  });

  it("does not clobber a pre-existing temp plist file", async () => {
    const env = createDefaultLaunchdEnv();
    const plistPath = resolveLaunchAgentPlistPath(env);
    const legacyTempPath = path.posix.join(
      path.posix.dirname(plistPath),
      `.${path.posix.basename(plistPath)}.${process.pid}.tmp`,
    );
    state.dirs.add("/Users/test/Library");
    state.dirModes.set("/Users/test/Library", 0o755);
    state.dirs.add("/Users/test/Library/LaunchAgents");
    state.dirModes.set("/Users/test/Library/LaunchAgents", 0o755);
    state.files.set(legacyTempPath, "keep-existing-temp");
    state.fileModes.set(legacyTempPath, 0o644);

    await installLaunchAgent({
      env,
      stdout: new PassThrough(),
      programArguments: defaultProgramArguments,
    });

    expect(state.files.get(legacyTempPath)).toBe("keep-existing-temp");
    expect(state.fileModes.get(legacyTempPath)).toBe(0o644);
    expect(state.fileModes.get(plistPath)).toBe(0o600);
  });

  it("rejects symlinked launch agent directories", async () => {
    const env = createDefaultLaunchdEnv();
    state.dirs.add("/Users/test/Library");
    state.dirModes.set("/Users/test/Library", 0o755);
    state.symlinks.add("/Users/test/Library/LaunchAgents");

    await expect(
      installLaunchAgent({
        env,
        stdout: new PassThrough(),
        programArguments: defaultProgramArguments,
      }),
    ).rejects.toThrow(
      "Refusing to use symlinked LaunchAgent path: /Users/test/Library/LaunchAgents",
    );
  });

  it("rejects symlinked Library parents before creating LaunchAgents", async () => {
    const env = createDefaultLaunchdEnv();
    state.symlinks.add("/Users/test/Library");

    await expect(
      installLaunchAgent({
        env,
        stdout: new PassThrough(),
        programArguments: defaultProgramArguments,
      }),
    ).rejects.toThrow("Refusing to use symlinked LaunchAgent path: /Users/test/Library");
  });

  it("rejects symlinked launch agent plist targets", async () => {
    const env = createDefaultLaunchdEnv();
    const plistPath = resolveLaunchAgentPlistPath(env);
    state.dirs.add("/Users/test/Library");
    state.dirModes.set("/Users/test/Library", 0o755);
    state.dirs.add("/Users/test/Library/LaunchAgents");
    state.dirModes.set("/Users/test/Library/LaunchAgents", 0o755);
    state.symlinks.add(plistPath);

    await expect(
      installLaunchAgent({
        env,
        stdout: new PassThrough(),
        programArguments: defaultProgramArguments,
      }),
    ).rejects.toThrow(`Refusing to use symlinked LaunchAgent path: ${plistPath}`);
  });

  it("restarts LaunchAgent with kickstart and no bootout", async () => {
    const env = {
      ...createDefaultLaunchdEnv(),
      OPENCLAW_GATEWAY_PORT: "18789",
    };
    const result = await restartLaunchAgent({
      env,
      stdout: new PassThrough(),
    });

    const domain = typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501";
    const label = "ai.openclaw.gateway";
    const serviceId = `${domain}/${label}`;
    expect(result).toEqual({ outcome: "completed" });
    expect(cleanStaleGatewayProcessesSync).toHaveBeenCalledWith(18789);
    expect(state.launchctlCalls).toContainEqual(["kickstart", "-k", serviceId]);
    expect(state.launchctlCalls.some((call) => call[0] === "bootout")).toBe(false);
    expect(state.launchctlCalls.some((call) => call[0] === "bootstrap")).toBe(false);
  });

  it("uses the configured gateway port for stale cleanup", async () => {
    const env = {
      ...createDefaultLaunchdEnv(),
      OPENCLAW_GATEWAY_PORT: "19001",
    };

    await restartLaunchAgent({
      env,
      stdout: new PassThrough(),
    });

    expect(cleanStaleGatewayProcessesSync).toHaveBeenCalledWith(19001);
  });

  it("skips stale cleanup when no explicit launch agent port can be resolved", async () => {
    const env = createDefaultLaunchdEnv();
    state.files.clear();

    await restartLaunchAgent({
      env,
      stdout: new PassThrough(),
    });

    expect(cleanStaleGatewayProcessesSync).not.toHaveBeenCalled();
  });

  it("falls back to bootstrap when kickstart cannot find the service", async () => {
    const env = createDefaultLaunchdEnv();
    state.kickstartError = "Could not find service";
    state.kickstartFailuresRemaining = 1;

    const result = await restartLaunchAgent({
      env,
      stdout: new PassThrough(),
    });

    const { serviceId } = expectLaunchctlEnableBootstrapOrder(env);
    const kickstartCalls = state.launchctlCalls.filter(
      (c) => c[0] === "kickstart" && c[1] === "-k" && c[2] === serviceId,
    );

    expect(result).toEqual({ outcome: "completed" });
    expect(kickstartCalls).toHaveLength(2);
    expect(state.launchctlCalls.some((call) => call[0] === "bootout")).toBe(false);
  });

  it("surfaces the original kickstart failure when the service is still loaded", async () => {
    const env = createDefaultLaunchdEnv();
    state.kickstartError = "Input/output error";
    state.kickstartFailuresRemaining = 1;

    await expect(
      restartLaunchAgent({
        env,
        stdout: new PassThrough(),
      }),
    ).rejects.toThrow("launchctl kickstart failed: Input/output error");

    expect(state.launchctlCalls.some((call) => call[0] === "enable")).toBe(false);
    expect(state.launchctlCalls.some((call) => call[0] === "bootstrap")).toBe(false);
  });

  it("hands restart off to a detached helper when invoked from the current LaunchAgent", async () => {
    const env = createDefaultLaunchdEnv();
    launchdRestartHandoffState.isCurrentProcessLaunchdServiceLabel.mockReturnValue(true);

    const result = await restartLaunchAgent({
      env,
      stdout: new PassThrough(),
    });

    expect(result).toEqual({ outcome: "scheduled" });
    expect(launchdRestartHandoffState.scheduleDetachedLaunchdRestartHandoff).toHaveBeenCalledWith({
      env,
      mode: "kickstart",
      waitForPid: process.pid,
    });
    expect(state.launchctlCalls).toEqual([]);
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
