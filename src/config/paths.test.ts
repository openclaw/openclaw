import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveLegacyOAuthPath } from "../agents/auth-profiles/legacy-source-diagnostic.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import {
  allowsProcessHomeSessionScan,
  CONFIG_PATH,
  DEFAULT_GATEWAY_PORT,
  isDefaultInstallIdentity,
  isDefaultStateDir,
  isNixMode,
  normalizeStateDirEnv,
  pinRuntimePaths,
  resolveNativeServiceProfileConflict,
  resolveDefaultConfigCandidates,
  resolveConfigPathCandidate,
  resolveGatewayPort,
  resolveIncludeRoots,
  resolveOAuthDir,
  resolveStateDir,
  STATE_DIR,
} from "./paths.js";

const accountHome = "/home/test";
const defaultPaths = {
  HOME: accountHome,
  OPENCLAW_STATE_DIR: path.join(accountHome, ".openclaw"),
  OPENCLAW_CONFIG_PATH: path.join(accountHome, ".openclaw", "openclaw.json"),
};
function installIdentity(env: NodeJS.ProcessEnv, home = accountHome) {
  return isDefaultInstallIdentity(env, () => home);
}
function profileEnv(home: string, profile = "work"): NodeJS.ProcessEnv {
  const stateDir = path.join(home, profile === "default" ? ".openclaw" : `.openclaw-${profile}`);
  return {
    HOME: home,
    OPENCLAW_PROFILE: profile,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
  };
}

const withHome = (run: (home: string) => Promise<void>) =>
  withTestDir({ prefix: "config-paths-" }, run);
async function writeConfig(home: string, directory = ".openclaw", filename = "openclaw.json") {
  const dir = path.join(home, directory);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, filename), "{}");
  return dir;
}

describe("default state directory", () => {
  it("matches filesystem aliases of the default state directory", async () => {
    await withHome(async (root) => {
      const home = path.join(root, "home");
      const defaultStateDir = path.join(home, ".openclaw");
      const stateAlias = path.join(home, "state-alias");
      await fs.mkdir(defaultStateDir, { recursive: true });
      await fs.symlink(defaultStateDir, stateAlias, "dir");

      const env = { HOME: home, OPENCLAW_STATE_DIR: stateAlias };
      expect(isDefaultStateDir(env, () => home)).toBe(true);
    });
  });
});

describe("default install identity", () => {
  it.each<[NodeJS.ProcessEnv, boolean, boolean?]>([
    [{ HOME: accountHome }, true, true],
    [defaultPaths, true],
    [{ HOME: accountHome, OPENCLAW_STATE_DIR: "/tmp/copied-state" }, false],
    [{ HOME: accountHome, OPENCLAW_CONFIG_PATH: "/tmp/copied-openclaw.json" }, false],
    [{ HOME: "/tmp/copied-home" }, false],
    ...["HOME", "USERPROFILE"].flatMap((key): [NodeJS.ProcessEnv, boolean, boolean?][] => [
      [{ [key]: "/tmp/copied-home", OPENCLAW_HOME: accountHome }, false, false],
      [{ ...defaultPaths, HOME: undefined, [key]: "/tmp/copied-home" }, false],
    ]),
    [{ OPENCLAW_HOME: "/srv/openclaw" }, false],
    ...["default", "work"].map((profile): [NodeJS.ProcessEnv, boolean] => [
      {
        ...profileEnv("/srv/openclaw", profile),
        HOME: undefined,
        OPENCLAW_PROFILE: profile === "default" ? undefined : profile,
        OPENCLAW_HOME: "/srv/openclaw",
      },
      false,
    ]),
    [{ HOME: accountHome, OPENCLAW_HOME: "  undefined  " }, true, true],
    [profileEnv(accountHome, "work\\..\\escape"), false],
  ])("classifies installation %j as default=%s", (env, expected, scanExpected) => {
    expect(installIdentity(env)).toBe(expected);
    if (scanExpected !== undefined) {
      expect(allowsProcessHomeSessionScan(env, () => accountHome)).toBe(scanExpected);
    }
  });

  it("ignores legacy config discovery for the default profile", async () => {
    await withHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      await fs.mkdir(stateDir);
      await writeConfig(home, ".clawdbot", "clawdbot.json");
      const env = { HOME: home };
      const configPath = path.join(stateDir, "openclaw.json");
      expect(resolveConfigPathCandidate(env, () => home)).toBe(configPath);
      expect(resolveDefaultConfigCandidates(env, () => home)).toEqual([configPath]);
      expect(isDefaultInstallIdentity(env, () => home)).toBe(true);
    });
  });

  it.each([
    [profileEnv(accountHome), true, false],
    [{ ...profileEnv(accountHome), OPENCLAW_CONFIG_PATH: undefined }, true, false],
    [{ ...profileEnv(accountHome), OPENCLAW_STATE_DIR: "/other" }, false, false],
    [profileEnv(accountHome, "default"), true, true],
  ] as const)("classifies profile paths and session scan %j", (env, identity, scan) => {
    expect(installIdentity(env)).toBe(identity);
    expect(allowsProcessHomeSessionScan(env, () => accountHome)).toBe(scan);
  });

  it.each<[NodeJS.Platform, string, string]>([
    ["darwin", "OPENCLAW_LAUNCHD_LABEL", "ai.openclaw.gateway"],
    ["win32", "OPENCLAW_WINDOWS_TASK_NAME", "OpenClaw Gateway"],
  ])("rejects a named profile overriding native identity on %s", (platform, key, value) => {
    const env = { ...profileEnv(accountHome), [key]: value };
    expect(isDefaultInstallIdentity(env, () => accountHome, platform)).toBe(false);
  });

  it.each<[string, NodeJS.Platform, string | null]>([
    ["node", "darwin", "node"],
    ["node", "linux", null],
    ["Main", "darwin", "Main"],
    ["Main", "win32", "Main"],
    ["Main", "linux", null],
  ])("checks reserved profile %s on %s", (profile, platform, expected) => {
    expect(resolveNativeServiceProfileConflict({ OPENCLAW_PROFILE: profile }, platform)).toBe(
      expected,
    );
  });
});

it.each([
  { override: "/custom/oauth", expected: path.resolve("/custom/oauth") },
  { override: undefined, expected: path.join("/custom/state", "credentials") },
])("resolves OAuth directory override=$override", ({ override, expected }) => {
  const env = { OPENCLAW_STATE_DIR: "/custom/state", OPENCLAW_OAUTH_DIR: override };
  expect(resolveOAuthDir(env, "/custom/state")).toBe(expected);
  expect(resolveLegacyOAuthPath(env)).toBe(path.join(expected, "oauth.json"));
});

it.each<[string | undefined, number | undefined, string | undefined, number]>([
  ["19001", 19002, "work", 19001],
  [undefined, 19002, "work", 19002],
  [undefined, undefined, "p2380", 55636],
  ...["65536", "127.0.0.1:65536", "[::1]:65536", "::1"].map(
    (value): [string, number, undefined, number] => [value, 19003, undefined, 19003],
  ),
  ["127.0.0.1:not-a-port", undefined, undefined, DEFAULT_GATEWAY_PORT],
])("resolves env port %s, config %s, profile %s", (value, port, profile, expected) => {
  expect(
    resolveGatewayPort(
      { gateway: { port } },
      {
        OPENCLAW_GATEWAY_PORT: value,
        OPENCLAW_PROFILE: profile,
      },
    ),
  ).toBe(expected);
});

describe("state + config path candidates", () => {
  it("keeps an environment profile isolated when its config is missing", async () => {
    await withHome(async (home) => {
      await writeConfig(home);
      const env = { HOME: home, OPENCLAW_PROFILE: "work" };
      const stateDir = path.join(home, ".openclaw-work");
      const configPath = path.join(stateDir, "openclaw.json");

      expect(resolveStateDir(env)).toBe(stateDir);
      expect(resolveConfigPathCandidate(env)).toBe(configPath);
      expect(resolveDefaultConfigCandidates(env)).toEqual([configPath]);
      expect(isDefaultStateDir(env)).toBe(false);
      expect(allowsProcessHomeSessionScan(env, () => home)).toBe(false);
    });
  });

  it("pins a relative state-dir override before later resolution", () => {
    const env = {
      OPENCLAW_STATE_DIR: "relative-state",
      OPENCLAW_HOME: "/srv/openclaw-home",
    };

    normalizeStateDirEnv(env);
    const normalized = env.OPENCLAW_STATE_DIR;

    expect(normalized).toBe(path.resolve("relative-state"));
    expect(resolveStateDir(env, () => "/srv/other-home")).toBe(normalized);
  });

  it("re-pins exported runtime paths after startup environment selection", () => {
    const originalConfigPath = CONFIG_PATH;
    const originalNixMode = isNixMode;
    const originalStateDir = STATE_DIR;
    const selectedStateDir = path.resolve("/tmp/openclaw-selected-runtime-state");
    const selectedConfigPath = path.join(selectedStateDir, "selected.json");
    try {
      const pinned = pinRuntimePaths({
        OPENCLAW_CONFIG_PATH: selectedConfigPath,
        OPENCLAW_NIX_MODE: "1",
        OPENCLAW_STATE_DIR: selectedStateDir,
        OPENCLAW_TEST_FAST: "1",
      });

      expect(pinned).toEqual({
        configPath: selectedConfigPath,
        stateDir: selectedStateDir,
      });
      expect(CONFIG_PATH).toBe(selectedConfigPath);
      expect(isNixMode).toBe(true);
      expect(STATE_DIR).toBe(selectedStateDir);

      const home = path.resolve("/tmp/openclaw-profile-runtime-home");
      const stateDir = path.join(home, ".openclaw-work");
      expect(pinRuntimePaths({ HOME: home, OPENCLAW_PROFILE: "work" })).toEqual({
        configPath: path.join(stateDir, "openclaw.json"),
        stateDir,
      });
      expect(CONFIG_PATH).toBe(path.join(stateDir, "openclaw.json"));
      expect(STATE_DIR).toBe(stateDir);
    } finally {
      pinRuntimePaths({
        OPENCLAW_CONFIG_PATH: originalConfigPath,
        OPENCLAW_NIX_MODE: originalNixMode ? "1" : undefined,
        OPENCLAW_STATE_DIR: originalStateDir,
        OPENCLAW_TEST_FAST: "1",
      });
    }
  });
});

describe("resolveIncludeRoots", () => {
  const HOME = path.parse(process.cwd()).root + "fakehome";

  it("expands a leading tilde in each entry using the resolved home dir", () => {
    const env = { OPENCLAW_INCLUDE_ROOTS: "~/share/openclaw" };
    expect(resolveIncludeRoots(env, () => HOME)).toEqual([path.join(HOME, "share", "openclaw")]);
  });

  it("drops empty entries and preserves de-duplicated order for repeated roots", () => {
    const a = path.resolve(path.parse(process.cwd()).root, "shared", "a");
    const env = {
      OPENCLAW_INCLUDE_ROOTS: ["", a, "  ", a].join(path.delimiter),
    };
    expect(resolveIncludeRoots(env, () => HOME)).toEqual([a]);
  });
});
