import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveProviderAuths } from "./provider-usage.auth.js";

describe("resolveProviderAuths key normalization", () => {
  let suiteRoot = "";
  let suiteCase = 0;

  beforeAll(async () => {
    suiteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-provider-auth-suite-"));
  });

  afterAll(async () => {
    await fs.rm(suiteRoot, { recursive: true, force: true });
    suiteRoot = "";
    suiteCase = 0;
  });

  async function withSuiteHome<T>(
    fn: (home: string) => Promise<T>,
    env: Record<string, string | undefined>,
  ): Promise<T> {
    const base = path.join(suiteRoot, `case-${++suiteCase}`);
    await fs.mkdir(base, { recursive: true });
    await fs.mkdir(path.join(base, ".openclaw", "agents", "main", "sessions"), { recursive: true });

    const keysToRestore = new Set<string>([
      "HOME",
      "USERPROFILE",
      "HOMEDRIVE",
      "HOMEPATH",
      "OPENCLAW_HOME",
      "OPENCLAW_STATE_DIR",
      ...Object.keys(env),
    ]);
    const snapshot: Record<string, string | undefined> = {};
    for (const key of keysToRestore) {
      snapshot[key] = process.env[key];
    }

    process.env.HOME = base;
    process.env.USERPROFILE = base;
    delete process.env.OPENCLAW_HOME;
    process.env.OPENCLAW_STATE_DIR = path.join(base, ".openclaw");
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    try {
      return await fn(base);
    } finally {
      for (const [key, value] of Object.entries(snapshot)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  }

  async function writeAuthProfiles(home: string, profiles: Record<string, unknown>) {
    const agentDir = path.join(home, ".openclaw", "agents", "main", "agent");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(
      path.join(agentDir, "auth-profiles.json"),
      `${JSON.stringify({ version: 1, profiles }, null, 2)}\n`,
      "utf8",
    );
  }

  it("strips embedded CR/LF from env keys", async () => {
    await withSuiteHome(
      async () => {
        const auths = await resolveProviderAuths({
          providers: ["zai", "minimax", "xiaomi"],
        });
        expect(auths).toEqual([
          { provider: "zai", token: "zai-key" },
          { provider: "minimax", token: "minimax-key" },
          { provider: "xiaomi", token: "xiaomi-key" },
        ]);
      },
      {
        ZAI_API_KEY: "zai-\r\nkey",
        MINIMAX_API_KEY: "minimax-\r\nkey",
        XIAOMI_API_KEY: "xiaomi-\r\nkey",
      },
    );
  });

  it("strips embedded CR/LF from stored auth profiles (token + api_key)", async () => {
    await withSuiteHome(
      async (home) => {
        await writeAuthProfiles(home, {
          "minimax:default": { type: "token", provider: "minimax", token: "mini-\r\nmax" },
          "xiaomi:default": { type: "api_key", provider: "xiaomi", key: "xiao-\r\nmi" },
        });

        const auths = await resolveProviderAuths({
          providers: ["minimax", "xiaomi"],
        });
        expect(auths).toEqual([
          { provider: "minimax", token: "mini-max" },
          { provider: "xiaomi", token: "xiao-mi" },
        ]);
      },
      {
        MINIMAX_API_KEY: undefined,
        MINIMAX_CODE_PLAN_KEY: undefined,
        XIAOMI_API_KEY: undefined,
      },
    );
  });

  it("returns injected auth values unchanged", async () => {
    const auths = await resolveProviderAuths({
      providers: ["anthropic"],
      auth: [{ provider: "anthropic", token: "token-1", accountId: "acc-1" }],
    });
    expect(auths).toEqual([{ provider: "anthropic", token: "token-1", accountId: "acc-1" }]);
  });

  it("accepts z-ai env alias and normalizes embedded CR/LF", async () => {
    await withSuiteHome(
      async () => {
        const auths = await resolveProviderAuths({
          providers: ["zai"],
        });
        expect(auths).toEqual([{ provider: "zai", token: "zai-key" }]);
      },
      {
        ZAI_API_KEY: undefined,
        Z_AI_API_KEY: "zai-\r\nkey",
      },
    );
  });

  it("falls back to legacy .pi auth file for zai keys", async () => {
    await withSuiteHome(
      async (home) => {
        const legacyDir = path.join(home, ".pi", "agent");
        await fs.mkdir(legacyDir, { recursive: true });
        await fs.writeFile(
          path.join(legacyDir, "auth.json"),
          `${JSON.stringify({ "z-ai": { access: "legacy-zai-key" } }, null, 2)}\n`,
          "utf8",
        );

        const auths = await resolveProviderAuths({
          providers: ["zai"],
        });
        expect(auths).toEqual([{ provider: "zai", token: "legacy-zai-key" }]);
      },
      {
        ZAI_API_KEY: undefined,
        Z_AI_API_KEY: undefined,
      },
    );
  });

  it("extracts google oauth token from JSON payload in token profiles", async () => {
    await withSuiteHome(async (home) => {
      await writeAuthProfiles(home, {
        "google-gemini-cli:default": {
          type: "token",
          provider: "google-gemini-cli",
          token: '{"token":"google-oauth-token"}',
        },
      });

      const auths = await resolveProviderAuths({
        providers: ["google-gemini-cli"],
      });
      expect(auths).toEqual([{ provider: "google-gemini-cli", token: "google-oauth-token" }]);
    }, {});
  });
});
