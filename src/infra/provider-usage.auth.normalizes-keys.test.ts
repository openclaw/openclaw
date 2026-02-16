import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveProviderAuths } from "./provider-usage.auth.js";

describe("resolveProviderAuths key normalization", () => {
  let suiteRoot = "";
  let suiteCase = 0;

  beforeAll(async () => {
    suiteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "smart-agent-neo-provider-auth-suite-"));
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
    await fs.mkdir(path.join(base, ".smart-agent-neo", "agents", "main", "sessions"), { recursive: true });

    const keysToRestore = new Set<string>([
      "HOME",
      "USERPROFILE",
      "HOMEDRIVE",
      "HOMEPATH",
      "SMART_AGENT_NEO_HOME",
      "SMART_AGENT_NEO_STATE_DIR",
      ...Object.keys(env),
    ]);
    const snapshot: Record<string, string | undefined> = {};
    for (const key of keysToRestore) {
      snapshot[key] = process.env[key];
    }

    process.env.HOME = base;
    process.env.USERPROFILE = base;
    delete process.env.SMART_AGENT_NEO_HOME;
    process.env.SMART_AGENT_NEO_STATE_DIR = path.join(base, ".smart-agent-neo");
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
        const agentDir = path.join(home, ".smart-agent-neo", "agents", "main", "agent");
        await fs.mkdir(agentDir, { recursive: true });
        await fs.writeFile(
          path.join(agentDir, "auth-profiles.json"),
          `${JSON.stringify(
            {
              version: 1,
              profiles: {
                "minimax:default": { type: "token", provider: "minimax", token: "mini-\r\nmax" },
                "xiaomi:default": { type: "api_key", provider: "xiaomi", key: "xiao-\r\nmi" },
              },
            },
            null,
            2,
          )}\n`,
          "utf8",
        );

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
});
