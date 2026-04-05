import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createConfigIO,
  DEFAULT_GATEWAY_PORT,
  resolveConfigPathCandidate,
  resolveGatewayPort,
  resolveIsNixMode,
  resolveStateDir,
} from "./config.js";
import { withTempHome, withTempHomeConfig } from "./test-helpers.js";

vi.unmock("../version.js");

function envWith(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  // Hermetic env: don't inherit process.env because other tests may mutate it.
  return { ...overrides };
}

function loadConfigForHome(home: string) {
  return createConfigIO({
    env: envWith({ MULLUSI_HOME: home }),
    homedir: () => home,
  }).loadConfig();
}

async function withLoadedConfigForHome(
  config: unknown,
  run: (cfg: ReturnType<typeof loadConfigForHome>) => Promise<void> | void,
) {
  await withTempHomeConfig(config, async ({ home }) => {
    const cfg = loadConfigForHome(home);
    await run(cfg);
  });
}

describe("Nix integration (U3, U5, U9)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("U3: isNixMode env var detection", () => {
    it("isNixMode is false when MULLUSI_NIX_MODE is not set", () => {
      expect(resolveIsNixMode(envWith({ MULLUSI_NIX_MODE: undefined }))).toBe(false);
    });

    it("isNixMode is false when MULLUSI_NIX_MODE is empty", () => {
      expect(resolveIsNixMode(envWith({ MULLUSI_NIX_MODE: "" }))).toBe(false);
    });

    it("isNixMode is false when MULLUSI_NIX_MODE is not '1'", () => {
      expect(resolveIsNixMode(envWith({ MULLUSI_NIX_MODE: "true" }))).toBe(false);
    });

    it("isNixMode is true when MULLUSI_NIX_MODE=1", () => {
      expect(resolveIsNixMode(envWith({ MULLUSI_NIX_MODE: "1" }))).toBe(true);
    });
  });

  describe("U5: CONFIG_PATH and STATE_DIR env var overrides", () => {
    it("STATE_DIR defaults to ~/.mullusi when env not set", () => {
      expect(resolveStateDir(envWith({ MULLUSI_STATE_DIR: undefined }))).toMatch(/\.mullusi$/);
    });

    it("STATE_DIR respects MULLUSI_STATE_DIR override", () => {
      expect(resolveStateDir(envWith({ MULLUSI_STATE_DIR: "/custom/state/dir" }))).toBe(
        path.resolve("/custom/state/dir"),
      );
    });

    it("STATE_DIR respects MULLUSI_HOME when state override is unset", () => {
      const customHome = path.join(path.sep, "custom", "home");
      expect(
        resolveStateDir(envWith({ MULLUSI_HOME: customHome, MULLUSI_STATE_DIR: undefined })),
      ).toBe(path.join(path.resolve(customHome), ".mullusi"));
    });

    it("CONFIG_PATH defaults to MULLUSI_HOME/.mullusi/mullusi.json", () => {
      const customHome = path.join(path.sep, "custom", "home");
      expect(
        resolveConfigPathCandidate(
          envWith({
            MULLUSI_HOME: customHome,
            MULLUSI_CONFIG_PATH: undefined,
            MULLUSI_STATE_DIR: undefined,
          }),
        ),
      ).toBe(path.join(path.resolve(customHome), ".mullusi", "mullusi.json"));
    });

    it("CONFIG_PATH defaults to ~/.mullusi/mullusi.json when env not set", () => {
      expect(
        resolveConfigPathCandidate(
          envWith({ MULLUSI_CONFIG_PATH: undefined, MULLUSI_STATE_DIR: undefined }),
        ),
      ).toMatch(/\.mullusi[\\/]mullusi\.json$/);
    });

    it("CONFIG_PATH respects MULLUSI_CONFIG_PATH override", () => {
      expect(
        resolveConfigPathCandidate(
          envWith({ MULLUSI_CONFIG_PATH: "/nix/store/abc/mullusi.json" }),
        ),
      ).toBe(path.resolve("/nix/store/abc/mullusi.json"));
    });

    it("CONFIG_PATH expands ~ in MULLUSI_CONFIG_PATH override", async () => {
      await withTempHome(async (home) => {
        expect(
          resolveConfigPathCandidate(
            envWith({ MULLUSI_HOME: home, MULLUSI_CONFIG_PATH: "~/.mullusi/custom.json" }),
            () => home,
          ),
        ).toBe(path.join(home, ".mullusi", "custom.json"));
      });
    });

    it("CONFIG_PATH uses STATE_DIR when only state dir is overridden", () => {
      expect(
        resolveConfigPathCandidate(
          envWith({ MULLUSI_STATE_DIR: "/custom/state", MULLUSI_TEST_FAST: "1" }),
          () => path.join(path.sep, "tmp", "mullusi-config-home"),
        ),
      ).toBe(path.join(path.resolve("/custom/state"), "mullusi.json"));
    });
  });

  describe("U5b: tilde expansion for config paths", () => {
    it("expands ~ in common path-ish config fields", async () => {
      await withTempHome(async (home) => {
        const configDir = path.join(home, ".mullusi");
        await fs.mkdir(configDir, { recursive: true });
        const pluginDir = path.join(home, "plugins", "demo-plugin");
        await fs.mkdir(pluginDir, { recursive: true });
        await fs.writeFile(
          path.join(pluginDir, "index.js"),
          'export default { id: "demo-plugin", register() {} };',
          "utf-8",
        );
        await fs.writeFile(
          path.join(pluginDir, "mullusi.plugin.json"),
          JSON.stringify(
            {
              id: "demo-plugin",
              configSchema: { type: "object", additionalProperties: false, properties: {} },
            },
            null,
            2,
          ),
          "utf-8",
        );
        await fs.writeFile(
          path.join(configDir, "mullusi.json"),
          JSON.stringify(
            {
              plugins: {
                load: {
                  paths: ["~/plugins/demo-plugin"],
                },
              },
              agents: {
                defaults: { workspace: "~/ws-default" },
                list: [
                  {
                    id: "main",
                    workspace: "~/ws-agent",
                    agentDir: "~/.mullusi/agents/main",
                    sandbox: { workspaceRoot: "~/sandbox-root" },
                  },
                ],
              },
              channels: {
                whatsapp: {
                  accounts: {
                    personal: {
                      authDir: "~/.mullusi/credentials/wa-personal",
                    },
                  },
                },
              },
            },
            null,
            2,
          ),
          "utf-8",
        );

        const cfg = loadConfigForHome(home);

        expect(cfg.plugins?.load?.paths?.[0]).toBe(path.join(home, "plugins", "demo-plugin"));
        expect(cfg.agents?.defaults?.workspace).toBe(path.join(home, "ws-default"));
        expect(cfg.agents?.list?.[0]?.workspace).toBe(path.join(home, "ws-agent"));
        expect(cfg.agents?.list?.[0]?.agentDir).toBe(
          path.join(home, ".mullusi", "agents", "main"),
        );
        expect(cfg.agents?.list?.[0]?.sandbox?.workspaceRoot).toBe(path.join(home, "sandbox-root"));
        expect(cfg.channels?.whatsapp?.accounts?.personal?.authDir).toBe(
          path.join(home, ".mullusi", "credentials", "wa-personal"),
        );
      });
    });
  });

  describe("U6: gateway port resolution", () => {
    it("uses default when env and config are unset", () => {
      expect(resolveGatewayPort({}, envWith({ MULLUSI_GATEWAY_PORT: undefined }))).toBe(
        DEFAULT_GATEWAY_PORT,
      );
    });

    it("prefers MULLUSI_GATEWAY_PORT over config", () => {
      expect(
        resolveGatewayPort(
          { gateway: { port: 19002 } },
          envWith({ MULLUSI_GATEWAY_PORT: "19001" }),
        ),
      ).toBe(19001);
    });

    it("falls back to config when env is invalid", () => {
      expect(
        resolveGatewayPort(
          { gateway: { port: 19003 } },
          envWith({ MULLUSI_GATEWAY_PORT: "nope" }),
        ),
      ).toBe(19003);
    });
  });

  describe("U9: telegram.tokenFile schema validation", () => {
    it("accepts config with only botToken", async () => {
      await withLoadedConfigForHome(
        {
          channels: { telegram: { botToken: "123:ABC" } },
        },
        async (cfg) => {
          expect(cfg.channels?.telegram?.botToken).toBe("123:ABC");
          expect(cfg.channels?.telegram?.tokenFile).toBeUndefined();
        },
      );
    });

    it("accepts config with only tokenFile", async () => {
      await withLoadedConfigForHome(
        {
          channels: { telegram: { tokenFile: "/run/agenix/telegram-token" } },
        },
        async (cfg) => {
          expect(cfg.channels?.telegram?.tokenFile).toBe("/run/agenix/telegram-token");
          expect(cfg.channels?.telegram?.botToken).toBeUndefined();
        },
      );
    });

    it("accepts config with both botToken and tokenFile", async () => {
      await withLoadedConfigForHome(
        {
          channels: {
            telegram: {
              botToken: "fallback:token",
              tokenFile: "/run/agenix/telegram-token",
            },
          },
        },
        async (cfg) => {
          expect(cfg.channels?.telegram?.botToken).toBe("fallback:token");
          expect(cfg.channels?.telegram?.tokenFile).toBe("/run/agenix/telegram-token");
        },
      );
    });
  });
});
