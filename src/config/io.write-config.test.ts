import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PluginManifestRecord, PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { createConfigIO } from "./io.js";
import type { OpenClawConfig } from "./types.js";

// Mock the plugin manifest registry so we can register a fake channel whose
// AJV JSON Schema carries a `default` value.  This lets the #56772 regression
// test exercise the exact code path that caused the bug: AJV injecting
// defaults during the write-back validation pass.
const mockLoadPluginManifestRegistry = vi.hoisted(() =>
  vi.fn(
    (): PluginManifestRegistry => ({
      diagnostics: [],
      plugins: [],
    }),
  ),
);

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistry: mockLoadPluginManifestRegistry,
}));

describe("config io write", () => {
  const suiteRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-config-io-" });
  const silentLogger = {
    warn: () => {},
    error: () => {},
  };

  function createBlueBubblesManifestRecord(): PluginManifestRecord {
    return {
      id: "bluebubbles",
      origin: "bundled",
      channels: ["bluebubbles"],
      providers: [],
      skills: [],
      hooks: [],
      rootDir: "/virtual/plugins/bluebubbles",
      source: "/virtual/plugins/bluebubbles/openclaw.plugin.json",
      manifestPath: "/virtual/plugins/bluebubbles/openclaw.plugin.json",
      channelCatalogMeta: {
        id: "bluebubbles",
        label: "BlueBubbles",
        blurb: "BlueBubbles channel",
      },
      channelConfigs: {
        bluebubbles: {
          schema: {
            type: "object",
            properties: {
              enrichGroupParticipantsFromContacts: { type: "boolean", default: true },
              serverUrl: { type: "string" },
            },
            additionalProperties: true,
          },
          uiHints: {},
        },
      },
    };
  }

  async function withSuiteHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
    const home = await suiteRootTracker.make("case");
    return fn(home);
  }

  beforeAll(async () => {
    await suiteRootTracker.setup();

    // Default: return an empty plugin list so existing tests that don't need
    // plugin-owned channel schemas keep working unchanged.
    mockLoadPluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [],
    } satisfies PluginManifestRegistry);
  });

  afterAll(async () => {
    await suiteRootTracker.cleanup();
  });

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
    io: { writeConfigFile: (config: Record<string, unknown>) => Promise<unknown> };
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

  const createGatewayCommandsInput = (): Record<string, unknown> => ({
    gateway: { mode: "local" },
    commands: { ownerDisplay: "hash" },
  });

  const expectInputOwnerDisplayUnchanged = (input: Record<string, unknown>) => {
    expect((input.commands as Record<string, unknown>).ownerDisplay).toBe("hash");
  };

  const readPersistedCommands = async (configPath: string) => {
    const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
      commands?: Record<string, unknown>;
    };
    return persisted.commands;
  };

  async function runUnsetNoopCase(params: { home: string; unsetPaths: string[][] }) {
    const { configPath, io } = await writeConfigAndCreateIo({
      home: params.home,
      initialConfig: createGatewayCommandsInput(),
    });

    const input = createGatewayCommandsInput();
    await io.writeConfigFile(input, { unsetPaths: params.unsetPaths });

    expectInputOwnerDisplayUnchanged(input);
    expect((await readPersistedCommands(configPath))?.ownerDisplay).toBe("hash");
  }

  it("persists caller changes onto resolved config without leaking runtime defaults", async () => {
    await withSuiteHome(async (home) => {
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

  it.runIf(process.platform !== "win32")(
    "tightens world-writable state dir when writing the default config",
    async () => {
      await withSuiteHome(async (home) => {
        const stateDir = path.join(home, ".openclaw");
        await fs.mkdir(stateDir, { recursive: true, mode: 0o777 });
        await fs.chmod(stateDir, 0o777);

        const io = createConfigIO({
          env: {} as NodeJS.ProcessEnv,
          homedir: () => home,
          logger: silentLogger,
        });

        await io.writeConfigFile({ gateway: { mode: "local" } });

        const stat = await fs.stat(stateDir);
        expect(stat.mode & 0o777).toBe(0o700);
      });
    },
  );

  it("keeps writes inside an OPENCLAW_STATE_DIR override even when the real home config exists", async () => {
    await withSuiteHome(async (home) => {
      const liveConfigPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(liveConfigPath), { recursive: true });
      await fs.writeFile(
        liveConfigPath,
        `${JSON.stringify({ gateway: { mode: "local", port: 18789 } }, null, 2)}\n`,
        "utf-8",
      );

      const overrideDir = path.join(home, "isolated-state");
      const env = { OPENCLAW_STATE_DIR: overrideDir } as NodeJS.ProcessEnv;
      const io = createConfigIO({
        env,
        homedir: () => home,
        logger: silentLogger,
      });

      expect(io.configPath).toBe(path.join(overrideDir, "openclaw.json"));

      await io.writeConfigFile({
        agents: { list: [{ id: "main", default: true }] },
        gateway: { mode: "local" },
        session: { mainKey: "main", store: path.join(overrideDir, "sessions.json") },
      });

      const livePersisted = JSON.parse(await fs.readFile(liveConfigPath, "utf-8")) as {
        gateway?: { mode?: unknown; port?: unknown };
      };
      expect(livePersisted.gateway).toEqual({ mode: "local", port: 18789 });

      const overridePersisted = JSON.parse(
        await fs.readFile(path.join(overrideDir, "openclaw.json"), "utf-8"),
      ) as {
        session?: { store?: unknown };
      };
      expect(overridePersisted.session?.store).toBe(path.join(overrideDir, "sessions.json"));
    });
  });

  it('shows actionable guidance for dmPolicy="open" without wildcard allowFrom', async () => {
    await withSuiteHome(async (home) => {
      const io = createConfigIO({
        env: {} as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });

      const invalidConfig: OpenClawConfig = {
        channels: {
          telegram: {
            dmPolicy: "open",
            allowFrom: [],
          },
        },
      } satisfies OpenClawConfig;

      await expect(io.writeConfigFile(invalidConfig)).rejects.toThrow(
        "openclaw config set channels.telegram.allowFrom '[\"*\"]'",
      );
      await expect(io.writeConfigFile(invalidConfig)).rejects.toThrow(
        'openclaw config set channels.telegram.dmPolicy "pairing"',
      );
    });
  });

  it("honors explicit unset paths when schema defaults would otherwise reappear", async () => {
    await withSuiteHome(async (home) => {
      const { configPath, io, snapshot } = await writeConfigAndCreateIo({
        home,
        initialConfig: {
          gateway: { auth: { mode: "none" } },
          commands: { ownerDisplay: "hash" },
        },
      });

      const next = structuredClone(snapshot.resolved) as Record<string, unknown>;
      if (
        next.commands &&
        typeof next.commands === "object" &&
        "ownerDisplay" in (next.commands as Record<string, unknown>)
      ) {
        delete (next.commands as Record<string, unknown>).ownerDisplay;
      }

      await io.writeConfigFile(next, { unsetPaths: [["commands", "ownerDisplay"]] });

      const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
        commands?: Record<string, unknown>;
      };
      expect(persisted.commands ?? {}).not.toHaveProperty("ownerDisplay");
    });
  });

  it("does not mutate caller config when unsetPaths is applied on first write", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const io = createConfigIO({
        env: {} as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });

      const input: Record<string, unknown> = {
        gateway: { mode: "local" },
        commands: { ownerDisplay: "hash" },
      };

      await io.writeConfigFile(input, { unsetPaths: [["commands", "ownerDisplay"]] });

      expect(input).toEqual({
        gateway: { mode: "local" },
        commands: { ownerDisplay: "hash" },
      });
      expectInputOwnerDisplayUnchanged(input);
      expect((await readPersistedCommands(configPath)) ?? {}).not.toHaveProperty("ownerDisplay");
    });
  });

  it("does not mutate caller config when unsetPaths is applied on existing files", async () => {
    await withSuiteHome(async (home) => {
      const { configPath, io, snapshot } = await writeConfigAndCreateIo({
        home,
        initialConfig: {
          gateway: { mode: "local" },
          commands: { ownerDisplay: "hash" },
        },
      });

      const input = structuredClone(snapshot.config) as Record<string, unknown>;
      await io.writeConfigFile(input, { unsetPaths: [["commands", "ownerDisplay"]] });

      expectInputOwnerDisplayUnchanged(input);
      expect((await readPersistedCommands(configPath)) ?? {}).not.toHaveProperty("ownerDisplay");
    });
  });

  it("keeps caller arrays immutable when unsetting array entries", async () => {
    await withSuiteHome(async (home) => {
      const { configPath, io, snapshot } = await writeConfigAndCreateIo({
        home,
        initialConfig: {
          gateway: { mode: "local" },
          tools: { alsoAllow: ["exec", "fetch", "read"] },
        },
      });

      const input = structuredClone(snapshot.config) as Record<string, unknown>;
      await io.writeConfigFile(input, { unsetPaths: [["tools", "alsoAllow", "1"]] });

      expect((input.tools as { alsoAllow: string[] }).alsoAllow).toEqual(["exec", "fetch", "read"]);
      const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
        tools?: { alsoAllow?: string[] };
      };
      expect(persisted.tools?.alsoAllow).toEqual(["exec", "read"]);
    });
  });

  it("treats missing unset paths as no-op without mutating caller config", async () => {
    await withSuiteHome(async (home) => {
      await runUnsetNoopCase({
        home,
        unsetPaths: [["commands", "missingKey"]],
      });
    });
  });

  it("ignores blocked prototype-key unset path segments", async () => {
    await withSuiteHome(async (home) => {
      await runUnsetNoopCase({
        home,
        unsetPaths: [
          ["commands", "__proto__"],
          ["commands", "constructor"],
          ["commands", "prototype"],
        ],
      });
    });
  });

  it("does not leak channel plugin AJV defaults into persisted config (issue #56772)", async () => {
    // Regression test for #56772. Mock the BlueBubbles channel metadata so
    // read-time AJV validation injects the same default that triggered the
    // write-back leak.
    mockLoadPluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [createBlueBubblesManifestRecord()],
    });

    await withSuiteHome(async (home) => {
      const { configPath, io, snapshot } = await writeConfigAndCreateIo({
        home,
        initialConfig: {
          gateway: { port: 18789 },
          channels: {
            bluebubbles: {
              serverUrl: "http://localhost:1234",
              password: "test-password",
            },
          },
        },
      });

      // Simulate doctor: clone snapshot.config, make a small change, write back.
      const next = structuredClone(snapshot.config);
      const gateway =
        next.gateway && typeof next.gateway === "object"
          ? (next.gateway as Record<string, unknown>)
          : {};
      next.gateway = {
        ...gateway,
        auth: { mode: "token" },
      };
      await io.writeConfigFile(next);

      const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as Record<
        string,
        unknown
      >;

      // The persisted config should contain only explicitly set values.
      expect(persisted.gateway).toEqual({
        port: 18789,
        auth: { mode: "token" },
      });

      // The critical assertion: the AJV-injected BlueBubbles default must not
      // appear in the persisted config.
      const channels = persisted.channels as Record<string, Record<string, unknown>> | undefined;
      expect(channels?.bluebubbles).toBeDefined();
      expect(channels?.bluebubbles).not.toHaveProperty("enrichGroupParticipantsFromContacts");
      expect(channels?.bluebubbles?.serverUrl).toBe("http://localhost:1234");
      expect(channels?.bluebubbles?.password).toBe("test-password");
    });

    // Restore the default empty-plugins mock for subsequent tests.
    mockLoadPluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [],
    } satisfies PluginManifestRegistry);
  });

  it("does not reintroduce Slack/Discord legacy dm.policy defaults when writing", async () => {
    await withSuiteHome(async (home) => {
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

  it("logs an overwrite audit entry when replacing an existing config file", async () => {
    await withSuiteHome(async (home) => {
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
    await withSuiteHome(async (home) => {
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
    await withSuiteHome(async (home) => {
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
      expect(last.previousMode).toBeTypeOf("number");
      expect(last.nextMode).toBeTypeOf("number");
      expect(last.previousIno).toBeTypeOf("string");
      expect(last.nextIno).toBeTypeOf("string");
      expect(last.result === "rename" || last.result === "copy-fallback").toBe(true);
    });
  });

  it('ignores literal "undefined" home env values when choosing the audit log path', async () => {
    await withSuiteHome(async (home) => {
      const { lines } = await writeGatewayPatchAndReadLastAuditEntry({
        home,
        initialConfig: { gateway: { mode: "local" } },
        gatewayPatch: { bind: "loopback" },
        env: {
          HOME: "undefined",
          USERPROFILE: "null",
          OPENCLAW_HOME: "undefined",
        } as NodeJS.ProcessEnv,
      });
      expect(lines.length).toBeGreaterThan(0);
      await expect(
        fs.stat(path.join(home, ".openclaw", "logs", "config-audit.jsonl")),
      ).resolves.toBeDefined();
      await expect(
        fs.stat(path.resolve("undefined", ".openclaw", "logs", "config-audit.jsonl")),
      ).rejects.toThrow();
    });
  });

  it("records gateway watch session markers in config audit entries", async () => {
    await withSuiteHome(async (home) => {
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
});
