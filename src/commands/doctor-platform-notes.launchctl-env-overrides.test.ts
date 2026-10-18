import fs from "node:fs";
import os from "node:os";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const mocks = vi.hoisted(() => ({
  runExec: vi.fn(),
  note: vi.fn(),
  readCommand: vi.fn(),
  findJobs: vi.fn(),
}));

vi.mock("../process/exec.js", () => ({ runExec: mocks.runExec }));
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: mocks.note }));
vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: () => ({ readCommand: mocks.readCommand }),
}));
vi.mock("../daemon/launchd.js", () => ({ findStaleOpenClawUpdateLaunchdJobs: mocks.findJobs }));

import {
  collectGatewayPlatformWarnings,
  noteMacGatewayPlatformWarnings,
  noteStartupOptimizationHints,
} from "./doctor-platform-notes.js";

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
const tokenConfig: OpenClawConfig = { gateway: { auth: { token: "config-token" } } };
const startupEnv = {
  NODE_COMPILE_CACHE: "/var/tmp/openclaw-compile-cache",
  OPENCLAW_NO_RESPAWN: "1",
};
const temporaryCache = { NODE_COMPILE_CACHE: "/tmp/openclaw-compile-cache" };
const startupSuggestions = [
  "- Suggested env for low-power hosts:",
  `  export NODE_COMPILE_CACHE=${startupEnv.NODE_COMPILE_CACHE}`,
  `  mkdir -p ${startupEnv.NODE_COMPILE_CACHE}`,
  "  export OPENCLAW_NO_RESPAWN=1",
];

function expectMacNote(includes: string[], excludes: string[] = []) {
  expect(mocks.note).toHaveBeenCalledTimes(1);
  const [message, actualTitle] = expectDefined<unknown[]>(mocks.note.mock.calls[0], "note call 0");
  expect(actualTitle).toBe("Gateway (macOS)");
  for (const text of includes) {
    expect(message).toContain(text);
  }
  for (const text of excludes) {
    expect(message).not.toContain(text);
  }
}

beforeEach(() => {
  vi.resetAllMocks();
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: "darwin" });
  vi.stubEnv("HOME", "/tmp/openclaw-doctor-host");
  vi.stubEnv("OPENCLAW_STATE_DIR", "/tmp/openclaw-doctor-host-state");
  vi.spyOn(fs, "existsSync").mockReturnValue(false);
  mocks.runExec.mockResolvedValue({ stdout: "", stderr: "" });
  mocks.readCommand.mockResolvedValue(null);
  mocks.findJobs.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (platformDescriptor) {
    Object.defineProperty(process, "platform", platformDescriptor);
  }
});

const password = { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_PASSWORD" } as const;
it.each([
  [
    "TOKEN",
    tokenConfig,
    [
      "Host-wide launchctl gateway auth overrides detected",
      "Current managed Gateway installs do not need these values",
      "launchctl unsetenv OPENCLAW_GATEWAY_TOKEN",
    ],
    ["OPENCLAW_GATEWAY_PASSWORD", "config-token"],
  ],
  ["PASSWORD", { gateway: { auth: { password } } }, [], ["OPENCLAW_GATEWAY_TOKEN"]],
] satisfies Array<[string, OpenClawConfig, string[], string[]]>)(
  "reports %s overrides without revealing credentials",
  async (suffix, cfg, includes, excludes) => {
    const envName = `OPENCLAW_GATEWAY_${suffix}`;
    const secret = `launchctl-${suffix.toLowerCase()}`;
    mocks.runExec.mockImplementation(async (_command, [, name]) => ({
      stdout: name === envName ? ` \t${secret}\n` : " \n",
      stderr: "",
    }));
    await noteMacGatewayPlatformWarnings(cfg);
    expect(mocks.runExec).toHaveBeenCalledTimes(2);
    expectMacNote([envName, ...includes], [secret, ...excludes]);
  },
);

it("does nothing on non-darwin platforms", async () => {
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: "linux" });
  mocks.runExec.mockResolvedValue({ stdout: "launchctl-token", stderr: "" });
  await noteMacGatewayPlatformWarnings(tokenConfig);

  expect(mocks.runExec).not.toHaveBeenCalled();
  expect(mocks.note).not.toHaveBeenCalled();
});

it("bounds launchctl getenv calls and ignores timeout failures", async () => {
  mocks.runExec.mockRejectedValue(new Error("timed out"));
  await noteMacGatewayPlatformWarnings(tokenConfig);
  expect(mocks.runExec.mock.calls).toEqual(
    ["OPENCLAW_GATEWAY_TOKEN", "OPENCLAW_GATEWAY_PASSWORD"].map((name) => [
      "/bin/launchctl",
      ["getenv", name],
      { logOutput: false, timeoutMs: 5_000 },
    ]),
  );
  expect(mocks.note).not.toHaveBeenCalled();
});
it("uses service env for gateway platform stale updater warnings", async () => {
  const serviceEnv = {
    OPENCLAW_STATE_DIR: "/tmp/openclaw-daemon",
    OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.manual-update.gateway",
  };
  mocks.readCommand.mockResolvedValue({
    environment: serviceEnv,
  });

  const warnings = await collectGatewayPlatformWarnings({});

  expect(warnings).toEqual([]);
  expect(mocks.runExec).not.toHaveBeenCalled();
  expect(mocks.readCommand).toHaveBeenCalledTimes(1);
  expect(mocks.findJobs).toHaveBeenCalledWith(
    expect.objectContaining({ HOME: "/tmp/openclaw-doctor-host", ...serviceEnv }),
  );
});

it("prints stale updater job cleanup guidance on macOS", async () => {
  mocks.findJobs.mockResolvedValue([
    { label: "ai.openclaw.update.2026.5.12", lastExitStatus: 127 },
    { label: "ai.openclaw.manual-update.1717168800", lastExitStatus: 0 },
  ]);

  await noteMacGatewayPlatformWarnings({});

  expect(mocks.findJobs).toHaveBeenCalledTimes(1);
  expectMacNote([
    "Stale OpenClaw updater launchd job(s) detected",
    "ai.openclaw.update.2026.5.12",
    "ai.openclaw.manual-update.1717168800",
    "launchctl remove <label>",
    "openclaw gateway restart",
  ]);
});
it.each([false, true])(
  "reports only the active state's launch-agent marker (present: %s)",
  async (activeMarkerExists) => {
    const activeMarker = "/tmp/openclaw-doctor-host-state/disable-launchagent";
    const defaultMarker = "/tmp/openclaw-doctor-host/.openclaw/disable-launchagent";
    vi.mocked(fs.existsSync).mockImplementation(
      (candidate) =>
        candidate === defaultMarker || (candidate === activeMarker && activeMarkerExists),
    );
    mocks.readCommand.mockResolvedValue({
      environment: { HOME: "/tmp/openclaw-doctor-service" },
    });

    const warnings = await collectGatewayPlatformWarnings({});
    await noteMacGatewayPlatformWarnings({});

    expect(fs.existsSync).not.toHaveBeenCalledWith(defaultMarker);
    if (activeMarkerExists) {
      expect(warnings).toEqual([expect.stringContaining(`disabled via ${activeMarker}`)]);
      expect(mocks.note).toHaveBeenCalledWith(warnings[0], "Gateway (macOS)");
    } else {
      expect(warnings).toEqual([]);
      expect(mocks.note).not.toHaveBeenCalled();
    }
  },
);
describe("noteStartupOptimizationHints", () => {
  beforeEach(() => {
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "linux" });
    vi.spyOn(os, "arch").mockReturnValue("arm64");
    vi.spyOn(os, "totalmem").mockReturnValue(4 * 1024 ** 3);
  });

  it.each([
    [
      "temporary cache without no-respawn",
      temporaryCache,
      [
        "- NODE_COMPILE_CACHE points to /tmp; use /var/tmp so cache survives reboots and warms startup reliably.",
        "- OPENCLAW_NO_RESPAWN is not set to 1; set it when you want routine gateway restarts to stay in-process instead of handing off to a managed supervisor.",
      ],
      [],
    ],
    [
      "disabled compile cache",
      { ...startupEnv, NODE_DISABLE_COMPILE_CACHE: "1" },
      ["- NODE_DISABLE_COMPILE_CACHE is set; startup compile cache is disabled."],
      ["  unset NODE_DISABLE_COMPILE_CACHE"],
    ],
  ] satisfies Array<[string, NodeJS.ProcessEnv, string[], string[]]>)(
    "warns for %s",
    (_name, env, problems, extra) => {
      noteStartupOptimizationHints(env);
      expect(mocks.note.mock.calls).toEqual([
        [[...problems, ...startupSuggestions, ...extra].join("\n"), "Startup optimization"],
      ]);
    },
  );

  it.each([
    ["configured cache and no-respawn", startupEnv],
    ["Windows", temporaryCache, "win32"],
    ["non-target Linux host", temporaryCache, "linux", "x64", 32],
  ] satisfies Array<[string, NodeJS.ProcessEnv, NodeJS.Platform?, string?, number?]>)(
    "does not warn for %s",
    (_name, env, platform = "linux", arch = "arm64", memoryGiB = 4) => {
      Object.defineProperty(process, "platform", { ...platformDescriptor, value: platform });
      vi.mocked(os.arch).mockReturnValue(arch);
      vi.mocked(os.totalmem).mockReturnValue(memoryGiB * 1024 ** 3);
      noteStartupOptimizationHints(env);
      expect(mocks.note).not.toHaveBeenCalled();
    },
  );
});
