import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  LAUNCH_AGENT_THROTTLE_INTERVAL_SECONDS,
  LAUNCH_AGENT_UMASK_DECIMAL,
} from "./launchd-plist.js";
import {
  hasPlistConfigChanged,
  installLaunchAgent,
  isLaunchAgentListed,
  parseLaunchctlPrint,
  parseLaunchctlPrintArguments,
  parseLaunchctlPrintEnvironment,
  repairLaunchAgentBootstrap,
  restartLaunchAgent,
  resolveLaunchAgentPlistPath,
} from "./launchd.js";

const state = vi.hoisted(() => ({
  launchctlCalls: [] as string[][],
  listOutput: "",
  printOutput: "",
  printCode: 0,
  bootstrapError: "",
  kickstartFailOnce: false,
  dirs: new Set<string>(),
  dirModes: new Map<string, number>(),
  files: new Map<string, string>(),
  fileModes: new Map<string, number>(),
  spawnCalls: [] as Array<{ file: string; args: string[]; options: Record<string, unknown> }>,
  syncFiles: new Map<string, string>(),
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
      return { stdout: state.printOutput, stderr: "", code: state.printCode };
    }
    if (call[0] === "bootstrap" && state.bootstrapError) {
      return { stdout: "", stderr: state.bootstrapError, code: 1 };
    }
    if (call[0] === "kickstart" && state.kickstartFailOnce) {
      state.kickstartFailOnce = false;
      return { stdout: "", stderr: "Could not find service", code: 113 };
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
    readFile: vi.fn(async (p: string) => {
      const key = String(p);
      const content = state.files.get(key);
      if (content !== undefined) {
        return content;
      }
      throw new Error(`ENOENT: no such file or directory, open '${key}'`);
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

vi.mock("node:fs", () => ({
  default: {
    writeFileSync: vi.fn((p: string, data: string) => {
      state.syncFiles.set(String(p), data);
    }),
  },
  writeFileSync: vi.fn((p: string, data: string) => {
    state.syncFiles.set(String(p), data);
  }),
}));

vi.mock("node:child_process", () => ({
  spawn: vi.fn((file: string, args: string[], options: Record<string, unknown>) => {
    state.spawnCalls.push({ file, args, options });
    return { unref: vi.fn() };
  }),
}));

beforeEach(() => {
  state.launchctlCalls.length = 0;
  state.listOutput = "";
  state.printOutput = "";
  state.printCode = 0;
  state.bootstrapError = "";
  state.kickstartFailOnce = false;
  state.dirs.clear();
  state.dirModes.clear();
  state.files.clear();
  state.fileModes.clear();
  state.spawnCalls.length = 0;
  state.syncFiles.clear();
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

  it("restarts LaunchAgent with atomic kickstart -kp when plist is unchanged", async () => {
    const env = createDefaultLaunchdEnv();
    const plistPath = resolveLaunchAgentPlistPath(env);

    // Set up matching on-disk plist and loaded print output.
    const args = ["/usr/local/bin/node", "/usr/local/bin/openclaw", "gateway", "run"];
    const plistXml = [
      "<key>ProgramArguments</key>",
      "<array>",
      ...args.map((a) => `  <string>${a}</string>`),
      "</array>",
    ].join("\n");
    state.files.set(plistPath, plistXml);
    state.printOutput = [
      "state = running",
      "pid = 1234",
      `arguments = {`,
      ...args.map((a) => `\t${a}`),
      `}`,
    ].join("\n");

    await restartLaunchAgent({ env, stdout: new PassThrough() });

    const domain = typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501";
    const label = "ai.openclaw.gateway";
    const serviceId = `${domain}/${label}`;

    // Primary path: single kickstart -kp, no bootout/bootstrap
    const kickstartIndex = state.launchctlCalls.findIndex(
      (c) => c[0] === "kickstart" && c[1] === "-kp" && c[2] === serviceId,
    );
    expect(kickstartIndex).toBeGreaterThanOrEqual(0);

    const bootoutIndex = state.launchctlCalls.findIndex((c) => c[0] === "bootout");
    const bootstrapIndex = state.launchctlCalls.findIndex((c) => c[0] === "bootstrap");
    expect(bootoutIndex).toBe(-1);
    expect(bootstrapIndex).toBe(-1);
    expect(state.spawnCalls).toHaveLength(0);
  });

  it("spawns detached reload when plist arguments have changed", async () => {
    const env = createDefaultLaunchdEnv();
    const plistPath = resolveLaunchAgentPlistPath(env);
    const domain = typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501";
    const label = "ai.openclaw.gateway";

    // On-disk plist has new port argument.
    const diskArgs = [
      "/usr/local/bin/node",
      "/usr/local/bin/openclaw",
      "gateway",
      "run",
      "--port",
      "9999",
    ];
    const plistXml = [
      "<key>ProgramArguments</key>",
      "<array>",
      ...diskArgs.map((a) => `  <string>${a}</string>`),
      "</array>",
    ].join("\n");
    state.files.set(plistPath, plistXml);

    // Loaded args are the old config (no port flag).
    const loadedArgs = ["/usr/local/bin/node", "/usr/local/bin/openclaw", "gateway", "run"];
    state.printOutput = [
      "state = running",
      "pid = 1234",
      `arguments = {`,
      ...loadedArgs.map((a) => `\t${a}`),
      `}`,
    ].join("\n");

    const out = new PassThrough();
    let output = "";
    out.on("data", (chunk) => {
      output += chunk;
    });
    await restartLaunchAgent({ env, stdout: out });

    // Should have spawned a detached script, not done inline kickstart.
    expect(state.spawnCalls).toHaveLength(1);
    expect(state.spawnCalls[0].options.detached).toBe(true);
    expect(state.spawnCalls[0].options.stdio).toBe("ignore");

    // The detached script should contain bootout + bootstrap + kickstart.
    const scriptPath = state.spawnCalls[0].args[0];
    const scriptContent = state.syncFiles.get(scriptPath) ?? "";
    expect(scriptContent).toContain("launchctl bootout");
    expect(scriptContent).toContain("launchctl bootstrap");
    expect(scriptContent).toContain("launchctl kickstart -kp");
    expect(scriptContent).toContain(`${domain}/${label}`);

    // No inline bootout/bootstrap should have been called.
    const bootoutIndex = state.launchctlCalls.findIndex((c) => c[0] === "bootout");
    const bootstrapIndex = state.launchctlCalls.findIndex((c) => c[0] === "bootstrap");
    expect(bootoutIndex).toBe(-1);
    expect(bootstrapIndex).toBe(-1);

    expect(output).toContain("plist changed");
  });

  it("spawns detached reload when plist environment has changed", async () => {
    const env = createDefaultLaunchdEnv();
    const plistPath = resolveLaunchAgentPlistPath(env);

    // On-disk plist has new PATH value.
    const args = ["/usr/local/bin/openclaw", "gateway", "run"];
    const plistXml = [
      "<key>ProgramArguments</key>",
      "<array>",
      ...args.map((a) => `  <string>${a}</string>`),
      "</array>",
      "<key>EnvironmentVariables</key>",
      "<dict>",
      "  <key>PATH</key>",
      "  <string>/usr/local/bin:/usr/bin:/bin</string>",
      "</dict>",
    ].join("\n");
    state.files.set(plistPath, plistXml);

    // Loaded env has old PATH.
    state.printOutput = [
      "state = running",
      `arguments = {`,
      ...args.map((a) => `\t${a}`),
      `}`,
      `environment = {`,
      `\tPATH => /usr/bin:/bin`,
      `}`,
    ].join("\n");

    await restartLaunchAgent({ env, stdout: new PassThrough() });
    expect(state.spawnCalls).toHaveLength(1);
  });

  it("falls back to bootstrap + kickstart when service is not loaded", async () => {
    const env = createDefaultLaunchdEnv();
    const domain = typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501";
    const label = "ai.openclaw.gateway";
    const serviceId = `${domain}/${label}`;
    const plistPath = resolveLaunchAgentPlistPath(env);

    // Service not loaded: print returns non-zero.
    state.printCode = 113;
    state.printOutput = "Could not find service";

    await restartLaunchAgent({ env, stdout: new PassThrough() });

    // Should NOT spawn a detached script.
    expect(state.spawnCalls).toHaveLength(0);

    const enableIndex = state.launchctlCalls.findIndex(
      (c) => c[0] === "enable" && c[1] === serviceId,
    );
    const bootstrapIndex = state.launchctlCalls.findIndex(
      (c) => c[0] === "bootstrap" && c[1] === domain && c[2] === plistPath,
    );
    const kickIndex = state.launchctlCalls.findIndex(
      (c, i) => i > bootstrapIndex && c[0] === "kickstart" && c[1] === "-kp" && c[2] === serviceId,
    );

    expect(enableIndex).toBeGreaterThanOrEqual(0);
    expect(bootstrapIndex).toBeGreaterThanOrEqual(0);
    expect(kickIndex).toBeGreaterThanOrEqual(0);
    expect(enableIndex).toBeLessThan(bootstrapIndex);
    expect(bootstrapIndex).toBeLessThan(kickIndex);
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

describe("parseLaunchctlPrintArguments", () => {
  it("parses arguments block from launchctl print output", () => {
    const output = [
      "ai.openclaw.gateway = {",
      "\tstate = running",
      "\targuments = {",
      "\t\t/usr/local/bin/node",
      "\t\t/usr/local/bin/openclaw",
      "\t\tgateway",
      "\t\trun",
      "\t}",
      "\tpid = 1234",
      "}",
    ].join("\n");
    expect(parseLaunchctlPrintArguments(output)).toEqual([
      "/usr/local/bin/node",
      "/usr/local/bin/openclaw",
      "gateway",
      "run",
    ]);
  });

  it("returns undefined when no arguments block", () => {
    expect(parseLaunchctlPrintArguments("state = running\npid = 1234")).toBeUndefined();
  });
});

describe("parseLaunchctlPrintEnvironment", () => {
  it("parses environment block from launchctl print output", () => {
    const output = [
      "environment = {",
      "\tPATH => /usr/local/bin:/usr/bin:/bin",
      "\tTMPDIR => /var/folders/xy/abc123/T/",
      "}",
    ].join("\n");
    expect(parseLaunchctlPrintEnvironment(output)).toEqual({
      PATH: "/usr/local/bin:/usr/bin:/bin",
      TMPDIR: "/var/folders/xy/abc123/T/",
    });
  });

  it("returns undefined when no environment block", () => {
    expect(parseLaunchctlPrintEnvironment("state = running")).toBeUndefined();
  });

  it("ignores inherited environment and default environment blocks", () => {
    const output = [
      "\tinherited environment = {",
      "\t\tSSH_AUTH_SOCK => /private/tmp/com.apple.launchd.abc/Listeners",
      "\t}",
      "",
      "\tdefault environment = {",
      "\t\tPATH => /usr/bin:/bin:/usr/sbin:/sbin",
      "\t}",
      "",
      "\tenvironment = {",
      "\t\tPATH => /opt/homebrew/bin:/usr/bin",
      "\t\tHOME => /Users/test",
      "\t}",
    ].join("\n");
    expect(parseLaunchctlPrintEnvironment(output)).toEqual({
      PATH: "/opt/homebrew/bin:/usr/bin",
      HOME: "/Users/test",
    });
  });
});

describe("hasPlistConfigChanged", () => {
  it("returns false when arguments and environment match", async () => {
    const args = ["/usr/local/bin/openclaw", "gateway", "run"];
    const printOutput = [
      `arguments = {`,
      ...args.map((a) => `\t${a}`),
      `}`,
      `environment = {`,
      `\tPATH => /usr/bin:/bin`,
      `}`,
    ].join("\n");
    const plistXml = [
      "<key>ProgramArguments</key>",
      "<array>",
      ...args.map((a) => `  <string>${a}</string>`),
      "</array>",
      "<key>EnvironmentVariables</key>",
      "<dict>",
      "  <key>PATH</key>",
      "  <string>/usr/bin:/bin</string>",
      "</dict>",
    ].join("\n");
    state.files.set("/tmp/test.plist", plistXml);
    expect(await hasPlistConfigChanged(printOutput, "/tmp/test.plist")).toBe(false);
  });

  it("returns true when arguments differ", async () => {
    const printOutput = [
      `arguments = {`,
      `\t/usr/local/bin/openclaw`,
      `\tgateway`,
      `\trun`,
      `}`,
    ].join("\n");
    const plistXml = [
      "<key>ProgramArguments</key>",
      "<array>",
      "  <string>/usr/local/bin/openclaw</string>",
      "  <string>gateway</string>",
      "  <string>run</string>",
      "  <string>--port</string>",
      "  <string>9999</string>",
      "</array>",
    ].join("\n");
    state.files.set("/tmp/test.plist", plistXml);
    expect(await hasPlistConfigChanged(printOutput, "/tmp/test.plist")).toBe(true);
  });

  it("returns true when environment differs", async () => {
    const printOutput = [
      `arguments = {`,
      `\t/usr/local/bin/openclaw`,
      `}`,
      `environment = {`,
      `\tPATH => /usr/bin:/bin`,
      `}`,
    ].join("\n");
    const plistXml = [
      "<key>ProgramArguments</key>",
      "<array>",
      "  <string>/usr/local/bin/openclaw</string>",
      "</array>",
      "<key>EnvironmentVariables</key>",
      "<dict>",
      "  <key>PATH</key>",
      "  <string>/usr/local/bin:/usr/bin:/bin</string>",
      "</dict>",
    ].join("\n");
    state.files.set("/tmp/test.plist", plistXml);
    expect(await hasPlistConfigChanged(printOutput, "/tmp/test.plist")).toBe(true);
  });

  it("returns true when loaded output has no arguments block", async () => {
    state.files.set("/tmp/test.plist", "<key>ProgramArguments</key><array></array>");
    expect(await hasPlistConfigChanged("state = running", "/tmp/test.plist")).toBe(true);
  });

  it("returns true when plist file is missing", async () => {
    const printOutput = "arguments = {\n\t/usr/local/bin/openclaw\n}";
    expect(await hasPlistConfigChanged(printOutput, "/tmp/nonexistent.plist")).toBe(true);
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
