import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  installLaunchAgent,
  isLaunchAgentListed,
  parseLaunchctlPrint,
  repairLaunchAgentBootstrap,
  resolveLaunchAgentPlistPath,
} from "./launchd.js";

const state = vi.hoisted(() => ({
  launchctlCalls: [] as string[][],
  listOutput: "",
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

describe("launchd install", () => {
  it("enables service before bootstrap (clears persisted disabled state)", async () => {
    const env: Record<string, string | undefined> = {
      HOME: "/Users/test",
      OPENCLAW_PROFILE: "default",
    };
    await installLaunchAgent({
      env,
      stdout: new PassThrough(),
      programArguments: ["node", "-e", "process.exit(0)"],
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
    const env: Record<string, string | undefined> = {
      HOME: "/Users/test",
      OPENCLAW_PROFILE: "default",
    };
    const tmpDir = "/var/folders/xy/abc123/T/";
    await installLaunchAgent({
      env,
      stdout: new PassThrough(),
      programArguments: ["node", "-e", "process.exit(0)"],
      environment: { TMPDIR: tmpDir },
    });

    const plistPath = resolveLaunchAgentPlistPath(env);
    const plist = state.files.get(plistPath) ?? "";
    expect(plist).toContain("<key>EnvironmentVariables</key>");
    expect(plist).toContain("<key>TMPDIR</key>");
    expect(plist).toContain(`<string>${tmpDir}</string>`);
  });
});

describe("resolveLaunchAgentPlistPath", () => {
  it("uses default label when OPENCLAW_PROFILE is unset", () => {
    const env = { HOME: "/Users/test" };
    expect(resolveLaunchAgentPlistPath(env)).toBe(
      "/Users/test/Library/LaunchAgents/ai.openclaw.gateway.plist",
    );
  });

  it("uses profile-specific label when OPENCLAW_PROFILE is set to a custom value", () => {
    const env = { HOME: "/Users/test", OPENCLAW_PROFILE: "jbphoenix" };
    expect(resolveLaunchAgentPlistPath(env)).toBe(
      "/Users/test/Library/LaunchAgents/ai.openclaw.jbphoenix.plist",
    );
  });

  it("prefers OPENCLAW_LAUNCHD_LABEL over OPENCLAW_PROFILE", () => {
    const env = {
      HOME: "/Users/test",
      OPENCLAW_PROFILE: "jbphoenix",
      OPENCLAW_LAUNCHD_LABEL: "com.custom.label",
    };
    expect(resolveLaunchAgentPlistPath(env)).toBe(
      "/Users/test/Library/LaunchAgents/com.custom.label.plist",
    );
  });

  it("trims whitespace from OPENCLAW_LAUNCHD_LABEL", () => {
    const env = {
      HOME: "/Users/test",
      OPENCLAW_LAUNCHD_LABEL: "  com.custom.label  ",
    };
    expect(resolveLaunchAgentPlistPath(env)).toBe(
      "/Users/test/Library/LaunchAgents/com.custom.label.plist",
    );
  });

  it("ignores empty OPENCLAW_LAUNCHD_LABEL and falls back to profile", () => {
    const env = {
      HOME: "/Users/test",
      OPENCLAW_PROFILE: "myprofile",
      OPENCLAW_LAUNCHD_LABEL: "   ",
    };
    expect(resolveLaunchAgentPlistPath(env)).toBe(
      "/Users/test/Library/LaunchAgents/ai.openclaw.myprofile.plist",
    );
  });
});
