import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/config.js";
import { LAUNCH_AGENT_ENV_FILE_HEADER } from "../daemon/launchd-env-wrapper.js";
import { runGatewayServicesHealth } from "../flows/doctor-health-contribution-runners.gateway.js";
import { prepareDoctorInteractiveMaintenance } from "../flows/doctor-health-startup.js";
import { defaultRuntime } from "../runtime.js";
import { createDoctorPrompter } from "./doctor-prompter.js";
import * as doctorPrompter from "./doctor-prompter.js";

const mocks = vi.hoisted(() => ({
  runExec: vi.fn(),
  note: vi.fn(),
  readCommand: vi.fn(),
  findJobs: vi.fn(),
  schemaPreflight: vi.fn(async () => {}),
}));

vi.mock("../process/exec.js", () => ({
  runExec: mocks.runExec,
}));
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: mocks.note }));
vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: () => ({ readCommand: mocks.readCommand }),
}));
vi.mock("../daemon/launchd.js", () => ({ findStaleOpenClawUpdateLaunchdJobs: mocks.findJobs }));
// mock-isolation: keep real service locks in this test invocation's temporary directory.
vi.mock("../infra/tmp-openclaw-dir.js", async () => ({
  resolvePreferredOpenClawTmpDir: (await import("node:os")).tmpdir,
}));
// mock-isolation: foreign launchd inventory is a separate native boundary from env-file repair.
vi.mock("./doctor-foreign-launchd-jobs.js", () => ({ noteMacForeignLaunchdJobs: async () => {} }));
// mock-isolation: startup reads synthetic authored config, never operator files.
vi.mock("../config/io.runtime.js", () => ({ readSourceConfigBestEffort: async () => ({}) }));
// mock-isolation: supply schema availability without opening unrelated databases.
vi.mock("./doctor-database-preflight.js", () => ({
  prepareDoctorDatabasePreflight: mocks.schemaPreflight,
}));
// mock-isolation: this repair must not check for or install a release.
vi.mock("./doctor-update.js", () => ({ maybeOfferUpdateBeforeDoctor: async () => false }));

import {
  collectGatewayPlatformWarnings,
  noteMacGatewayPlatformWarnings,
  noteStartupOptimizationHints,
} from "./doctor-platform-notes.js";

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each(["gateway", "node"])(
  "repairs confirmed quote corruption in the profiled %s env file with a private backup",
  async (kind) => {
    const home = tempDirs.make("doctor-env-quotes-");
    vi.spyOn(os, "userInfo").mockReturnValue({
      username: "doctor-fixture",
      homedir: home,
      uid: 1000,
      gid: 1000,
      shell: "/bin/sh",
    });
    const env = { HOME: home, OPENCLAW_PROFILE: "quoteproof" };
    vi.stubEnv("HOME", home);
    vi.stubEnv("OPENCLAW_STATE_DIR", undefined);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", undefined);
    vi.stubEnv("OPENCLAW_HOME", undefined);
    vi.stubEnv("OPENCLAW_PROFILE", "quoteproof");
    vi.stubEnv("OPENCLAW_LAUNCHD_LABEL", undefined);
    const label = kind === "node" ? "ai.openclaw.node.quoteproof" : "ai.openclaw.quoteproof";
    const directory = path.join(home, ".openclaw-quoteproof", "service-env");
    const file = path.join(directory, `${label}.env`);
    fs.mkdirSync(directory, { recursive: true });
    const before = `${LAUNCH_AGENT_ENV_FILE_HEADER}\nexport AWS_REGION='"us-east-1"'\nexport API_KEY='"synthetic-private-key"'\nexport UNRELATED='has "inner" quotes'\nexport MULTILINE='prefix\nexport INSIDE='\\''"keep"'\\''\nsuffix'\n`;
    fs.writeFileSync(file, before, { mode: 0o600 });
    const prompter = {
      ...createDoctorPrompter({ runtime: defaultRuntime, options: {} }),
      confirmRuntimeRepair: vi.fn().mockResolvedValue(true),
    };

    await runGatewayServicesHealth({
      cfg: {},
      cfgForPersistence: {},
      configResult: { cfg: {} },
      configPath: path.join(home, ".openclaw-quoteproof", "openclaw.json"),
      sourceConfigValid: true,
      runtime: defaultRuntime,
      options: {},
      prompter,
      env,
      gatewayMaintenanceActive: true,
    });
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(fs.readdirSync(directory)).toHaveLength(1);
    expect(JSON.stringify(mocks.note.mock.calls)).toContain("API_KEY");
    vi.spyOn(doctorPrompter, "createDoctorPrompter").mockReturnValue(prompter);
    const admission = {
      runtime: defaultRuntime,
      options: {},
      databasePreflight: undefined,
      root: null,
      outro: () => {},
    };
    mocks.schemaPreflight.mockRejectedValueOnce(new Error("synthetic incompatible schema"));
    await expect(prepareDoctorInteractiveMaintenance(admission)).rejects.toThrow(
      "synthetic incompatible schema",
    );
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(fs.readdirSync(directory)).toHaveLength(1);
    await expect(prepareDoctorInteractiveMaintenance(admission)).resolves.toBe("accepted");

    expect(fs.readFileSync(file, "utf8")).toBe(
      before
        .replace("'\"us-east-1\"'", "'us-east-1'")
        .replace("'\"synthetic-private-key\"'", "'synthetic-private-key'"),
    );
    const backups = fs.readdirSync(directory).filter((name) => name.endsWith(".bak"));
    expect(backups).toHaveLength(1);
    const backup = path.join(directory, backups[0]!);
    expect(fs.readFileSync(backup, "utf8")).toBe(before);
    expect(fs.statSync(backup).mode & 0o777).toBe(0o600);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    execFileSync("/bin/sh", [
      "-c",
      '. "$1"; test "$AWS_REGION" = us-east-1 && test "$API_KEY" = synthetic-private-key',
      "proof",
      file,
    ]);
    expect(JSON.stringify(mocks.note.mock.calls)).toContain(
      `openclaw --profile quoteproof ${kind} restart`,
    );
    expect(JSON.stringify(mocks.note.mock.calls)).not.toContain("synthetic-private-key");
    await noteMacGatewayPlatformWarnings({}, prompter, env);
    expect(fs.readdirSync(directory)).toHaveLength(2);
  },
);

it.each([
  { repair: true, nonInteractive: true },
  { repair: true, yes: true },
])("reports ambiguous quote shapes without auto-approving them: %j", async (options) => {
  const home = tempDirs.make("doctor-env-quotes-");
  const file = path.join(home, ".openclaw", "service-env", "ai.openclaw.gateway.env");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const before = `${LAUNCH_AGENT_ENV_FILE_HEADER}\nexport API_KEY='"synthetic-private-key"'\n`;
  fs.writeFileSync(file, before, { mode: 0o600 });
  await noteMacGatewayPlatformWarnings(
    {},
    createDoctorPrompter({ runtime: defaultRuntime, options }),
    { HOME: home },
  );
  expect(JSON.stringify(mocks.note.mock.calls)).toContain("API_KEY");
  expect(JSON.stringify(mocks.note.mock.calls)).not.toContain("synthetic-private-key");
  expect(fs.readFileSync(file, "utf8")).toBe(before);
  expect(fs.readdirSync(path.dirname(file))).toHaveLength(1);
});

it("does not overwrite service env changed while the operator considers the repair", async () => {
  const home = tempDirs.make("doctor-env-quotes-");
  const directory = path.join(home, ".openclaw", "service-env");
  const file = path.join(directory, "ai.openclaw.gateway.env");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(file, `${LAUNCH_AGENT_ENV_FILE_HEADER}\nexport AWS_REGION='"us-east-1"'\n`);
  const replacement = `${LAUNCH_AGENT_ENV_FILE_HEADER}\nexport AWS_REGION='eu-west-1'\n`;
  const prompter = {
    ...createDoctorPrompter({ runtime: defaultRuntime, options: {} }),
    confirmRuntimeRepair: async () => {
      fs.writeFileSync(file, replacement);
      return true;
    },
  };
  await noteMacGatewayPlatformWarnings({}, prompter, { HOME: home });
  expect(fs.readFileSync(file, "utf8")).toBe(replacement);
  expect(fs.readdirSync(directory)).toEqual(["ai.openclaw.gateway.env"]);
  expect(JSON.stringify(mocks.note.mock.calls)).toContain("rerun doctor");
});

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

describe("macOS Gateway environment warnings", () => {
  it("prints clear unsetenv instructions for token override", async () => {
    mocks.runExec.mockImplementation(async (_command, [, name]) => ({
      stdout: name === "OPENCLAW_GATEWAY_TOKEN" ? " \tlaunchctl-token\n" : " \n",
      stderr: "",
    }));
    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          token: "config-token",
        },
      },
    };

    await noteMacGatewayPlatformWarnings(cfg);

    expect(mocks.note).toHaveBeenCalledTimes(1);
    expect(mocks.runExec).toHaveBeenCalledTimes(2);

    const [message, title] = expectDefined<unknown[]>(mocks.note.mock.calls[0], "note call 0");
    expect(title).toBe("Gateway (macOS)");
    expect(message).toContain("Host-wide launchctl gateway auth overrides detected");
    expect(message).toContain("Current managed Gateway installs do not need these values");
    expect(message).toContain("OPENCLAW_GATEWAY_TOKEN");
    expect(message).toContain("launchctl unsetenv OPENCLAW_GATEWAY_TOKEN");
    expect(message).not.toContain("OPENCLAW_GATEWAY_PASSWORD");
    expect(message).not.toContain("launchctl-token");
    expect(message).not.toContain("config-token");
  });

  it("treats SecretRef-backed credentials as configured", async () => {
    mocks.runExec.mockImplementation(async (_command, [, name]) => ({
      stdout: name === "OPENCLAW_GATEWAY_PASSWORD" ? " \tlaunchctl-password\n" : " \n",
      stderr: "",
    }));
    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          password: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_PASSWORD" },
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    };

    await noteMacGatewayPlatformWarnings(cfg);

    expect(mocks.note).toHaveBeenCalledTimes(1);
    const [message] = expectDefined<unknown[]>(mocks.note.mock.calls[0], "note call 0");
    expect(message).toContain("OPENCLAW_GATEWAY_PASSWORD");
    expect(message).not.toContain("OPENCLAW_GATEWAY_TOKEN");
    expect(message).not.toContain("launchctl-password");
  });

  it("does nothing on non-darwin platforms", async () => {
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "linux" });
    mocks.runExec.mockResolvedValue({ stdout: "launchctl-token", stderr: "" });
    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          token: "config-token",
        },
      },
    };

    await noteMacGatewayPlatformWarnings(cfg);

    expect(mocks.runExec).not.toHaveBeenCalled();
    expect(mocks.note).not.toHaveBeenCalled();
  });

  it("bounds launchctl getenv calls and ignores timeout failures", async () => {
    mocks.runExec.mockRejectedValue(new Error("timed out"));
    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          token: "config-token",
        },
      },
    };

    await noteMacGatewayPlatformWarnings(cfg);

    expect(mocks.runExec).toHaveBeenNthCalledWith(
      1,
      "/bin/launchctl",
      ["getenv", "OPENCLAW_GATEWAY_TOKEN"],
      { logOutput: false, timeoutMs: 5_000 },
    );
    expect(mocks.runExec).toHaveBeenNthCalledWith(
      2,
      "/bin/launchctl",
      ["getenv", "OPENCLAW_GATEWAY_PASSWORD"],
      { logOutput: false, timeoutMs: 5_000 },
    );
    expect(mocks.note).not.toHaveBeenCalled();
  });
});

describe("macOS stale updater warnings", () => {
  it("scans the installed service without caller state selectors", async () => {
    vi.stubEnv("OPENCLAW_HOME", "/tmp/caller-home");
    vi.stubEnv("OPENCLAW_PROFILE", "caller");
    vi.stubEnv("OPENCLAW_CONFIG_PATH", "/tmp/caller.json");
    mocks.readCommand.mockResolvedValue({
      programArguments: ["node", "openclaw.mjs", "gateway"],
      environment: { HOME: "/tmp/service-home" },
    });
    await collectGatewayPlatformWarnings({});
    const [env] = expectDefined<NodeJS.ProcessEnv[]>(
      mocks.findJobs.mock.calls[0],
      "scan environment",
    );
    expect(
      Object.fromEntries(
        [
          "HOME",
          "OPENCLAW_HOME",
          "OPENCLAW_STATE_DIR",
          "OPENCLAW_PROFILE",
          "OPENCLAW_CONFIG_PATH",
        ].map((key) => [key, env?.[key]]),
      ),
    ).toEqual({
      HOME: "/tmp/service-home",
      OPENCLAW_HOME: undefined,
      OPENCLAW_STATE_DIR: undefined,
      OPENCLAW_PROFILE: undefined,
      OPENCLAW_CONFIG_PATH: undefined,
    });
  });
  it("uses service env for gateway platform stale updater warnings", async () => {
    const serviceEnv = {
      OPENCLAW_STATE_DIR: "/tmp/openclaw-daemon",
      OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.manual-update.gateway",
    };
    mocks.readCommand.mockResolvedValue({
      programArguments: ["/bin/node", "cli", "gateway"],
      environment: serviceEnv,
    });

    const warnings = await collectGatewayPlatformWarnings({});

    expect(warnings).toEqual([]);
    expect(mocks.runExec).not.toHaveBeenCalled();
    expect(mocks.readCommand).toHaveBeenCalledTimes(1);
    expect(mocks.findJobs).toHaveBeenCalledWith(
      expect.objectContaining({
        HOME: "/tmp/openclaw-doctor-host",
        OPENCLAW_STATE_DIR: "/tmp/openclaw-daemon",
        OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.manual-update.gateway",
      }),
    );
  });

  it("prints stale updater job cleanup guidance on macOS", async () => {
    mocks.findJobs.mockResolvedValue([
      {
        label: "ai.openclaw.update.2026.5.12",
        lastExitStatus: 127,
      },
      {
        label: "ai.openclaw.manual-update.1717168800",
        lastExitStatus: 0,
      },
    ]);

    await noteMacGatewayPlatformWarnings({});

    expect(mocks.findJobs).toHaveBeenCalledTimes(1);
    const [message, title] = expectDefined<unknown[]>(mocks.note.mock.calls[0], "note call 0");
    expect(title).toBe("Gateway (macOS)");
    expect(message).toContain("Stale OpenClaw updater launchd job(s) detected");
    expect(message).toContain("ai.openclaw.update.2026.5.12");
    expect(message).toContain("ai.openclaw.manual-update.1717168800");
    expect(message).toContain("launchctl remove <label>");
    expect(message).toContain("openclaw gateway restart");
  });
});

describe("collectGatewayPlatformWarnings", () => {
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
});

describe("noteStartupOptimizationHints", () => {
  beforeEach(() => {
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "linux" });
    vi.spyOn(os, "arch").mockReturnValue("arm64");
    vi.spyOn(os, "totalmem").mockReturnValue(4 * 1024 ** 3);
  });

  it("does not warn when compile cache and no-respawn are configured", () => {
    noteStartupOptimizationHints({
      NODE_COMPILE_CACHE: "/var/tmp/openclaw-compile-cache",
      OPENCLAW_NO_RESPAWN: "1",
    });

    expect(mocks.note).not.toHaveBeenCalled();
  });

  it("warns when compile cache is under /tmp and no-respawn is not set", () => {
    noteStartupOptimizationHints({
      NODE_COMPILE_CACHE: "/tmp/openclaw-compile-cache",
    });

    expect(mocks.note).toHaveBeenCalledTimes(1);
    const [message, title] = expectDefined<unknown[]>(mocks.note.mock.calls[0], "note call 0");
    expect(title).toBe("Startup optimization");
    expect(message).toBe(
      [
        "- NODE_COMPILE_CACHE points to /tmp; use /var/tmp so cache survives reboots and warms startup reliably.",
        "- OPENCLAW_NO_RESPAWN is not set to 1; set it when you want routine gateway restarts to stay in-process instead of handing off to a managed supervisor.",
        "- Suggested env for low-power hosts:",
        "  export NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache",
        "  mkdir -p /var/tmp/openclaw-compile-cache",
        "  export OPENCLAW_NO_RESPAWN=1",
      ].join("\n"),
    );
  });

  it("warns when compile cache is disabled via env override", () => {
    noteStartupOptimizationHints({
      NODE_COMPILE_CACHE: "/var/tmp/openclaw-compile-cache",
      OPENCLAW_NO_RESPAWN: "1",
      NODE_DISABLE_COMPILE_CACHE: "1",
    });

    expect(mocks.note).toHaveBeenCalledTimes(1);
    const [message] = expectDefined<unknown[]>(mocks.note.mock.calls[0], "note call 0");
    expect(message).toBe(
      [
        "- NODE_DISABLE_COMPILE_CACHE is set; startup compile cache is disabled.",
        "- Suggested env for low-power hosts:",
        "  export NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache",
        "  mkdir -p /var/tmp/openclaw-compile-cache",
        "  export OPENCLAW_NO_RESPAWN=1",
        "  unset NODE_DISABLE_COMPILE_CACHE",
      ].join("\n"),
    );
  });

  it("skips startup optimization note on win32", () => {
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });

    noteStartupOptimizationHints({
      NODE_COMPILE_CACHE: "/tmp/openclaw-compile-cache",
    });

    expect(mocks.note).not.toHaveBeenCalled();
  });

  it("skips startup optimization note on non-target linux hosts", () => {
    vi.mocked(os.arch).mockReturnValue("x64");
    vi.mocked(os.totalmem).mockReturnValue(32 * 1024 ** 3);

    noteStartupOptimizationHints({
      NODE_COMPILE_CACHE: "/tmp/openclaw-compile-cache",
    });

    expect(mocks.note).not.toHaveBeenCalled();
  });
});
