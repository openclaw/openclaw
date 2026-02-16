import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createConfigIO,
  DEFAULT_GATEWAY_PORT,
  resolveConfigPathCandidate,
  resolveGatewayPort,
  resolveIsNixMode,
  resolveStateDir,
} from "./config.js";
import { withTempHome } from "./test-helpers.js";

function envWith(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  // Hermetic env: don't inherit process.env because other tests may mutate it.
  return { ...overrides };
}

function loadConfigForHome(home: string) {
  return createConfigIO({
    env: envWith({ SMART_AGENT_NEO_HOME: home }),
    homedir: () => home,
  }).loadConfig();
}

describe("Nix integration (U3, U5, U9)", () => {
  describe("U3: isNixMode env var detection", () => {
    it("isNixMode is false when SMART_AGENT_NEO_NIX_MODE is not set", () => {
      expect(resolveIsNixMode(envWith({ SMART_AGENT_NEO_NIX_MODE: undefined }))).toBe(false);
    });

    it("isNixMode is false when SMART_AGENT_NEO_NIX_MODE is empty", () => {
      expect(resolveIsNixMode(envWith({ SMART_AGENT_NEO_NIX_MODE: "" }))).toBe(false);
    });

    it("isNixMode is false when SMART_AGENT_NEO_NIX_MODE is not '1'", () => {
      expect(resolveIsNixMode(envWith({ SMART_AGENT_NEO_NIX_MODE: "true" }))).toBe(false);
    });

    it("isNixMode is true when SMART_AGENT_NEO_NIX_MODE=1", () => {
      expect(resolveIsNixMode(envWith({ SMART_AGENT_NEO_NIX_MODE: "1" }))).toBe(true);
    });
  });

  describe("U5: CONFIG_PATH and STATE_DIR env var overrides", () => {
    it("STATE_DIR defaults to ~/.smart-agent-neo when env not set", () => {
      expect(resolveStateDir(envWith({ SMART_AGENT_NEO_STATE_DIR: undefined }))).toMatch(/\.smart-agent-neo$/);
    });

    it("STATE_DIR respects SMART_AGENT_NEO_STATE_DIR override", () => {
      expect(resolveStateDir(envWith({ SMART_AGENT_NEO_STATE_DIR: "/custom/state/dir" }))).toBe(
        path.resolve("/custom/state/dir"),
      );
    });

    it("STATE_DIR respects SMART_AGENT_NEO_HOME when state override is unset", () => {
      const customHome = path.join(path.sep, "custom", "home");
      expect(
        resolveStateDir(envWith({ SMART_AGENT_NEO_HOME: customHome, SMART_AGENT_NEO_STATE_DIR: undefined })),
      ).toBe(path.join(path.resolve(customHome), ".smart-agent-neo"));
    });

    it("CONFIG_PATH defaults to SMART_AGENT_NEO_HOME/.smart-agent-neo/smart-agent-neo.json", () => {
      const customHome = path.join(path.sep, "custom", "home");
      expect(
        resolveConfigPathCandidate(
          envWith({
            SMART_AGENT_NEO_HOME: customHome,
            SMART_AGENT_NEO_CONFIG_PATH: undefined,
            SMART_AGENT_NEO_STATE_DIR: undefined,
          }),
        ),
      ).toBe(path.join(path.resolve(customHome), ".smart-agent-neo", "smart-agent-neo.json"));
    });

    it("CONFIG_PATH defaults to ~/.smart-agent-neo/smart-agent-neo.json when env not set", () => {
      expect(
        resolveConfigPathCandidate(
          envWith({ SMART_AGENT_NEO_CONFIG_PATH: undefined, SMART_AGENT_NEO_STATE_DIR: undefined }),
        ),
      ).toMatch(/\.smart-agent-neo[\\/]smart-agent-neo\.json$/);
    });

    it("CONFIG_PATH respects SMART_AGENT_NEO_CONFIG_PATH override", () => {
      expect(
        resolveConfigPathCandidate(
          envWith({ SMART_AGENT_NEO_CONFIG_PATH: "/nix/store/abc/smart-agent-neo.json" }),
        ),
      ).toBe(path.resolve("/nix/store/abc/smart-agent-neo.json"));
    });

    it("CONFIG_PATH expands ~ in SMART_AGENT_NEO_CONFIG_PATH override", async () => {
      await withTempHome(async (home) => {
        expect(
          resolveConfigPathCandidate(
            envWith({ SMART_AGENT_NEO_HOME: home, SMART_AGENT_NEO_CONFIG_PATH: "~/.smart-agent-neo/custom.json" }),
            () => home,
          ),
        ).toBe(path.join(home, ".smart-agent-neo", "custom.json"));
      });
    });

    it("CONFIG_PATH uses STATE_DIR when only state dir is overridden", () => {
      expect(resolveConfigPathCandidate(envWith({ SMART_AGENT_NEO_STATE_DIR: "/custom/state" }))).toBe(
        path.join(path.resolve("/custom/state"), "smart-agent-neo.json"),
      );
    });
  });

  describe("U5b: tilde expansion for config paths", () => {
    it("expands ~ in common path-ish config fields", async () => {
      await withTempHome(async (home) => {
        const configDir = path.join(home, ".smart-agent-neo");
        await fs.mkdir(configDir, { recursive: true });
        const pluginDir = path.join(home, "plugins", "demo-plugin");
        await fs.mkdir(pluginDir, { recursive: true });
        await fs.writeFile(
          path.join(pluginDir, "index.js"),
          'export default { id: "demo-plugin", register() {} };',
          "utf-8",
        );
        await fs.writeFile(
          path.join(pluginDir, "smart-agent-neo.plugin.json"),
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
          path.join(configDir, "smart-agent-neo.json"),
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
                    agentDir: "~/.smart-agent-neo/agents/main",
                    sandbox: { workspaceRoot: "~/sandbox-root" },
                  },
                ],
              },
              channels: {
                whatsapp: {
                  accounts: {
                    personal: {
                      authDir: "~/.smart-agent-neo/credentials/wa-personal",
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
          path.join(home, ".smart-agent-neo", "agents", "main"),
        );
        expect(cfg.agents?.list?.[0]?.sandbox?.workspaceRoot).toBe(path.join(home, "sandbox-root"));
        expect(cfg.channels?.whatsapp?.accounts?.personal?.authDir).toBe(
          path.join(home, ".smart-agent-neo", "credentials", "wa-personal"),
        );
      });
    });
  });

  describe("U6: gateway port resolution", () => {
    it("uses default when env and config are unset", () => {
      expect(resolveGatewayPort({}, envWith({ SMART_AGENT_NEO_GATEWAY_PORT: undefined }))).toBe(
        DEFAULT_GATEWAY_PORT,
      );
    });

    it("prefers SMART_AGENT_NEO_GATEWAY_PORT over config", () => {
      expect(
        resolveGatewayPort(
          { gateway: { port: 19002 } },
          envWith({ SMART_AGENT_NEO_GATEWAY_PORT: "19001" }),
        ),
      ).toBe(19001);
    });

    it("falls back to config when env is invalid", () => {
      expect(
        resolveGatewayPort(
          { gateway: { port: 19003 } },
          envWith({ SMART_AGENT_NEO_GATEWAY_PORT: "nope" }),
        ),
      ).toBe(19003);
    });
  });

  describe("U9: telegram.tokenFile schema validation", () => {
    it("accepts config with only botToken", async () => {
      await withTempHome(async (home) => {
        const configDir = path.join(home, ".smart-agent-neo");
        await fs.mkdir(configDir, { recursive: true });
        await fs.writeFile(
          path.join(configDir, "smart-agent-neo.json"),
          JSON.stringify({
            channels: { telegram: { botToken: "123:ABC" } },
          }),
          "utf-8",
        );

        const cfg = loadConfigForHome(home);
        expect(cfg.channels?.telegram?.botToken).toBe("123:ABC");
        expect(cfg.channels?.telegram?.tokenFile).toBeUndefined();
      });
    });

    it("accepts config with only tokenFile", async () => {
      await withTempHome(async (home) => {
        const configDir = path.join(home, ".smart-agent-neo");
        await fs.mkdir(configDir, { recursive: true });
        await fs.writeFile(
          path.join(configDir, "smart-agent-neo.json"),
          JSON.stringify({
            channels: { telegram: { tokenFile: "/run/agenix/telegram-token" } },
          }),
          "utf-8",
        );

        const cfg = loadConfigForHome(home);
        expect(cfg.channels?.telegram?.tokenFile).toBe("/run/agenix/telegram-token");
        expect(cfg.channels?.telegram?.botToken).toBeUndefined();
      });
    });

    it("accepts config with both botToken and tokenFile", async () => {
      await withTempHome(async (home) => {
        const configDir = path.join(home, ".smart-agent-neo");
        await fs.mkdir(configDir, { recursive: true });
        await fs.writeFile(
          path.join(configDir, "smart-agent-neo.json"),
          JSON.stringify({
            channels: {
              telegram: {
                botToken: "fallback:token",
                tokenFile: "/run/agenix/telegram-token",
              },
            },
          }),
          "utf-8",
        );

        const cfg = loadConfigForHome(home);
        expect(cfg.channels?.telegram?.botToken).toBe("fallback:token");
        expect(cfg.channels?.telegram?.tokenFile).toBe("/run/agenix/telegram-token");
      });
    });
  });
});
