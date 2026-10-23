import fsSync from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";
import { withMockedPlatform, withRestoredMocks } from "../test-utils/vitest-spies.js";
import { createNpmFreshnessBypassArgs, createNpmProjectInstallEnv } from "./npm-install-env.js";

const FROZEN_NOW = new Date("2026-05-18T19:55:00.000Z");
const BEFORE_ARGS = [`--before=${FROZEN_NOW.toISOString()}`];

function writePolicy(file: string, policy = "before=2026-01-01T00:00:00.000Z") {
  fsSync.mkdirSync(path.dirname(file), { recursive: true });
  fsSync.writeFileSync(file, `${policy}\n`, "utf-8");
}
const EXPECTED_PROJECT_ENV = {
  NPM_CONFIG_BEFORE: "",
  NPM_CONFIG_MIN_RELEASE_AGE: "",
  "NPM_CONFIG_MIN-RELEASE-AGE": "",
  npm_config_before: "",
  "npm_config_min-release-age": "",
  npm_config_min_release_age: "0",
  npm_config_dry_run: "false",
  npm_config_fetch_retries: "5",
  npm_config_fetch_retry_maxtimeout: "120000",
  npm_config_fetch_retry_mintimeout: "10000",
  npm_config_fetch_timeout: "300000",
  npm_config_global: "false",
  npm_config_location: "project",
  npm_config_package_lock: "false",
  npm_config_save: "false",
};

function createIsolatedNpmConfigEnv(dir: string): NodeJS.ProcessEnv {
  const home = path.join(dir, "home");
  const globalconfig = path.join(dir, "global-npmrc");
  fsSync.mkdirSync(home, { recursive: true });
  fsSync.writeFileSync(globalconfig, "", "utf-8");
  return { HOME: home, NPM_CONFIG_GLOBALCONFIG: globalconfig };
}

function withNpmConfig(run: (dir: string, env: NodeJS.ProcessEnv) => void) {
  return withTempDir("openclaw-npm-config-", async (dir) => {
    run(dir, createIsolatedNpmConfigEnv(dir));
  });
}

function expectBefore(env: NodeJS.ProcessEnv, dir: string, npmConfigPrefix?: string) {
  expect(
    createNpmFreshnessBypassArgs(env, FROZEN_NOW, { npmConfigCwd: dir, npmConfigPrefix }),
  ).toEqual(BEFORE_ARGS);
}

describe("npm project install env", () => {
  afterEach(() => vi.useRealTimers());
  it.each([["NPM_CONFIG_FETCH_RETRIES", "0"]])(
    "preserves explicit network config %s without a competing default",
    (key, value) => {
      const env = createNpmProjectInstallEnv({ [key]: value });

      expect(env[key]).toBe(value);
      expect(
        Object.keys(env).filter((candidate) => candidate.toLowerCase() === key.toLowerCase()),
      ).toEqual([key]);
    },
  );

  it("uses an absolute POSIX script shell for npm lifecycle scripts", () => {
    withMockedPlatform("linux", () => {
      const existsSyncSpy = vi
        .spyOn(fsSync, "existsSync")
        .mockImplementation((candidate) => candidate === "/bin/sh");
      withRestoredMocks([existsSyncSpy], () => {
        expect(createNpmProjectInstallEnv({ PATH: "/tmp/openclaw-npm-global/bin" })).toEqual({
          ...EXPECTED_PROJECT_ENV,
          NPM_CONFIG_SCRIPT_SHELL: "/bin/sh",
          PATH: "/tmp/openclaw-npm-global/bin",
        });
      });
    });
  });

  it.each(["NPM_CONFIG_SCRIPT_SHELL", "npm_config_script_shell"])("preserves %s", (key) => {
    withMockedPlatform("linux", () => {
      expect(createNpmProjectInstallEnv({ [key]: "/custom/sh" })).toEqual({
        ...EXPECTED_PROJECT_ENV,
        [key]: "/custom/sh",
      });
    });
  });

  it("uses release-age args by default", () => {
    expect(createNpmFreshnessBypassArgs({}, FROZEN_NOW)).toEqual(["--min-release-age=0"]);
  });

  it.each(["~/.npmrc", "${HOME}/.npmrc"])("expands userconfig %s", async (userconfig) => {
    await withNpmConfig((dir, baseEnv) => {
      // Keep user config outside the project scope so path expansion must succeed.
      writePolicy(path.join(dir, "home", ".npmrc"));

      expectBefore({ ...baseEnv, NPM_CONFIG_USERCONFIG: userconfig }, dir);
    });
  });

  it("uses before args for npm default globalconfig before policies", async () => {
    await withTempDir("openclaw-npm-prefix-", async (dir) => {
      const home = path.join(dir, "home");
      fsSync.mkdirSync(home, { recursive: true });
      writePolicy(path.join(dir, "etc", "npmrc"));

      expectBefore({ HOME: home, NPM_CONFIG_PREFIX: dir }, dir);
    });
  });

  it("uses before args for command project npmrc before policies", async () => {
    vi.useFakeTimers({ now: FROZEN_NOW, toFake: ["Date"] });
    await withNpmConfig((dir, baseEnv) => {
      writePolicy(path.join(dir, ".npmrc"));

      expectBefore(baseEnv, dir);

      const env = createNpmProjectInstallEnv(baseEnv, { npmConfigCwd: dir });
      expect(env).toMatchObject({
        npm_config_min_release_age: "",
        npm_config_before: FROZEN_NOW.toISOString(),
      });
    });
  });

  it("prefers scoped npm prefix policy over parent npm prefix policy", async () => {
    await withNpmConfig((dir, baseEnv) => {
      const scopedPrefix = path.join(dir, "scoped-prefix");
      const parentPrefix = path.join(dir, "parent-prefix");
      writePolicy(path.join(scopedPrefix, "etc", "npmrc"));
      writePolicy(path.join(parentPrefix, "etc", "npmrc"), "min-release-age=7");

      expectBefore({ ...baseEnv, NPM_CONFIG_PREFIX: parentPrefix }, dir, scopedPrefix);
    });
  });
});
