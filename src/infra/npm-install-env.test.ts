import fsSync from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
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

describe("npm project install env", () => {
  it.each([["NPM_CONFIG_FETCH_RETRIES", "0"]])(
    "preserves explicit network config %s without a competing default",
    (key, value) => {
      const env = createNpmProjectInstallEnv({ [key]: value }, {}, FROZEN_NOW);

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
        expect(
          createNpmProjectInstallEnv({ PATH: "/tmp/openclaw-npm-global/bin" }, {}, FROZEN_NOW),
        ).toEqual({
          ...EXPECTED_PROJECT_ENV,
          NPM_CONFIG_SCRIPT_SHELL: "/bin/sh",
          PATH: "/tmp/openclaw-npm-global/bin",
        });
      });
    });
  });

  it("preserves explicit npm script shell config", () => {
    withMockedPlatform("linux", () => {
      expect(
        createNpmProjectInstallEnv({ NPM_CONFIG_SCRIPT_SHELL: "/custom/sh" }, {}, FROZEN_NOW),
      ).toEqual({ ...EXPECTED_PROJECT_ENV, NPM_CONFIG_SCRIPT_SHELL: "/custom/sh" });
      expect(
        createNpmProjectInstallEnv({ npm_config_script_shell: "/custom/lower-sh" }, {}, FROZEN_NOW),
      ).toEqual({ ...EXPECTED_PROJECT_ENV, npm_config_script_shell: "/custom/lower-sh" });
    });
  });

  it("uses release-age args by default", () => {
    expect(createNpmFreshnessBypassArgs({}, FROZEN_NOW)).toEqual(["--min-release-age=0"]);
  });

  it("uses before args for expanded npm userconfig paths", async () => {
    await withTempDir("openclaw-home-npmrc-", async (dir) => {
      const baseEnv = createIsolatedNpmConfigEnv(dir);
      // Keep user config outside the project scope so path expansion must succeed.
      writePolicy(path.join(dir, "home", ".npmrc"));

      expect(
        createNpmFreshnessBypassArgs(
          { ...baseEnv, NPM_CONFIG_USERCONFIG: "~/.npmrc" },
          FROZEN_NOW,
          { npmConfigCwd: dir },
        ),
      ).toEqual(BEFORE_ARGS);
      expect(
        createNpmFreshnessBypassArgs(
          { ...baseEnv, NPM_CONFIG_USERCONFIG: "${HOME}/.npmrc" },
          FROZEN_NOW,
          { npmConfigCwd: dir },
        ),
      ).toEqual(BEFORE_ARGS);
    });
  });

  it("uses before args for npm default globalconfig before policies", async () => {
    await withTempDir("openclaw-npm-prefix-", async (dir) => {
      const home = path.join(dir, "home");
      fsSync.mkdirSync(home, { recursive: true });
      writePolicy(path.join(dir, "etc", "npmrc"));

      expect(
        createNpmFreshnessBypassArgs({ HOME: home, NPM_CONFIG_PREFIX: dir }, FROZEN_NOW, {
          npmConfigCwd: dir,
        }),
      ).toEqual(BEFORE_ARGS);
    });
  });

  it("uses before args for command project npmrc before policies", async () => {
    await withTempDir("openclaw-project-npmrc-", async (dir) => {
      const baseEnv = createIsolatedNpmConfigEnv(dir);
      writePolicy(path.join(dir, ".npmrc"));

      expect(createNpmFreshnessBypassArgs(baseEnv, FROZEN_NOW, { npmConfigCwd: dir })).toEqual(
        BEFORE_ARGS,
      );

      const env = createNpmProjectInstallEnv(baseEnv, { npmConfigCwd: dir }, FROZEN_NOW);
      expect(env.npm_config_min_release_age).toBe("");
      expect(env.npm_config_before).toBe(FROZEN_NOW.toISOString());
    });
  });

  it("prefers scoped npm prefix policy over parent npm prefix policy", async () => {
    await withTempDir("openclaw-prefix-npmrc-", async (dir) => {
      const baseEnv = createIsolatedNpmConfigEnv(dir);
      const scopedPrefix = path.join(dir, "scoped-prefix");
      const parentPrefix = path.join(dir, "parent-prefix");
      writePolicy(path.join(scopedPrefix, "etc", "npmrc"));
      writePolicy(path.join(parentPrefix, "etc", "npmrc"), "min-release-age=7");

      expect(
        createNpmFreshnessBypassArgs({ ...baseEnv, NPM_CONFIG_PREFIX: parentPrefix }, FROZEN_NOW, {
          npmConfigCwd: dir,
          npmConfigPrefix: scopedPrefix,
        }),
      ).toEqual(BEFORE_ARGS);
    });
  });
});
