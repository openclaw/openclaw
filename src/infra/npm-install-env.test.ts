import fsSync from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
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

function withNpmConfig(run: (dir: string, env: NodeJS.ProcessEnv) => void) {
  return withTempDir("openclaw-npm-config-", async (dir) => {
    const home = path.join(dir, "home");
    const globalconfig = path.join(dir, "global-npmrc");
    fsSync.mkdirSync(home);
    fsSync.writeFileSync(globalconfig, "");
    run(dir, { HOME: home, NPM_CONFIG_GLOBALCONFIG: globalconfig });
  });
}

function expectBefore(env: NodeJS.ProcessEnv, dir: string, npmConfigPrefix?: string) {
  expect(
    createNpmFreshnessBypassArgs(env, FROZEN_NOW, { npmConfigCwd: dir, npmConfigPrefix }),
  ).toEqual(BEFORE_ARGS);
}

describe("npm project install env", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  it("preserves explicit network config without a competing default", () => {
    const key = "NPM_CONFIG_FETCH_RETRIES";
    const env = createNpmProjectInstallEnv({ [key]: "0" });
    expect(env[key]).toBe("0");
    expect(Object.keys(env).filter((name) => name.toLowerCase() === key.toLowerCase())).toEqual([
      key,
    ]);
  });
  it.each([undefined, "NPM_CONFIG_SCRIPT_SHELL", "npm_config_script_shell"])(
    "uses a POSIX lifecycle shell unless %s overrides it",
    (key) => {
      withMockedPlatform("linux", () => {
        vi.spyOn(fsSync, "existsSync").mockImplementation((candidate) => candidate === "/bin/sh");
        const input = key ? { [key]: "/custom/sh" } : { PATH: "/tmp/openclaw-npm-global/bin" };
        expect(createNpmProjectInstallEnv(input)).toEqual({
          ...EXPECTED_PROJECT_ENV,
          ...(key ? input : { ...input, NPM_CONFIG_SCRIPT_SHELL: "/bin/sh" }),
        });
      });
    },
  );

  it("uses release-age args by default", () => {
    expect(createNpmFreshnessBypassArgs({}, FROZEN_NOW)).toEqual(["--min-release-age=0"]);
  });

  it.each([
    ["user", "~/.npmrc"],
    ["user", "${HOME}/.npmrc"],
    ["global", undefined],
    ["project", undefined],
    ["scoped", undefined],
  ])("uses before policy from %s config (%s)", async (source, userconfig) => {
    vi.useFakeTimers({ now: FROZEN_NOW, toFake: ["Date"] });
    await withNpmConfig((dir, env) => {
      let npmConfigPrefix: string | undefined;
      if (source === "user") {
        writePolicy(path.join(dir, "home", ".npmrc"));
        env.NPM_CONFIG_USERCONFIG = userconfig;
      } else if (source === "global") {
        delete env.NPM_CONFIG_GLOBALCONFIG;
        env.NPM_CONFIG_PREFIX = dir;
        writePolicy(path.join(dir, "etc", "npmrc"));
      } else if (source === "scoped") {
        npmConfigPrefix = path.join(dir, "scoped-prefix");
        env.NPM_CONFIG_PREFIX = path.join(dir, "parent-prefix");
        writePolicy(path.join(npmConfigPrefix, "etc", "npmrc"));
        writePolicy(path.join(env.NPM_CONFIG_PREFIX, "etc", "npmrc"), "min-release-age=7");
      } else {
        writePolicy(path.join(dir, ".npmrc"));
      }
      expectBefore(env, dir, npmConfigPrefix);
      if (source === "project") {
        expect(createNpmProjectInstallEnv(env, { npmConfigCwd: dir })).toMatchObject({
          npm_config_min_release_age: "",
          npm_config_before: FROZEN_NOW.toISOString(),
        });
      }
    });
  });
});
