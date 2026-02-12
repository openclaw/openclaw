import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTempHome } from "../../test/helpers/temp-home.js";

describe("resolveProviderAuths key normalization", () => {
  it("strips embedded CR/LF from env keys", async () => {
    await withTempHome(
      async () => {
        vi.resetModules();
        const { resolveProviderAuths } = await import("./provider-usage.auth.js");

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
        env: {
          ZAI_API_KEY: "zai-\r\nkey",
          MINIMAX_API_KEY: "minimax-\r\nkey",
          XIAOMI_API_KEY: "xiaomi-\r\nkey",
        },
      },
    );
  });

  it("strips embedded CR/LF from stored auth profiles (token + api_key)", async () => {
    await withTempHome(
      async (home) => {
        const agentDir = path.join(home, ".openclaw", "agents", "main", "agent");
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

        vi.resetModules();
        const { resolveProviderAuths } = await import("./provider-usage.auth.js");

        const auths = await resolveProviderAuths({
          providers: ["minimax", "xiaomi"],
        });
        expect(auths).toEqual([
          { provider: "minimax", token: "mini-max" },
          { provider: "xiaomi", token: "xiao-mi" },
        ]);
      },
      {
        env: {
          MINIMAX_API_KEY: undefined,
          MINIMAX_CODE_PLAN_KEY: undefined,
          XIAOMI_API_KEY: undefined,
        },
      },
    );
  });
});
