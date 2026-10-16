import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { migrateLegacyConfig } from "../commands/doctor/shared/legacy-config-migrate.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { configIncludeOwnsAgentRoster } from "./agent-roster-provenance.js";
import { createConfigIO, readConfigFileSnapshot, resetConfigRuntimeState } from "./config.js";
import { validateConfigObjectRaw } from "./validation.js";

describe("persisted implicit-main roster migration", () => {
  it("normalizes a commented pre-roster config in memory without rewriting it", async () => {
    await withTempHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const raw = `// operator comment\n{ gateway: { mode: "local" } }\n`;
      await fs.writeFile(configPath, raw);
      resetConfigRuntimeState();

      const snapshot = await readConfigFileSnapshot();

      expect(snapshot.sourceConfig.agents?.entries).toEqual({ main: {} });
      expect(await fs.readFile(configPath, "utf8")).toBe(raw);
    });
  });

  it("injects main into the in-memory config when no file exists", async () => {
    await withTempHome(async () => {
      resetConfigRuntimeState();
      const snapshot = await readConfigFileSnapshot();
      expect(snapshot.exists).toBe(false);
      expect(snapshot.sourceConfig.agents?.entries).toEqual({ main: {} });
    });
  });

  it("retains include-resolved roster provenance before migration", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".openclaw");
      const configPath = path.join(configDir, "openclaw.json");
      const includePath = path.join(configDir, "included.json");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(configPath, JSON.stringify({ $include: "./included.json" }));

      await fs.writeFile(
        includePath,
        JSON.stringify({ channels: { telegram: { enabled: true } } }),
      );
      resetConfigRuntimeState();
      const channelsSnapshot = await readConfigFileSnapshot();
      expect(channelsSnapshot.sourceConfigBeforeMigrations?.agents?.entries).toBeUndefined();
      expect(channelsSnapshot.sourceConfig.agents?.entries).toEqual({ main: {} });

      await fs.writeFile(
        includePath,
        JSON.stringify({ agents: { list: [{ id: "ops", default: true }] } }),
      );
      resetConfigRuntimeState();
      const rosterSnapshot = await readConfigFileSnapshot();
      expect(rosterSnapshot.sourceConfigBeforeMigrations).toHaveProperty("agents.list", [
        { id: "ops", default: true },
      ]);
      expect(rosterSnapshot.valid).toBe(false);
      expect(rosterSnapshot.sourceConfig).toHaveProperty("agents.list", [
        { id: "ops", default: true },
      ]);
      expect(rosterSnapshot.sourceConfig.agents?.entries).toBeUndefined();
    });
  });

  it("tracks nested mixed roster includes at the entries boundary", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".openclaw");
      const configPath = path.join(configDir, "openclaw.json");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        configPath,
        JSON.stringify({
          $include: "./base.json",
          agents: { ownership: "explicit", entries: { main: {} } },
        }),
      );
      await fs.writeFile(
        path.join(configDir, "base.json"),
        JSON.stringify({ agents: { entries: { $include: "./entries.json" } } }),
      );
      await fs.writeFile(path.join(configDir, "entries.json"), JSON.stringify({ ops: {} }));
      resetConfigRuntimeState();

      const snapshot = await readConfigFileSnapshot();

      expect(snapshot.sourceConfigBeforeMigrations?.agents?.entries).toEqual({
        main: {},
        ops: {},
      });
      expect(snapshot.includeProvenance).toEqual([
        {
          path: ["agents", "entries"],
          kind: "single",
          hasSiblingOverrides: false,
          hasArrayAncestor: false,
          targetPath: path.join(configDir, "entries.json"),
        },
        {
          path: [],
          kind: "single",
          hasSiblingOverrides: true,
          hasArrayAncestor: false,
          targetPath: path.join(configDir, "base.json"),
        },
      ]);
      expect(configIncludeOwnsAgentRoster(snapshot)).toBe(true);
    });
  });

  it("keeps an unrelated ancestor include from owning a locally authored roster", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".openclaw");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "openclaw.json"),
        JSON.stringify({
          $include: "./channels.json",
          agents: { entries: {} },
        }),
      );
      await fs.writeFile(
        path.join(configDir, "channels.json"),
        JSON.stringify({ channels: { telegram: { enabled: true } } }),
      );
      resetConfigRuntimeState();

      const snapshot = await readConfigFileSnapshot();

      expect(snapshot.agentRosterIncludeOwned).toBe(false);
      expect(configIncludeOwnsAgentRoster(snapshot)).toBe(false);
    });
  });

  it("does not publish partial provenance when a later include fails", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".openclaw");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "openclaw.json"),
        JSON.stringify({
          agents: { $include: ["./delegating.json", "./missing.json"] },
        }),
      );
      await fs.writeFile(
        path.join(configDir, "delegating.json"),
        JSON.stringify({ $include: "./entries.json" }),
      );
      await fs.writeFile(
        path.join(configDir, "entries.json"),
        JSON.stringify({ entries: { main: {} } }),
      );
      resetConfigRuntimeState();

      const snapshot = await readConfigFileSnapshot();

      expect(snapshot.valid).toBe(false);
      expect(snapshot.includeProvenance).toBeUndefined();
    });
  });

  it("records an identical ancestor roster contribution as include-owned", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".openclaw");
      const entries = { main: {} };
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "openclaw.json"),
        JSON.stringify({ $include: "./base.json", agents: { entries } }),
      );
      await fs.writeFile(
        path.join(configDir, "base.json"),
        JSON.stringify({ agents: { entries } }),
      );
      resetConfigRuntimeState();

      const snapshot = await readConfigFileSnapshot();

      expect(snapshot.agentRosterIncludeOwned).toBe(true);
      expect(configIncludeOwnsAgentRoster(snapshot)).toBe(true);
    });
  });

  it("keeps an entry-internal identity include locally roster-owned", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".openclaw");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "openclaw.json"),
        JSON.stringify({
          agents: {
            entries: {
              main: {
                identity: { $include: "./identity.json" },
              },
            },
          },
        }),
      );
      await fs.writeFile(path.join(configDir, "identity.json"), JSON.stringify({ name: "Main" }));
      resetConfigRuntimeState();

      const snapshot = await readConfigFileSnapshot();

      expect(snapshot.agentRosterIncludeOwned).toBe(false);
      expect(configIncludeOwnsAgentRoster(snapshot)).toBe(false);
    });
  });

  it("records a legacy list id include as roster-owned", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".openclaw");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "openclaw.json"),
        JSON.stringify({
          agents: {
            list: [{ id: { $include: "./agent-id.json" }, default: true }],
          },
        }),
      );
      await fs.writeFile(path.join(configDir, "agent-id.json"), JSON.stringify("10"));
      resetConfigRuntimeState();

      const snapshot = await readConfigFileSnapshot();

      expect(snapshot.sourceConfigBeforeMigrations).toHaveProperty("agents.list.0.id", "10");
      expect(snapshot.agentRosterIncludeOwned).toBe(true);
      expect(configIncludeOwnsAgentRoster(snapshot)).toBe(true);
    });
  });

  it.each([false, true])(
    "persists Doctor's workspace and owner migration with original backup bytes (marked: %s)",
    async (marked) => {
      await withTempHome(async (home) => {
        const selectedHome = path.join(home, "selected-home");
        const configPath = path.join(selectedHome, ".openclaw", "openclaw.json");
        await fs.mkdir(path.dirname(configPath), { recursive: true });
        const source = {
          plugins: { enabled: false },
          agents: {
            list: [{ id: "first", ...(marked ? { default: true } : {}) }, { id: "other" }],
          },
        };
        const raw = JSON.stringify(source);
        await fs.writeFile(configPath, raw);
        const env = { HOME: selectedHome };
        const io = createConfigIO({
          configPath,
          env,
          homedir: () => selectedHome,
          observe: false,
          pluginValidation: "core-only",
        });
        try {
          const before = await io.readConfigFileSnapshot();
          expect(before.valid).toBe(false);
          expect(before.sourceConfig).toHaveProperty("agents.list", source.agents.list);
          expect(await fs.readFile(configPath, "utf8")).toBe(raw);
          const migrated = migrateLegacyConfig(source, {
            sourceConfigBeforeMigrations: source,
            context: { authoredRaw: source, resolvedRaw: source, env, homedir: () => selectedHome },
            pluginContracts: false,
          });
          expect(migrated.partiallyValid).not.toBe(true);
          expect(migrated.config).not.toBeNull();
          if (!migrated.config) {
            throw new Error("Doctor did not produce a canonical roster");
          }
          const workspace = path.join(selectedHome, ".openclaw", "workspace");
          expect(migrated.config.agents?.entries?.first?.workspace).toBe(workspace);
          expect(migrated.config.agents?.defaults?.systemAgent?.agentId).toBe(
            marked ? "first" : undefined,
          );
          await io.writeConfigFile(migrated.config, {
            skipPluginValidation: true,
            persistCanonicalAgentRoster: true,
          });
          const after = await io.readConfigFileSnapshot();
          expect(after.valid).toBe(true);
          expect(after.sourceConfig.agents?.entries?.first?.workspace).toBe(workspace);
          expect(await fs.readFile(`${configPath}.bak`, "utf8")).toBe(raw);
        } finally {
          await closeOpenClawStateDatabaseByPathAsync(
            resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: path.dirname(configPath) }),
          );
        }
      });
    },
  );

  it("preserves original numeric list order when Doctor pins a markerless workspace", () => {
    const raw = {
      plugins: { enabled: false },
      agents: { defaults: { workspace: "/srv/fleet" }, list: [{ id: "10" }, { id: "2" }] },
    };
    const migrated = migrateLegacyConfig(raw, {
      sourceConfigBeforeMigrations: raw,
      pluginContracts: false,
    });
    expect(migrated.config).toMatchObject({
      agents: { ownership: "explicit", entries: { "2": {}, "10": { workspace: "/srv/fleet" } } },
    });
    expect(migrated.config?.agents?.defaults?.systemAgent?.agentId).toBeUndefined();
    expect(raw.agents.list).toEqual([{ id: "10" }, { id: "2" }]);
  });

  it("leaves duplicate default markers unresolved instead of choosing a data owner", () => {
    const raw = {
      plugins: { enabled: false },
      agents: {
        list: [
          { id: "10", default: true },
          { id: "2", default: true },
        ],
      },
    };
    const migrated = migrateLegacyConfig(raw, {
      sourceConfigBeforeMigrations: raw,
      pluginContracts: false,
    });
    expect(migrated.partiallyValid).toBe(true);
    expect(migrated.config?.agents?.entries).toEqual({
      "2": { default: true },
      "10": { default: true },
    });
    expect(migrated.config?.agents?.defaults?.systemAgent?.agentId).toBeUndefined();
  });

  it.each([null, [], "invalid"])(
    "preserves malformed canonical entries instead of falling back to a list: %j",
    (entries) => {
      const raw = {
        plugins: { enabled: false },
        agents: { entries, list: [{ id: "ops" }] },
      };
      const migrated = migrateLegacyConfig(raw, {
        sourceConfigBeforeMigrations: raw,
        pluginContracts: false,
      });
      const candidate = migrated.config ?? raw;
      expect(candidate.agents?.entries).toEqual(entries);
      expect(candidate).toHaveProperty("agents.list", [{ id: "ops" }]);
      expect(validateConfigObjectRaw(candidate).ok).toBe(false);
    },
  );

  it("preserves own blocked entry fields for strict schema rejection", () => {
    const unsafeEntry = JSON.parse('{"__proto__":{"tools":{"allow":["*"]}}}');
    const config = { agents: { entries: { ops: unsafeEntry } } };
    const validation = validateConfigObjectRaw(config);
    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(validation.issues).toContainEqual({
        path: "agents.entries.ops.__proto__",
        message: "agent entries must not contain blocked object keys",
      });
    }
    expect(Object.hasOwn(config.agents.entries.ops, "__proto__")).toBe(true);
    expect(config.agents.entries.ops.tools).toBeUndefined();
  });

  it.each([{ entries: {} }, { list: [] }])(
    "bootstraps a non-explicit empty roster without rewriting it: %j",
    async (agents) => {
      await withTempHome(async (home) => {
        const configPath = path.join(home, ".openclaw", "openclaw.json");
        await fs.mkdir(path.dirname(configPath), { recursive: true });
        await fs.writeFile(configPath, JSON.stringify({ agents }));
        resetConfigRuntimeState();

        const snapshot = await readConfigFileSnapshot();

        expect(snapshot.valid).toBe(true);
        expect(snapshot.sourceConfig.agents?.entries).toEqual({ main: {} });
        expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toEqual({ agents });
      });
    },
  );

  it.each([
    {
      label: "legacy marker-free entries",
      entries: { ops: {}, research: {} },
    },
    {
      label: "duplicate defaults",
      entries: { ops: {}, research: { default: true }, writer: { default: true } },
    },
    {
      label: "false default markers",
      entries: { ops: { default: false }, research: { default: false } },
    },
  ])("rejects $label without inventing legacy ownership", async ({ entries }) => {
    await withTempHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, JSON.stringify({ agents: { entries } }));
      resetConfigRuntimeState();

      const snapshot = await readConfigFileSnapshot();

      expect(snapshot.valid).toBe(false);
      expect(snapshot.issues).toContainEqual(
        expect.objectContaining({ path: expect.stringMatching(/^agents\.(entries|ownership)/) }),
      );
      expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toEqual({
        agents: { entries },
      });
    });
  });

  it("requires Doctor for a shipped default marker without changing its owner or bytes", async () => {
    await withTempHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const entries = { ops: {}, research: { default: true } };
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, JSON.stringify({ agents: { entries } }));
      resetConfigRuntimeState();

      const snapshot = await readConfigFileSnapshot();

      expect(snapshot.valid).toBe(false);
      expect(snapshot.sourceConfig.agents?.entries).toEqual(entries);
      expect(snapshot.legacyIssues).toContainEqual(
        expect.objectContaining({
          path: "agents.entries",
          message: expect.stringContaining("doctor --fix"),
        }),
      );
      expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toEqual({ agents: { entries } });
    });
  });

  it("leaves non-boolean default markers for schema validation", async () => {
    await withTempHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        JSON.stringify({ agents: { entries: { ops: { default: "yes" } } } }),
      );
      resetConfigRuntimeState();

      const snapshot = await readConfigFileSnapshot();

      expect(snapshot.valid).toBe(false);
      expect(snapshot.issues).toContainEqual(
        expect.objectContaining({ path: "agents.entries.ops.default" }),
      );
    });
  });
});
