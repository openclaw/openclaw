import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
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
  resolveCanonicalConfigPath,
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

const port = (value: string, fallback = 19003) =>
  resolveGatewayPort({ gateway: { port: fallback } }, { OPENCLAW_GATEWAY_PORT: value });
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
    ...["undefined", "null", "  undefined  "].map(
      (literal): [NodeJS.ProcessEnv, boolean, boolean] => [
        { HOME: accountHome, OPENCLAW_HOME: literal },
        true,
        true,
      ],
    ),
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
      expect(resolveConfigPathCandidate(env, () => home)).toBe(
        path.join(stateDir, "openclaw.json"),
      );
      expect(isDefaultInstallIdentity(env, () => home)).toBe(true);
    });
  });

  it("accepts the canonical paths a named profile projects", async () => {
    await withHome(async (home) => {
      const defaultStateDir = await writeConfig(home);
      const env = profileEnv(home);

      expect(installIdentity(env, home)).toBe(true);
      expect(allowsProcessHomeSessionScan(env, () => home)).toBe(false);
      delete env.OPENCLAW_CONFIG_PATH;
      expect(installIdentity(env, home)).toBe(true);

      await writeConfig(home, ".openclaw-work");
      expect(installIdentity(env, home)).toBe(true);
      expect(
        installIdentity({ ...env, OPENCLAW_STATE_DIR: path.join(home, ".openclaw-other") }, home),
      ).toBe(false);
      expect(
        installIdentity(
          { HOME: home, OPENCLAW_PROFILE: "default", OPENCLAW_STATE_DIR: defaultStateDir },
          home,
        ),
      ).toBe(true);
    });
  });

  it.each<[NodeJS.Platform, string, string]>([
    ["darwin", "OPENCLAW_LAUNCHD_LABEL", "ai.openclaw.gateway"],
    ["win32", "OPENCLAW_WINDOWS_TASK_NAME", "OpenClaw Gateway"],
  ])("rejects a named profile overriding native identity on %s", (platform, key, value) => {
    const env = { ...profileEnv(accountHome), [key]: value };
    expect(isDefaultInstallIdentity(env, () => accountHome, platform)).toBe(false);
  });

  it("rejects macOS profile node because its LaunchAgent label is reserved", () => {
    const env = { OPENCLAW_PROFILE: "node" };
    expect(resolveNativeServiceProfileConflict(env, "darwin")).toBe("node");
    expect(resolveNativeServiceProfileConflict(env, "linux")).toBeNull();
  });

  it("rejects mixed-case native service profiles on case-insensitive platforms", () => {
    const env = { OPENCLAW_PROFILE: "Main" };
    expect(resolveNativeServiceProfileConflict(env, "darwin")).toBe("Main");
    expect(resolveNativeServiceProfileConflict(env, "win32")).toBe("Main");
    expect(resolveNativeServiceProfileConflict(env, "linux")).toBeNull();
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

describe("gateway port resolution", () => {
  it("prefers numeric env values over config", () => {
    expect(
      resolveGatewayPort(
        { gateway: { port: 19002 } },
        { OPENCLAW_GATEWAY_PORT: "19001", OPENCLAW_PROFILE: "work" },
      ),
    ).toBe(19001);
    expect(resolveGatewayPort({ gateway: { port: 19002 } }, { OPENCLAW_PROFILE: "work" })).toBe(
      19002,
    );
  });

  it("derives the byte-exact profile port for p2380", () => {
    expect(resolveGatewayPort({}, { OPENCLAW_PROFILE: "p2380" })).toBe(55636);
  });

  it.each(["65536", "127.0.0.1:65536", "[::1]:65536", "::1"])(
    "falls back to config for invalid env port %s",
    (value) => {
      expect(port(value)).toBe(19003);
    },
  );
  it.each(["2001:db8::1", "127.0.0.1:not-a-port"])("uses the default for %s", (value) => {
    expect(resolveGatewayPort({}, { OPENCLAW_GATEWAY_PORT: value })).toBe(DEFAULT_GATEWAY_PORT);
  });
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

  it("orders default config candidates in a stable order", () => {
    expect(resolveDefaultConfigCandidates({}, () => accountHome)).toEqual([
      path.join(path.resolve(accountHome), ".openclaw", "openclaw.json"),
    ]);
  });

  it("resolves explicit canonical config selection without filesystem discovery", () => {
    const home = path.resolve("config-selection-home");
    const configPath = path.join(home, "selected.json");
    const exists = vi.spyOn(fsSync, "existsSync").mockReturnValue(false);
    try {
      expect(resolveCanonicalConfigPath({ HOME: home, OPENCLAW_CONFIG_PATH: configPath })).toBe(
        configPath,
      );
      expect(exists).not.toHaveBeenCalled();
    } finally {
      exists.mockRestore();
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
