import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTempHome } from "./home-env.test-harness.js";
import { createConfigIO } from "./io.js";

describe("config io write", () => {
  const silentLogger = {
    warn: () => {},
    error: () => {},
  };

  it("persists caller changes onto resolved config without leaking runtime defaults", async () => {
    await withTempHome("openclaw-config-io-", async (home) => {
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
        logger: silentLogger,
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
    await withTempHome("openclaw-config-io-", async (home) => {
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
        logger: silentLogger,
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
    await withTempHome("openclaw-config-io-", async (home) => {
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
        logger: silentLogger,
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

  it("logs an overwrite audit entry when replacing an existing config file", async () => {
    await withTempHome("openclaw-config-io-", async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        JSON.stringify({ gateway: { port: 18789 } }, null, 2),
        "utf-8",
      );
      const warn = vi.fn();
      const io = createConfigIO({
        env: {} as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: {
          warn,
          error: vi.fn(),
        },
      });

      const snapshot = await io.readConfigFileSnapshot();
      expect(snapshot.valid).toBe(true);
      const next = structuredClone(snapshot.config);
      next.gateway = {
        ...next.gateway,
        auth: { mode: "token" },
      };

      await io.writeConfigFile(next);

      const overwriteLog = warn.mock.calls
        .map((call) => call[0])
        .find((entry) => typeof entry === "string" && entry.startsWith("Config overwrite:"));
      expect(typeof overwriteLog).toBe("string");
      expect(overwriteLog).toContain(configPath);
      expect(overwriteLog).toContain(`${configPath}.bak`);
      expect(overwriteLog).toContain("sha256");
    });
  });

  it("does not log an overwrite audit entry when creating config for the first time", async () => {
    await withTempHome("openclaw-config-io-", async (home) => {
      const warn = vi.fn();
      const io = createConfigIO({
        env: {} as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: {
          warn,
          error: vi.fn(),
        },
      });

      await io.writeConfigFile({
        gateway: { mode: "local" },
      });

      const overwriteLogs = warn.mock.calls.filter(
        (call) => typeof call[0] === "string" && call[0].startsWith("Config overwrite:"),
      );
      expect(overwriteLogs).toHaveLength(0);
    });
  });

  it("appends config write audit JSONL entries with forensic metadata", async () => {
    await withTempHome("openclaw-config-io-", async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const auditPath = path.join(home, ".openclaw", "logs", "config-audit.jsonl");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        JSON.stringify({ gateway: { port: 18789 } }, null, 2),
        "utf-8",
      );

      const io = createConfigIO({
        env: {} as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: {
          warn: vi.fn(),
          error: vi.fn(),
        },
      });

      const snapshot = await io.readConfigFileSnapshot();
      expect(snapshot.valid).toBe(true);

      const next = structuredClone(snapshot.config);
      next.gateway = {
        ...next.gateway,
        mode: "local",
      };

      await io.writeConfigFile(next);

      const lines = (await fs.readFile(auditPath, "utf-8")).trim().split("\n").filter(Boolean);
      expect(lines.length).toBeGreaterThan(0);
      const last = JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown>;
      expect(last.source).toBe("config-io");
      expect(last.event).toBe("config.write");
      expect(last.configPath).toBe(configPath);
      expect(last.existsBefore).toBe(true);
      expect(last.hasMetaAfter).toBe(true);
      expect(last.previousHash).toBeTypeOf("string");
      expect(last.nextHash).toBeTypeOf("string");
      expect(last.result === "rename" || last.result === "copy-fallback").toBe(true);
    });
  });

  it("records gateway watch session markers in config audit entries", async () => {
    await withTempHome("openclaw-config-io-", async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const auditPath = path.join(home, ".openclaw", "logs", "config-audit.jsonl");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        JSON.stringify({ gateway: { mode: "local" } }, null, 2),
        "utf-8",
      );

      const io = createConfigIO({
        env: {
          OPENCLAW_WATCH_MODE: "1",
          OPENCLAW_WATCH_SESSION: "watch-session-1",
          OPENCLAW_WATCH_COMMAND: "gateway --force",
        } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: {
          warn: vi.fn(),
          error: vi.fn(),
        },
      });

      const snapshot = await io.readConfigFileSnapshot();
      expect(snapshot.valid).toBe(true);
      const next = structuredClone(snapshot.config);
      next.gateway = {
        ...next.gateway,
        bind: "loopback",
      };

      await io.writeConfigFile(next);

      const lines = (await fs.readFile(auditPath, "utf-8")).trim().split("\n").filter(Boolean);
      const last = JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown>;
      expect(last.watchMode).toBe(true);
      expect(last.watchSession).toBe("watch-session-1");
      expect(last.watchCommand).toBe("gateway --force");
    });
  });
});
