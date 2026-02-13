import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createConfigIO } from "./io.js";
import { withTempHome } from "./test-helpers.js";

describe("config io write", () => {
  it("persists caller changes onto resolved config without leaking runtime defaults", async () => {
    await withTempHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        JSON.stringify({ gateway: { port: 18789 } }, null, 2),
        "utf-8",
      );

      const io = createConfigIO({
        env: {} as NodeJS.ProcessEnv,
        homedir: () => home,
      });

      const snapshot = await io.readConfigFileSnapshot();
      expect(snapshot.valid).toBe(true);

      const next = structuredClone(snapshot.config);
      next.gateway = {
        ...next.gateway,
        auth: { mode: "token" },
      };

      await io.writeConfigFile(next);

      const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as Record<
        string,
        unknown
      >;
      expect(persisted.gateway).toEqual({
        port: 18789,
        auth: { mode: "token" },
      });
      expect(persisted).not.toHaveProperty("agents.defaults");
      expect(persisted).not.toHaveProperty("messages.ackReaction");
      expect(persisted).not.toHaveProperty("sessions.persistence");
    });
  });

  it("preserves env var references when writing", async () => {
    await withTempHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        JSON.stringify(
          {
            agents: {
              defaults: {
                cliBackends: {
                  codex: {
                    command: "codex",
                    env: {
                      OPENAI_API_KEY: "${OPENAI_API_KEY}",
                    },
                  },
                },
              },
            },
            gateway: { port: 18789 },
          },
          null,
          2,
        ),
        "utf-8",
      );

      const io = createConfigIO({
        env: { OPENAI_API_KEY: "sk-secret" } as NodeJS.ProcessEnv,
        homedir: () => home,
      });

      const snapshot = await io.readConfigFileSnapshot();
      expect(snapshot.valid).toBe(true);

      const next = structuredClone(snapshot.config);
      next.gateway = {
        ...next.gateway,
        auth: { mode: "token" },
      };

      await io.writeConfigFile(next);

      const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
        agents: { defaults: { cliBackends: { codex: { env: { OPENAI_API_KEY: string } } } } };
        gateway: { port: number; auth: { mode: string } };
      };
      expect(persisted.agents.defaults.cliBackends.codex.env.OPENAI_API_KEY).toBe(
        "${OPENAI_API_KEY}",
      );
      expect(persisted.gateway).toEqual({
        port: 18789,
        auth: { mode: "token" },
      });
    });
  });

  it("keeps env refs in arrays when appending entries", async () => {
    await withTempHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        JSON.stringify(
          {
            agents: {
              defaults: {
                cliBackends: {
                  codex: {
                    command: "codex",
                    args: ["${DISCORD_USER_ID}", "123"],
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

      const io = createConfigIO({
        env: { DISCORD_USER_ID: "999" } as NodeJS.ProcessEnv,
        homedir: () => home,
      });

      const snapshot = await io.readConfigFileSnapshot();
      expect(snapshot.valid).toBe(true);

      const next = structuredClone(snapshot.config);
      const codexBackend = next.agents?.defaults?.cliBackends?.codex;
      const args = Array.isArray(codexBackend?.args) ? codexBackend?.args : [];
      next.agents = {
        ...next.agents,
        defaults: {
          ...next.agents?.defaults,
          cliBackends: {
            ...next.agents?.defaults?.cliBackends,
            codex: {
              ...codexBackend,
              command: typeof codexBackend?.command === "string" ? codexBackend.command : "codex",
              args: [...args, "456"],
            },
          },
        },
      };

      await io.writeConfigFile(next);

      const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
        agents: {
          defaults: {
            cliBackends: {
              codex: {
                args: string[];
              };
            };
          };
        };
      };
      expect(persisted.agents.defaults.cliBackends.codex.args).toEqual([
        "${DISCORD_USER_ID}",
        "123",
        "456",
      ]);
    });
  });
});
