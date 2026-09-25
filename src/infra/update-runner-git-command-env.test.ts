import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withMockedWindowsPlatform } from "../test-utils/vitest-spies.js";
import {
  prepareCandidateCommandEnv,
  resolveBuildEnv,
  resolveDevPreflightLintEnv,
  shouldInstallWithoutScriptsOnWindows,
} from "./update-runner-git-commands.js";
import type { CommandRunner } from "./update-runner-types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

describe("candidate command source isolation", () => {
  it.each(["pnpm", "npm", "bun"] as const)(
    "binds %s commands to candidate source without changing the caller",
    async (manager) => {
      const candidate = tempDirs.make("candidate-command-env-");
      const env = { OPENCLAW_DEV_SOURCE_ROOT: path.join(candidate, "installed"), KEEP: "value" };
      const original = { ...env };
      const runCommand = vi.fn<CommandRunner>().mockResolvedValue({
        code: 0,
        stdout: "",
        stderr: "",
      });
      const prepared = await prepareCandidateCommandEnv(manager, env, candidate, runCommand, 1000);
      expect(prepared.env).toMatchObject({ OPENCLAW_DEV_SOURCE_ROOT: candidate, KEEP: "value" });
      expect(prepared.env).not.toBe(env);
      expect(env).toEqual(original);
    },
  );

  it("replaces an ambient serving source root when no command env was supplied", async () => {
    const candidate = tempDirs.make("candidate-command-env-");
    const serving = path.join(candidate, "installed");
    vi.stubEnv("OPENCLAW_DEV_SOURCE_ROOT", serving);
    const runCommand = vi.fn<CommandRunner>();
    const prepared = await prepareCandidateCommandEnv(
      "npm",
      undefined,
      candidate,
      runCommand,
      1000,
    );
    expect(prepared.env?.OPENCLAW_DEV_SOURCE_ROOT).toBe(candidate);
    expect(process.env.OPENCLAW_DEV_SOURCE_ROOT).toBe(serving);
  });
});

it.each([
  {
    env: {},
    response: { code: 0, stdout: "" },
    expected: { PNPM_CONFIG_PREFER_OFFLINE: "true", pnpm_config_prefer_offline: "true" },
  },
  {
    env: { PNPM_CONFIG_PREFER_OFFLINE: "false" },
    response: { code: 0, stdout: "" },
    expected: { PNPM_CONFIG_PREFER_OFFLINE: "false" },
  },
  {
    env: { pnpm_config_prefer_offline: "false" },
    response: { code: 0, stdout: "" },
    expected: { pnpm_config_prefer_offline: "false" },
  },
  {
    env: { PNPM_CONFIG_PREFER_OFFLINE: "true", pnpm_config_prefer_offline: "false" },
    response: { code: 0, stdout: "" },
    expected: { PNPM_CONFIG_PREFER_OFFLINE: "true", pnpm_config_prefer_offline: "false" },
  },
  { env: {}, response: { code: 0, stdout: "false" }, expected: {} },
  { env: {}, response: { code: 1, stdout: "" }, expected: {} },
])(
  "preserves pnpm install resolution and offline provenance: $env $response",
  async ({ env, response, expected }) => {
    const candidate = tempDirs.make("candidate-install-env-");
    const command = vi.fn<CommandRunner>().mockResolvedValue({ ...response, stderr: "" });
    const prepared = await prepareCandidateCommandEnv("pnpm", env, candidate, command, 1000);
    expect(prepared.env).toMatchObject({
      PNPM_CONFIG_RESOLUTION_MODE: "highest",
      npm_config_resolution_mode: "highest",
      pnpm_config_resolution_mode: "highest",
    });
    expect(prepared.env.PNPM_CONFIG_PREFER_OFFLINE).toBe(expected.PNPM_CONFIG_PREFER_OFFLINE);
    expect(prepared.env.pnpm_config_prefer_offline).toBe(expected.pnpm_config_prefer_offline);
  },
);

it.each([undefined, "--max-old-space-size=8192", "--max-old-space-size=16384"])(
  "keeps candidate build heap/cache policy: %s",
  (nodeOptions) => {
    vi.stubEnv("NODE_OPTIONS", undefined);
    const env = { NODE_OPTIONS: nodeOptions, OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "0" };
    expect(resolveBuildEnv(env, "/candidate/cache")).toMatchObject({
      OPENCLAW_UPDATE_IN_PROGRESS: "1",
      NODE_OPTIONS: nodeOptions ?? "--max-old-space-size=8192",
      BUILD_ALL_CACHE_ROOT: "/candidate/cache",
      OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "0",
    });
    expect(resolveDevPreflightLintEnv(env)).toMatchObject({
      OPENCLAW_LOCAL_CHECK: "1",
      OPENCLAW_LOCAL_CHECK_MODE: "throttled",
    });
  },
);

it("disables only pnpm candidate lifecycle scripts on Windows", async () => {
  await withMockedWindowsPlatform(async () => {
    expect(shouldInstallWithoutScriptsOnWindows("pnpm")).toBe(true);
    expect(shouldInstallWithoutScriptsOnWindows("npm")).toBe(false);
    expect(shouldInstallWithoutScriptsOnWindows("bun")).toBe(false);
  });
});
