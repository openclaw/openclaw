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

  async function writeConfigAndCreateIo(params: {
    home: string;
    initialConfig: Record<string, unknown>;
    env?: NodeJS.ProcessEnv;
    logger?: { warn: (msg: string) => void; error: (msg: string) => void };
  }) {
    const configPath = path.join(params.home, ".openclaw", "openclaw.json");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(params.initialConfig, null, 2), "utf-8");

    const io = createConfigIO({
      env: params.env ?? {},
      homedir: () => params.home,
      logger: params.logger ?? silentLogger,
    });
    const snapshot = await io.readConfigFileSnapshot();
    expect(snapshot.valid).toBe(true);
    return { configPath, io, snapshot };
  }

  async function writeTokenAuthAndReadConfig(params: {
    io: { writeConfigFile: (config: Record<string, unknown>) => Promise<void> };
    snapshot: { config: Record<string, unknown> };
    configPath: string;
  }) {
    const next = structuredClone(params.snapshot.config);
    const gateway =
      next.gateway && typeof next.gateway === "object"
        ? (next.gateway as Record<string, unknown>)
        : {};
    next.gateway = {
      ...gateway,
      auth: { mode: "token" },
    };
    await params.io.writeConfigFile(next);
    return JSON.parse(await fs.readFile(params.configPath, "utf-8")) as Record<string, unknown>;
  }

  async function writeGatewayPatchAndReadLastAuditEntry(params: {
    home: string;
    initialConfig: Record<string, unknown>;
    gatewayPatch: Record<string, unknown>;
    env?: NodeJS.ProcessEnv;
  }) {
    const { io, snapshot, configPath } = await writeConfigAndCreateIo({
      home: params.home,
      initialConfig: params.initialConfig,
      env: params.env,
      logger: {
        warn: vi.fn(),
        error: vi.fn(),
      },
    });
    const auditPath = path.join(params.home, ".openclaw", "logs", "config-audit.jsonl");
    const next = structuredClone(snapshot.config);
    const gateway =
      next.gateway && typeof next.gateway === "object"
        ? (next.gateway as Record<string, unknown>)
        : {};
    next.gateway = {
      ...gateway,
      ...params.gatewayPatch,
    };
    await io.writeConfigFile(next);
    const lines = (await fs.readFile(auditPath, "utf-8")).trim().split("\n").filter(Boolean);
    const last = JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown>;
    return { last, lines, configPath };
  }

  it("persists caller changes onto resolved config without leaking runtime defaults", async () => {
    await withTempHome("openclaw-config-io-", async (home) => {
      const { configPath, io, snapshot } = await writeConfigAndCreateIo({
        home,
        initialConfig: { gateway: { port: 18789 } },
      });
      const persisted = await writeTokenAuthAndReadConfig({ io, snapshot, configPath });
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
      const { configPath, io, snapshot } = await writeConfigAndCreateIo({
        home,
        env: { OPENAI_API_KEY: "sk-secret" } as NodeJS.ProcessEnv,
        initialConfig: {
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
      });
      const persisted = (await writeTokenAuthAndReadConfig({ io, snapshot, configPath })) as {
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

  it("does not reintroduce Slack/Discord legacy dm.policy defaults when writing", async () => {
    await withTempHome("openclaw-config-io-", async (home) => {
      const { configPath, io, snapshot } = await writeConfigAndCreateIo({
        home,
        initialConfig: {
          channels: {
            discord: {
              dmPolicy: "pairing",
              dm: { enabled: true, policy: "pairing" },
            },
            slack: {
              dmPolicy: "pairing",
              dm: { enabled: true, policy: "pairing" },
            },
          },
          gateway: { port: 18789 },
        },
      });

      const next = structuredClone(snapshot.config);
      // Simulate doctor removing legacy keys while keeping dm enabled.
      if (next.channels?.discord?.dm && typeof next.channels.discord.dm === "object") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper
        delete (next.channels.discord.dm as any).policy;
      }
      if (next.channels?.slack?.dm && typeof next.channels.slack.dm === "object") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper
        delete (next.channels.slack.dm as any).policy;
      }

      await io.writeConfigFile(next);

      const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
        channels?: {
          discord?: { dm?: Record<string, unknown>; dmPolicy?: unknown };
          slack?: { dm?: Record<string, unknown>; dmPolicy?: unknown };
        };
      };

      expect(persisted.channels?.discord?.dmPolicy).toBe("pairing");
      expect(persisted.channels?.discord?.dm).toEqual({ enabled: true });
      expect(persisted.channels?.slack?.dmPolicy).toBe("pairing");
      expect(persisted.channels?.slack?.dm).toEqual({ enabled: true });
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
      const warn = vi.fn();
      const { configPath, io, snapshot } = await writeConfigAndCreateIo({
        home,
        initialConfig: { gateway: { port: 18789 } },
        env: {} as NodeJS.ProcessEnv,
        logger: {
          warn: warn as (msg: string) => void,
          error: vi.fn() as (msg: string) => void,
        },
      });
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
      const { configPath, lines, last } = await writeGatewayPatchAndReadLastAuditEntry({
        home,
        initialConfig: { gateway: { port: 18789 } },
        gatewayPatch: { mode: "local" },
        env: {} as NodeJS.ProcessEnv,
      });
      expect(lines.length).toBeGreaterThan(0);
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
      const { last } = await writeGatewayPatchAndReadLastAuditEntry({
        home,
        initialConfig: { gateway: { mode: "local" } },
        gatewayPatch: { bind: "loopback" },
        env: {
          OPENCLAW_WATCH_MODE: "1",
          OPENCLAW_WATCH_SESSION: "watch-session-1",
          OPENCLAW_WATCH_COMMAND: "gateway --force",
        } as NodeJS.ProcessEnv,
      });
      expect(last.watchMode).toBe(true);
      expect(last.watchSession).toBe("watch-session-1");
      expect(last.watchCommand).toBe("gateway --force");
    });
  });

  it("blocks and rejects a write that reduces config size by more than 50%", async () => {
    await withTempHome("openclaw-config-io-", async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const rejectedPath = `${configPath}.rejected`;
      // Write a large initial config (>512 bytes) so the size-drop check triggers.
      // Use env.vars for bulk — these are valid schema fields.
      const bigConfig = {
        gateway: { mode: "local", port: 18789 },
        env: {
          vars: Object.fromEntries(
            Array.from({ length: 30 }, (_, i) => [`PADDING_VAR_${i}`, "x".repeat(20)]),
          ),
        },
      };
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, JSON.stringify(bigConfig, null, 2), "utf-8");

      const errorFn = vi.fn();
      const io = createConfigIO({
        env: {} as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: { warn: vi.fn(), error: errorFn },
      });

      const snapshot = await io.readConfigFileSnapshot();
      expect(snapshot.valid).toBe(true);

      // A tiny config — triggers the >50% size-drop safeguard.
      await expect(io.writeConfigFile({ gateway: { mode: "local" } })).rejects.toThrow(
        "Config write blocked",
      );

      // Original file must be untouched.
      const remaining = JSON.parse(await fs.readFile(configPath, "utf-8")) as Record<
        string,
        unknown
      >;
      expect((remaining as { gateway?: { port?: number } }).gateway?.port).toBe(18789);

      // Rejected payload must be saved for debugging.
      const rejectedExists = await fs
        .access(rejectedPath)
        .then(() => true)
        .catch(() => false);
      expect(rejectedExists).toBe(true);

      // Error must be logged.
      expect(errorFn).toHaveBeenCalledWith(expect.stringContaining("Config write blocked"));
    });
  });

  it("blocks and rejects a write that removes gateway.mode from an existing config", async () => {
    await withTempHome("openclaw-config-io-", async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const rejectedPath = `${configPath}.rejected`;
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        JSON.stringify({ gateway: { mode: "local", port: 18789 } }, null, 2),
        "utf-8",
      );

      const errorFn = vi.fn();
      const io = createConfigIO({
        env: {} as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: { warn: vi.fn(), error: errorFn },
      });

      const snapshot = await io.readConfigFileSnapshot();
      expect(snapshot.valid).toBe(true);

      // Strip gateway.mode — triggers the gateway-mode-removed safeguard.
      const next = structuredClone(snapshot.config);
      if (next.gateway) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper
        delete (next.gateway as any).mode;
      }

      await expect(io.writeConfigFile(next)).rejects.toThrow("Config write blocked");

      // Original file must be untouched.
      const remaining = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
        gateway?: { mode?: string };
      };
      expect(remaining.gateway?.mode).toBe("local");

      // Rejected payload saved.
      const rejectedExists = await fs
        .access(rejectedPath)
        .then(() => true)
        .catch(() => false);
      expect(rejectedExists).toBe(true);

      // Audit log must contain a "rejected" entry.
      const auditPath = path.join(home, ".openclaw", "logs", "config-audit.jsonl");
      const auditLines = (await fs.readFile(auditPath, "utf-8")).trim().split("\n").filter(Boolean);
      const last = JSON.parse(auditLines.at(-1) ?? "{}") as Record<string, unknown>;
      expect(last.result).toBe("rejected");
      expect(Array.isArray(last.suspicious) && (last.suspicious as string[]).length > 0).toBe(true);
    });
  });
});
