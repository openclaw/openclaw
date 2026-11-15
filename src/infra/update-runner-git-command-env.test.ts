import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
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

it.each<{
  manager: "pnpm" | "npm";
  ambient?: boolean;
  env?: NodeJS.ProcessEnv;
  response?: { code: number; stdout: string };
  expected?: NodeJS.ProcessEnv;
}>([
  { manager: "npm" },
  { manager: "npm", ambient: true },
  {
    manager: "pnpm",
    expected: { PNPM_CONFIG_PREFER_OFFLINE: "true", pnpm_config_prefer_offline: "true" },
  },
  {
    manager: "pnpm",
    env: { PNPM_CONFIG_PREFER_OFFLINE: "false" },
    expected: { PNPM_CONFIG_PREFER_OFFLINE: "false" },
  },
  {
    manager: "pnpm",
    env: { pnpm_config_prefer_offline: "false" },
    expected: { pnpm_config_prefer_offline: "false" },
  },
  { manager: "pnpm", response: { code: 0, stdout: "false" } },
  { manager: "pnpm", response: { code: 1, stdout: "" } },
])(
  "isolates candidate source and preserves install policy: %j",
  async ({ manager, ambient, env: overrides, response, expected = {} }) => {
    const candidate = tempDirs.make("candidate-install-env-");
    const serving = path.join(candidate, "installed");
    vi.stubEnv("OPENCLAW_DEV_SOURCE_ROOT", serving);
    const env = ambient
      ? undefined
      : { OPENCLAW_DEV_SOURCE_ROOT: serving, KEEP: "value", ...overrides };
    const original = { ...env };
    const command = vi.fn<CommandRunner>();
    if (manager === "pnpm") {
      command.mockResolvedValue({ code: 0, stdout: "", ...response, stderr: "" });
    }
    const prepared = await prepareCandidateCommandEnv(manager, env, candidate, command, 1000);
    expect(prepared.env.OPENCLAW_DEV_SOURCE_ROOT).toBe(candidate);
    expect(process.env.OPENCLAW_DEV_SOURCE_ROOT).toBe(serving);
    if (env) {
      expect(prepared.env.KEEP).toBe("value");
      expect(prepared.env).not.toBe(env);
      expect(env).toEqual(original);
    }
    if (manager === "pnpm") {
      expect(prepared.env).toMatchObject({
        PNPM_CONFIG_RESOLUTION_MODE: "highest",
        npm_config_resolution_mode: "highest",
        pnpm_config_resolution_mode: "highest",
      });
      expect(prepared.env.PNPM_CONFIG_PREFER_OFFLINE).toBe(expected.PNPM_CONFIG_PREFER_OFFLINE);
      expect(prepared.env.pnpm_config_prefer_offline).toBe(expected.pnpm_config_prefer_offline);
    }
  },
);

it.each([undefined, "--max-old-space-size=16384"])(
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
