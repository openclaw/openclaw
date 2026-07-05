// Run-main profile env tests cover profile environment handling in the CLI entrypoint.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
<<<<<<< HEAD
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

const fileState = vi.hoisted(() => ({
  hasCliDotEnv: false,
}));

const dotenvState = vi.hoisted(() => {
  const state = {
    profileAtDotenvLoad: undefined as string | undefined,
    containerAtDotenvLoad: undefined as string | undefined,
  };
  return {
    state,
    loadDotEnv: vi.fn(() => {
      state.profileAtDotenvLoad = process.env.OPENCLAW_PROFILE;
      state.containerAtDotenvLoad = process.env.OPENCLAW_CONTAINER;
    }),
  };
});

const maybeRunCliInContainerMock = vi.hoisted(() =>
  vi.fn((argv: string[]) => ({ handled: false, argv })),
);

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  type ExistsSyncPath = Parameters<typeof actual.existsSync>[0];
  return {
    ...actual,
    existsSync: vi.fn((target: ExistsSyncPath) => {
      if (typeof target === "string" && target.endsWith(".env")) {
        return fileState.hasCliDotEnv;
      }
      return actual.existsSync(target);
    }),
  };
});

vi.mock("./dotenv.js", () => ({
  loadCliDotEnv: dotenvState.loadDotEnv,
}));

vi.mock("../infra/env.js", () => ({
  isTruthyEnvValue: (value?: string) =>
    typeof value === "string" && ["1", "on", "true", "yes"].includes(value.trim().toLowerCase()),
  normalizeEnv: vi.fn(),
}));

vi.mock("../infra/runtime-guard.js", () => ({
  assertSupportedRuntime: vi.fn(),
}));

vi.mock("../infra/path-env.js", () => ({
  ensureOpenClawCliOnPath: vi.fn(),
}));

vi.mock("./route.js", () => ({
  tryRouteCli: vi.fn(async () => true),
}));

vi.mock("./windows-argv.js", () => ({
  normalizeWindowsArgv: (argv: string[]) => argv,
}));

vi.mock("./container-target.js", async () => {
  const actual =
    await vi.importActual<typeof import("./container-target.js")>("./container-target.js");
  return {
    ...actual,
    maybeRunCliInContainer: maybeRunCliInContainerMock,
  };
});

import { runCli } from "./run-main.js";

describe("runCli profile env bootstrap", () => {
<<<<<<< HEAD
  const envSnapshot = captureEnv([
    "OPENCLAW_PROFILE",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_CONFIG_PATH",
    "OPENCLAW_CONTAINER",
    "OPENCLAW_GATEWAY_PORT",
    "OPENCLAW_GATEWAY_URL",
    "OPENCLAW_GATEWAY_TOKEN",
    "OPENCLAW_GATEWAY_PASSWORD",
  ]);

  beforeEach(() => {
    deleteTestEnvValue("OPENCLAW_PROFILE");
    deleteTestEnvValue("OPENCLAW_STATE_DIR");
    deleteTestEnvValue("OPENCLAW_CONFIG_PATH");
    deleteTestEnvValue("OPENCLAW_CONTAINER");
    deleteTestEnvValue("OPENCLAW_GATEWAY_PORT");
    deleteTestEnvValue("OPENCLAW_GATEWAY_URL");
    deleteTestEnvValue("OPENCLAW_GATEWAY_TOKEN");
    deleteTestEnvValue("OPENCLAW_GATEWAY_PASSWORD");
=======
  const originalProfile = process.env.OPENCLAW_PROFILE;
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;
  const originalConfigPath = process.env.OPENCLAW_CONFIG_PATH;
  const originalContainer = process.env.OPENCLAW_CONTAINER;
  const originalGatewayPort = process.env.OPENCLAW_GATEWAY_PORT;
  const originalGatewayUrl = process.env.OPENCLAW_GATEWAY_URL;
  const originalGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  const originalGatewayPassword = process.env.OPENCLAW_GATEWAY_PASSWORD;

  beforeEach(() => {
    delete process.env.OPENCLAW_PROFILE;
    delete process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_CONFIG_PATH;
    delete process.env.OPENCLAW_CONTAINER;
    delete process.env.OPENCLAW_GATEWAY_PORT;
    delete process.env.OPENCLAW_GATEWAY_URL;
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.OPENCLAW_GATEWAY_PASSWORD;
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    dotenvState.state.profileAtDotenvLoad = undefined;
    dotenvState.state.containerAtDotenvLoad = undefined;
    dotenvState.loadDotEnv.mockClear();
    maybeRunCliInContainerMock.mockClear();
    fileState.hasCliDotEnv = false;
  });

  afterEach(() => {
<<<<<<< HEAD
    envSnapshot.restore();
=======
    if (originalProfile === undefined) {
      delete process.env.OPENCLAW_PROFILE;
    } else {
      process.env.OPENCLAW_PROFILE = originalProfile;
    }
    if (originalContainer === undefined) {
      delete process.env.OPENCLAW_CONTAINER;
    } else {
      process.env.OPENCLAW_CONTAINER = originalContainer;
    }
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
    if (originalConfigPath === undefined) {
      delete process.env.OPENCLAW_CONFIG_PATH;
    } else {
      process.env.OPENCLAW_CONFIG_PATH = originalConfigPath;
    }
    if (originalGatewayPort === undefined) {
      delete process.env.OPENCLAW_GATEWAY_PORT;
    } else {
      process.env.OPENCLAW_GATEWAY_PORT = originalGatewayPort;
    }
    if (originalGatewayUrl === undefined) {
      delete process.env.OPENCLAW_GATEWAY_URL;
    } else {
      process.env.OPENCLAW_GATEWAY_URL = originalGatewayUrl;
    }
    if (originalGatewayToken === undefined) {
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
    } else {
      process.env.OPENCLAW_GATEWAY_TOKEN = originalGatewayToken;
    }
    if (originalGatewayPassword === undefined) {
      delete process.env.OPENCLAW_GATEWAY_PASSWORD;
    } else {
      process.env.OPENCLAW_GATEWAY_PASSWORD = originalGatewayPassword;
    }
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  });

  it("applies --profile before dotenv loading", async () => {
    fileState.hasCliDotEnv = true;
    await runCli(["node", "openclaw", "--profile", "rawdog", "status"]);

    expect(dotenvState.loadDotEnv).toHaveBeenCalledOnce();
    expect(dotenvState.state.profileAtDotenvLoad).toBe("rawdog");
    expect(process.env.OPENCLAW_PROFILE).toBe("rawdog");
  });

  it("rejects --container combined with --profile", async () => {
    await expect(
      runCli(["node", "openclaw", "--container", "demo", "--profile", "rawdog", "status"]),
    ).rejects.toThrow("--container cannot be combined with --profile/--dev");

    expect(dotenvState.loadDotEnv).not.toHaveBeenCalled();
    expect(process.env.OPENCLAW_PROFILE).toBe("rawdog");
  });

  it("rejects --container combined with interleaved --profile", async () => {
    await expect(
      runCli(["node", "openclaw", "status", "--container", "demo", "--profile", "rawdog"]),
    ).rejects.toThrow("--container cannot be combined with --profile/--dev");
  });

  it("rejects --container combined with interleaved --dev", async () => {
    await expect(
      runCli(["node", "openclaw", "status", "--container", "demo", "--dev"]),
    ).rejects.toThrow("--container cannot be combined with --profile/--dev");
  });

  it("does not let dotenv change container target resolution", async () => {
    fileState.hasCliDotEnv = true;
    dotenvState.loadDotEnv.mockImplementationOnce(() => {
      process.env.OPENCLAW_CONTAINER = "demo";
      dotenvState.state.profileAtDotenvLoad = process.env.OPENCLAW_PROFILE;
      dotenvState.state.containerAtDotenvLoad = process.env.OPENCLAW_CONTAINER;
    });

    await runCli(["node", "openclaw", "status"]);

    expect(dotenvState.loadDotEnv).toHaveBeenCalledOnce();
    expect(process.env.OPENCLAW_CONTAINER).toBe("demo");
    expect(dotenvState.state.containerAtDotenvLoad).toBe("demo");
    expect(maybeRunCliInContainerMock).toHaveBeenCalledWith(["node", "openclaw", "status"]);
    expect(maybeRunCliInContainerMock).toHaveReturnedWith({
      handled: false,
      argv: ["node", "openclaw", "status"],
    });
  });

  it("allows container mode when OPENCLAW_PROFILE is already set in env", async () => {
<<<<<<< HEAD
    setTestEnvValue("OPENCLAW_PROFILE", "work");
=======
    process.env.OPENCLAW_PROFILE = "work";
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

    await expect(
      runCli(["node", "openclaw", "--container", "demo", "status"]),
    ).resolves.toBeUndefined();
  });

  it.each([
    ["OPENCLAW_GATEWAY_PORT", "19001"],
    ["OPENCLAW_GATEWAY_URL", "ws://127.0.0.1:18789"],
    ["OPENCLAW_GATEWAY_TOKEN", "demo-token"],
    ["OPENCLAW_GATEWAY_PASSWORD", "demo-password"],
  ])("allows container mode when %s is set in env", async (key, value) => {
<<<<<<< HEAD
    setTestEnvValue(key, value);
=======
    process.env[key] = value;
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

    await expect(
      runCli(["node", "openclaw", "--container", "demo", "status"]),
    ).resolves.toBeUndefined();
  });

  it("allows container mode when only OPENCLAW_STATE_DIR is set in env", async () => {
<<<<<<< HEAD
    setTestEnvValue("OPENCLAW_STATE_DIR", "/tmp/openclaw-host-state");
=======
    process.env.OPENCLAW_STATE_DIR = "/tmp/openclaw-host-state";
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

    await expect(
      runCli(["node", "openclaw", "--container", "demo", "status"]),
    ).resolves.toBeUndefined();
  });

  it("allows container mode when only OPENCLAW_CONFIG_PATH is set in env", async () => {
<<<<<<< HEAD
    setTestEnvValue("OPENCLAW_CONFIG_PATH", "/tmp/openclaw-host-state/openclaw.json");
=======
    process.env.OPENCLAW_CONFIG_PATH = "/tmp/openclaw-host-state/openclaw.json";
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

    await expect(
      runCli(["node", "openclaw", "--container", "demo", "status"]),
    ).resolves.toBeUndefined();
  });
});
