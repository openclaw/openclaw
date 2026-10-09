// Covers config path resolution across env, home, and agent roots.
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

describe("default state directory", () => {
  it("matches filesystem aliases of the default state directory", async () => {
    await withTestDir({ prefix: "openclaw-default-state-" }, async (root) => {
      const home = path.join(root, "home");
      const defaultStateDir = path.join(home, ".openclaw");
      const stateAlias = path.join(home, "state-alias");
      await fs.mkdir(defaultStateDir, { recursive: true });
      await fs.symlink(defaultStateDir, stateAlias, "dir");

      expect(isDefaultStateDir({ HOME: home, OPENCLAW_STATE_DIR: stateAlias }, () => home)).toBe(
        true,
      );
    });
  });
});

describe("default install identity", () => {
  it("accepts default paths and equivalent explicit overrides", () => {
    const home = "/home/test";
    const stateDir = path.join(home, ".openclaw");
    const configPath = path.join(stateDir, "openclaw.json");

    expect(isDefaultInstallIdentity({ HOME: home }, () => home)).toBe(true);
    expect(allowsProcessHomeSessionScan({ HOME: home }, () => home)).toBe(true);
    expect(
      isDefaultInstallIdentity(
        { HOME: home, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath },
        () => home,
      ),
    ).toBe(true);
  });

  it("ignores legacy config discovery for the default profile", async () => {
    await withTestDir({ prefix: "openclaw-default-install-legacy-config-" }, async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const legacyStateDir = path.join(home, ".clawdbot");
      const legacyConfigPath = path.join(legacyStateDir, "clawdbot.json");
      await fs.mkdir(stateDir, { recursive: true });
      await fs.mkdir(legacyStateDir, { recursive: true });
      await fs.writeFile(legacyConfigPath, "{}");

      const env = { HOME: home };
      expect(resolveConfigPathCandidate(env, () => home)).toBe(
        path.join(stateDir, "openclaw.json"),
      );
      expect(isDefaultInstallIdentity(env, () => home)).toBe(true);
    });
  });

  it("rejects non-default state or config paths", () => {
    const home = "/home/test";

    expect(
      isDefaultInstallIdentity({ HOME: home, OPENCLAW_STATE_DIR: "/tmp/copied-state" }, () => home),
    ).toBe(false);
    expect(
      isDefaultInstallIdentity(
        { HOME: home, OPENCLAW_CONFIG_PATH: "/tmp/copied-openclaw.json" },
        () => home,
      ),
    ).toBe(false);
  });

  it("rejects process home overrides that relocate the implicit install", () => {
    const accountHome = "/home/test";
    const stateDir = path.join(accountHome, ".openclaw");

    expect(isDefaultInstallIdentity({ HOME: "/tmp/copied-home" }, () => accountHome)).toBe(false);
    for (const processHome of ["HOME", "USERPROFILE"]) {
      const env = { [processHome]: "/tmp/copied-home", OPENCLAW_HOME: accountHome };
      expect(isDefaultInstallIdentity(env, () => accountHome)).toBe(false);
      expect(allowsProcessHomeSessionScan(env, () => accountHome)).toBe(false);
    }
    expect(
      isDefaultInstallIdentity(
        {
          HOME: "/tmp/copied-home",
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
        },
        () => accountHome,
      ),
    ).toBe(false);
    expect(
      isDefaultInstallIdentity(
        {
          USERPROFILE: "/tmp/copied-home",
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
        },
        () => accountHome,
      ),
    ).toBe(false);
  });

  it("rejects installs relocated through OPENCLAW_HOME", () => {
    const accountHome = "/home/test";
    const installHome = "/srv/openclaw";
    const stateDir = path.join(installHome, ".openclaw");

    expect(isDefaultInstallIdentity({ OPENCLAW_HOME: installHome }, () => accountHome)).toBe(false);
    expect(
      isDefaultInstallIdentity(
        {
          OPENCLAW_HOME: installHome,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
        },
        () => accountHome,
      ),
    ).toBe(false);
    expect(
      isDefaultInstallIdentity(
        {
          OPENCLAW_HOME: installHome,
          OPENCLAW_PROFILE: "work",
          OPENCLAW_STATE_DIR: path.join(installHome, ".openclaw-work"),
          OPENCLAW_CONFIG_PATH: path.join(installHome, ".openclaw-work", "openclaw.json"),
        },
        () => accountHome,
      ),
    ).toBe(false);
  });

  it("keeps the default install identity for unset home literals", () => {
    const home = "/home/test";

    for (const literal of ["undefined", "null", "  undefined  "]) {
      const env = { HOME: home, OPENCLAW_HOME: literal };
      // Home resolution already reads these literals as unset, so the install
      // stays on the account home and the default state dir.
      expect(isDefaultInstallIdentity(env, () => home)).toBe(true);
      expect(allowsProcessHomeSessionScan(env, () => home)).toBe(true);
    }
  });

  it("accepts the canonical paths a named profile projects", async () => {
    await withTestDir({ prefix: "openclaw-profile-install-" }, async (home) => {
      const defaultStateDir = path.join(home, ".openclaw");
      const profileStateDir = path.join(home, ".openclaw-work");
      await fs.mkdir(defaultStateDir, { recursive: true });
      await fs.writeFile(path.join(defaultStateDir, "openclaw.json"), "{}");

      expect(
        isDefaultInstallIdentity(
          {
            HOME: home,
            OPENCLAW_PROFILE: "work",
            OPENCLAW_STATE_DIR: profileStateDir,
            OPENCLAW_CONFIG_PATH: path.join(profileStateDir, "openclaw.json"),
          },
          () => home,
        ),
      ).toBe(true);
      expect(
        allowsProcessHomeSessionScan(
          {
            HOME: home,
            OPENCLAW_PROFILE: "work",
            OPENCLAW_STATE_DIR: profileStateDir,
            OPENCLAW_CONFIG_PATH: path.join(profileStateDir, "openclaw.json"),
          },
          () => home,
        ),
      ).toBe(false);
      expect(
        isDefaultInstallIdentity(
          {
            HOME: home,
            OPENCLAW_PROFILE: "work",
            OPENCLAW_STATE_DIR: profileStateDir,
          },
          () => home,
        ),
      ).toBe(true);

      await fs.mkdir(profileStateDir, { recursive: true });
      await fs.writeFile(path.join(profileStateDir, "openclaw.json"), "{}");
      expect(
        isDefaultInstallIdentity(
          {
            HOME: home,
            OPENCLAW_PROFILE: "work",
            OPENCLAW_STATE_DIR: profileStateDir,
          },
          () => home,
        ),
      ).toBe(true);
      expect(
        isDefaultInstallIdentity(
          {
            HOME: home,
            OPENCLAW_PROFILE: "work",
            OPENCLAW_STATE_DIR: path.join(home, ".openclaw-other"),
          },
          () => home,
        ),
      ).toBe(false);
      expect(
        isDefaultInstallIdentity(
          {
            HOME: home,
            OPENCLAW_PROFILE: "default",
            OPENCLAW_STATE_DIR: defaultStateDir,
          },
          () => home,
        ),
      ).toBe(true);
    });
  });

  it.each([
    {
      platform: "darwin" as const,
      envKey: "OPENCLAW_LAUNCHD_LABEL",
      value: "ai.openclaw.gateway",
    },
    {
      platform: "win32" as const,
      envKey: "OPENCLAW_WINDOWS_TASK_NAME",
      value: "OpenClaw Gateway",
    },
  ])("rejects a named profile overriding $envKey on $platform", ({ platform, envKey, value }) => {
    const home = "/home/test";
    const stateDir = path.join(home, ".openclaw-work");
    expect(
      isDefaultInstallIdentity(
        {
          HOME: home,
          OPENCLAW_PROFILE: "work",
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
          [envKey]: value,
        },
        () => home,
        platform,
      ),
    ).toBe(false);
  });

  it.each(["work\\..\\escape"])(
    "rejects invalid profile %j even when its derived paths match",
    (profile) => {
      const home = "/home/test";
      const profileStateDir = path.join(home, `.openclaw-${profile}`);

      expect(
        isDefaultInstallIdentity(
          {
            HOME: home,
            OPENCLAW_PROFILE: profile,
            OPENCLAW_STATE_DIR: profileStateDir,
            OPENCLAW_CONFIG_PATH: path.join(profileStateDir, "openclaw.json"),
          },
          () => home,
        ),
      ).toBe(false);
    },
  );

  it.each(["node"])(
    "rejects macOS profile %j because its LaunchAgent label is reserved",
    (profile) => {
      expect(resolveNativeServiceProfileConflict({ OPENCLAW_PROFILE: profile }, "darwin")).toBe(
        profile,
      );
      expect(
        resolveNativeServiceProfileConflict({ OPENCLAW_PROFILE: profile }, "linux"),
      ).toBeNull();
    },
  );

  it.each(["Main"])(
    "rejects mixed-case native service profile %j on case-insensitive platforms",
    (profile) => {
      expect(resolveNativeServiceProfileConflict({ OPENCLAW_PROFILE: profile }, "darwin")).toBe(
        profile,
      );
      expect(resolveNativeServiceProfileConflict({ OPENCLAW_PROFILE: profile }, "win32")).toBe(
        profile,
      );
      expect(
        resolveNativeServiceProfileConflict({ OPENCLAW_PROFILE: profile }, "linux"),
      ).toBeNull();
    },
  );
});

describe("oauth paths", () => {
  it("prefers OPENCLAW_OAUTH_DIR over OPENCLAW_STATE_DIR", () => {
    const env = {
      OPENCLAW_OAUTH_DIR: "/custom/oauth",
      OPENCLAW_STATE_DIR: "/custom/state",
    };

    expect(resolveOAuthDir(env, "/custom/state")).toBe(path.resolve("/custom/oauth"));
    expect(resolveLegacyOAuthPath(env)).toBe(
      path.join(path.resolve("/custom/oauth"), "oauth.json"),
    );
  });

  it("derives oauth path from OPENCLAW_STATE_DIR when unset", () => {
    const env = {
      OPENCLAW_STATE_DIR: "/custom/state",
    };

    expect(resolveOAuthDir(env, "/custom/state")).toBe(path.join("/custom/state", "credentials"));
    expect(resolveLegacyOAuthPath(env)).toBe(
      path.join("/custom/state", "credentials", "oauth.json"),
    );
  });
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

  it.each([{ profile: "p2380", expected: 55636 }])(
    "derives the byte-exact profile port for $profile",
    ({ profile, expected }) => {
      const port = resolveGatewayPort({}, { OPENCLAW_PROFILE: profile });
      expect(port).toBe(expected);
      expect(port).toBeGreaterThanOrEqual(20000);
      expect(port).toBeLessThan(60000);
    },
  );

  it("falls back to config when env ports exceed TCP bounds", () => {
    expect(
      resolveGatewayPort({ gateway: { port: 19003 } }, { OPENCLAW_GATEWAY_PORT: "65536" }),
    ).toBe(19003);
    expect(
      resolveGatewayPort(
        { gateway: { port: 19004 } },
        { OPENCLAW_GATEWAY_PORT: "127.0.0.1:65536" },
      ),
    ).toBe(19004);
    expect(
      resolveGatewayPort({ gateway: { port: 19005 } }, { OPENCLAW_GATEWAY_PORT: "[::1]:65536" }),
    ).toBe(19005);
  });

  it("falls back when malformed IPv6 inputs do not provide an explicit port", () => {
    expect(resolveGatewayPort({ gateway: { port: 19003 } }, { OPENCLAW_GATEWAY_PORT: "::1" })).toBe(
      19003,
    );
    expect(resolveGatewayPort({}, { OPENCLAW_GATEWAY_PORT: "2001:db8::1" })).toBe(
      DEFAULT_GATEWAY_PORT,
    );
  });

  it("falls back to the default port when env is invalid and config is unset", () => {
    expect(resolveGatewayPort({}, { OPENCLAW_GATEWAY_PORT: "127.0.0.1:not-a-port" })).toBe(
      DEFAULT_GATEWAY_PORT,
    );
  });
});

describe("state + config path candidates", () => {
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
    const home = "/home/test";
    const resolvedHome = path.resolve(home);
    const candidates = resolveDefaultConfigCandidates({}, () => home);
    const expected = [path.join(resolvedHome, ".openclaw", "openclaw.json")];
    expect(candidates).toEqual(expected);
  });

  it.each([{ name: "canonical", resolve: resolveCanonicalConfigPath }])(
    "resolves explicit config selection in $name without filesystem discovery",
    ({ resolve }) => {
      const home = path.resolve("config-selection-home");
      const configPath = path.join(home, "selected.json");
      const exists = vi.spyOn(fsSync, "existsSync").mockReturnValue(false);
      try {
        expect(resolve({ HOME: home, OPENCLAW_CONFIG_PATH: configPath })).toBe(configPath);
        expect(exists).not.toHaveBeenCalled();
      } finally {
        exists.mockRestore();
      }
    },
  );
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
