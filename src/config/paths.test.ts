import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  DEFAULT_GATEWAY_PORT,
  resolveDefaultConfigCandidates,
  resolveConfigPathCandidate,
  resolveConfigPath,
  resolveGatewayPort,
  resolveOAuthDir,
  resolveOAuthPath,
  resolveStateDir,
} from "./paths.js";

function envWith(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return { ...overrides };
}

describe("oauth paths", () => {
  it("prefers MULLUSI_OAUTH_DIR over MULLUSI_STATE_DIR", () => {
    const env = {
      MULLUSI_OAUTH_DIR: "/custom/oauth",
      MULLUSI_STATE_DIR: "/custom/state",
    } as NodeJS.ProcessEnv;

    expect(resolveOAuthDir(env, "/custom/state")).toBe(path.resolve("/custom/oauth"));
    expect(resolveOAuthPath(env, "/custom/state")).toBe(
      path.join(path.resolve("/custom/oauth"), "oauth.json"),
    );
  });

  it("derives oauth path from MULLUSI_STATE_DIR when unset", () => {
    const env = {
      MULLUSI_STATE_DIR: "/custom/state",
    } as NodeJS.ProcessEnv;

    expect(resolveOAuthDir(env, "/custom/state")).toBe(path.join("/custom/state", "credentials"));
    expect(resolveOAuthPath(env, "/custom/state")).toBe(
      path.join("/custom/state", "credentials", "oauth.json"),
    );
  });
});

describe("gateway port resolution", () => {
  it("prefers numeric env values over config", () => {
    expect(
      resolveGatewayPort({ gateway: { port: 19002 } }, envWith({ MULLUSI_GATEWAY_PORT: "19001" })),
    ).toBe(19001);
  });

  it("accepts Compose-style IPv4 host publish values from env", () => {
    expect(
      resolveGatewayPort(
        { gateway: { port: 19002 } },
        envWith({ MULLUSI_GATEWAY_PORT: "127.0.0.1:18790" }),
      ),
    ).toBe(18790);
  });

  it("accepts Compose-style IPv6 host publish values from env", () => {
    expect(
      resolveGatewayPort(
        { gateway: { port: 19002 } },
        envWith({ MULLUSI_GATEWAY_PORT: "[::1]:28789" }),
      ),
    ).toBe(28789);
  });

  it("ignores the legacy env name and falls back to config", () => {
    expect(
      resolveGatewayPort(
        { gateway: { port: 19002 } },
        envWith({ CLAWDBOT_GATEWAY_PORT: "127.0.0.1:18790" }),
      ),
    ).toBe(19002);
  });

  it("falls back to config when the Compose-style suffix is invalid", () => {
    expect(
      resolveGatewayPort(
        { gateway: { port: 19003 } },
        envWith({ MULLUSI_GATEWAY_PORT: "127.0.0.1:not-a-port" }),
      ),
    ).toBe(19003);
  });

  it("falls back when malformed IPv6 inputs do not provide an explicit port", () => {
    expect(
      resolveGatewayPort({ gateway: { port: 19003 } }, envWith({ MULLUSI_GATEWAY_PORT: "::1" })),
    ).toBe(19003);
    expect(resolveGatewayPort({}, envWith({ MULLUSI_GATEWAY_PORT: "2001:db8::1" }))).toBe(
      DEFAULT_GATEWAY_PORT,
    );
  });

  it("falls back to the default port when env is invalid and config is unset", () => {
    expect(resolveGatewayPort({}, envWith({ MULLUSI_GATEWAY_PORT: "127.0.0.1:not-a-port" }))).toBe(
      DEFAULT_GATEWAY_PORT,
    );
  });
});

describe("state + config path candidates", () => {
  function expectMullusiHomeDefaults(env: NodeJS.ProcessEnv): void {
    const configuredHome = env.MULLUSI_HOME;
    if (!configuredHome) {
      throw new Error("MULLUSI_HOME must be set for this assertion helper");
    }
    const resolvedHome = path.resolve(configuredHome);
    expect(resolveStateDir(env)).toBe(path.join(resolvedHome, ".mullusi"));

    const candidates = resolveDefaultConfigCandidates(env);
    expect(candidates[0]).toBe(path.join(resolvedHome, ".mullusi", "mullusi.json"));
  }

  it("uses MULLUSI_STATE_DIR when set", () => {
    const env = {
      MULLUSI_STATE_DIR: "/new/state",
    } as NodeJS.ProcessEnv;

    expect(resolveStateDir(env, () => "/home/test")).toBe(path.resolve("/new/state"));
  });

  it("uses MULLUSI_HOME for default state/config locations", () => {
    const env = {
      MULLUSI_HOME: "/srv/mullusi-home",
    } as NodeJS.ProcessEnv;
    expectMullusiHomeDefaults(env);
  });

  it("prefers MULLUSI_HOME over HOME for default state/config locations", () => {
    const env = {
      MULLUSI_HOME: "/srv/mullusi-home",
      HOME: "/home/other",
    } as NodeJS.ProcessEnv;
    expectMullusiHomeDefaults(env);
  });

  it("orders default config candidates in a stable order", () => {
    const home = "/home/test";
    const resolvedHome = path.resolve(home);
    const candidates = resolveDefaultConfigCandidates({} as NodeJS.ProcessEnv, () => home);
    const expected = [
      path.join(resolvedHome, ".mullusi", "mullusi.json"),
      path.join(resolvedHome, ".mullusi", "mullusi.json"),
      path.join(resolvedHome, ".mullusi", "mullusi.json"),
      path.join(resolvedHome, ".mullusi", "mullusi.json"),
    ];
    expect(candidates).toEqual(expected);
  });

  it("prefers ~/.mullusi when it exists and legacy dir is missing", async () => {
    await withTempDir({ prefix: "mullusi-state-" }, async (root) => {
      const newDir = path.join(root, ".mullusi");
      await fs.mkdir(newDir, { recursive: true });
      const resolved = resolveStateDir({} as NodeJS.ProcessEnv, () => root);
      expect(resolved).toBe(newDir);
    });
  });

  it("falls back to existing legacy state dir when ~/.mullusi is missing", async () => {
    await withTempDir({ prefix: "mullusi-state-legacy-" }, async (root) => {
      const legacyDir = path.join(root, ".mullusi");
      await fs.mkdir(legacyDir, { recursive: true });
      const resolved = resolveStateDir({} as NodeJS.ProcessEnv, () => root);
      expect(resolved).toBe(legacyDir);
    });
  });

  it("CONFIG_PATH prefers existing config when present", async () => {
    await withTempDir({ prefix: "mullusi-config-" }, async (root) => {
      const legacyDir = path.join(root, ".mullusi");
      await fs.mkdir(legacyDir, { recursive: true });
      const legacyPath = path.join(legacyDir, "mullusi.json");
      await fs.writeFile(legacyPath, "{}", "utf-8");

      const resolved = resolveConfigPathCandidate({} as NodeJS.ProcessEnv, () => root);
      expect(resolved).toBe(legacyPath);
    });
  });

  it("respects state dir overrides when config is missing", async () => {
    await withTempDir({ prefix: "mullusi-config-override-" }, async (root) => {
      const legacyDir = path.join(root, ".mullusi");
      await fs.mkdir(legacyDir, { recursive: true });
      const legacyConfig = path.join(legacyDir, "mullusi.json");
      await fs.writeFile(legacyConfig, "{}", "utf-8");

      const overrideDir = path.join(root, "override");
      const env = { MULLUSI_STATE_DIR: overrideDir } as NodeJS.ProcessEnv;
      const resolved = resolveConfigPath(env, overrideDir, () => root);
      expect(resolved).toBe(path.join(overrideDir, "mullusi.json"));
    });
  });
});
