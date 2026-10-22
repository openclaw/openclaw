import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { migrateLegacyConfig } from "../commands/doctor/shared/legacy-config-migrate.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { configIncludeOwnsAgentRoster } from "./agent-roster-provenance.js";
import { createConfigIO, readConfigFileSnapshot, resetConfigRuntimeState } from "./config.js";
import type { ConfigFileSnapshot } from "./types.openclaw.js";
import { validateConfigObjectRaw } from "./validation.js";

async function readSnapshot() {
  resetConfigRuntimeState();
  return readConfigFileSnapshot();
}

async function withConfig(
  config: unknown,
  run: (snapshot: ConfigFileSnapshot, configPath: string) => void | Promise<void>,
  includes: Record<string, unknown> = {},
) {
  await withTempHome(async (home) => {
    const configDir = path.join(home, ".openclaw");
    await fs.mkdir(configDir, { recursive: true });
    for (const [name, value] of Object.entries({ "openclaw.json": config, ...includes })) {
      await fs.writeFile(path.join(configDir, name), JSON.stringify(value));
    }
    await run(await readSnapshot(), path.join(configDir, "openclaw.json"));
  });
}

function migrate(raw: unknown) {
  return migrateLegacyConfig(raw, { sourceConfigBeforeMigrations: raw, pluginContracts: false });
}

function provenance(targetPath: string, at: string[], hasSiblingOverrides: boolean) {
  return { path: at, kind: "single", hasSiblingOverrides, hasArrayAncestor: false, targetPath };
}

describe("persisted implicit-main roster migration", () => {
  it("normalizes a commented pre-roster config in memory without rewriting it", async () => {
    await withTempHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const raw = `// operator comment\n{ gateway: { mode: "local" } }\n`;
      await fs.writeFile(configPath, raw);
      const snapshot = await readSnapshot();

      expect(snapshot.sourceConfig.agents?.entries).toEqual({ main: {} });
      expect(await fs.readFile(configPath, "utf8")).toBe(raw);
    });
  });

  it("injects main into the in-memory config when no file exists", async () => {
    await withTempHome(async () => {
      const snapshot = await readSnapshot();
      expect(snapshot.exists).toBe(false);
      expect(snapshot.sourceConfig.agents?.entries).toEqual({ main: {} });
    });
  });

  it("retains include-resolved roster provenance before migration", async () => {
    await withConfig(
      { $include: "./included.json" },
      async (channelsSnapshot, configPath) => {
        const includePath = path.join(path.dirname(configPath), "included.json");
        const list = [{ id: "ops", default: true }];
        expect(channelsSnapshot.sourceConfigBeforeMigrations?.agents?.entries).toBeUndefined();
        expect(channelsSnapshot.sourceConfig.agents?.entries).toEqual({ main: {} });

        await fs.writeFile(includePath, JSON.stringify({ agents: { list } }));
        const rosterSnapshot = await readSnapshot();
        expect(rosterSnapshot.sourceConfigBeforeMigrations).toHaveProperty("agents.list", list);
        expect(rosterSnapshot.valid).toBe(false);
        expect(rosterSnapshot.sourceConfig).toHaveProperty("agents.list", list);
        expect(rosterSnapshot.sourceConfig.agents?.entries).toBeUndefined();
      },
      { "included.json": { channels: { telegram: { enabled: true } } } },
    );
  });

  it("tracks nested mixed roster includes at the entries boundary", async () => {
    await withConfig(
      { $include: "./base.json", agents: { ownership: "explicit", entries: { main: {} } } },
      (snapshot, configPath) => {
        const configDir = path.dirname(configPath);
        expect(snapshot.sourceConfigBeforeMigrations?.agents?.entries).toEqual({
          main: {},
          ops: {},
        });
        expect(snapshot.includeProvenance).toEqual([
          provenance(path.join(configDir, "entries.json"), ["agents", "entries"], false),
          provenance(path.join(configDir, "base.json"), [], true),
        ]);
        expect(configIncludeOwnsAgentRoster(snapshot)).toBe(true);
      },
      {
        "base.json": { agents: { entries: { $include: "./entries.json" } } },
        "entries.json": { ops: {} },
      },
    );
  });

  it.each([
    {
      name: "unrelated ancestor",
      owned: false,
      config: { $include: "./included.json", agents: { entries: {} } },
      included: { channels: { telegram: { enabled: true } } },
    },
    {
      name: "identical ancestor roster contribution",
      owned: true,
      config: { $include: "./included.json", agents: { entries: { main: {} } } },
      included: { agents: { entries: { main: {} } } },
    },
    {
      name: "entry-internal identity",
      owned: false,
      config: { agents: { entries: { main: { identity: { $include: "./included.json" } } } } },
      included: { name: "Main" },
    },
    {
      name: "legacy list id",
      owned: true,
      config: { agents: { list: [{ id: { $include: "./included.json" }, default: true }] } },
      included: "10",
    },
  ])("tracks roster ownership for $name includes", async ({ config, included, owned }) => {
    await withConfig(
      config,
      (snapshot) => {
        expect(snapshot.agentRosterIncludeOwned).toBe(owned);
        expect(configIncludeOwnsAgentRoster(snapshot)).toBe(owned);
        if (typeof included === "string") {
          expect(snapshot.sourceConfigBeforeMigrations).toHaveProperty("agents.list.0.id", "10");
        }
      },
      { "included.json": included },
    );
  });

  it("does not publish partial provenance when a later include fails", async () => {
    await withConfig(
      { agents: { $include: ["./delegating.json", "./missing.json"] } },
      (snapshot) => {
        expect(snapshot.valid).toBe(false);
        expect(snapshot.includeProvenance).toBeUndefined();
      },
      {
        "delegating.json": { $include: "./entries.json" },
        "entries.json": { entries: { main: {} } },
      },
    );
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
    const migrated = migrate(raw);
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
    const migrated = migrate(raw);
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
      const migrated = migrate(raw);
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
      await withConfig({ agents }, async (snapshot, configPath) => {
        expect(snapshot.valid).toBe(true);
        expect(snapshot.sourceConfig.agents?.entries).toEqual({ main: {} });
        expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toEqual({ agents });
      });
    },
  );

  it.each([
    ["legacy marker-free entries", { ops: {}, research: {} }],
    ["duplicate defaults", { ops: {}, research: { default: true }, writer: { default: true } }],
    ["false default markers", { ops: { default: false }, research: { default: false } }],
  ])("rejects %s without inventing legacy ownership", async (_label, entries) => {
    await withConfig({ agents: { entries } }, async (snapshot, configPath) => {
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
    const entries = { ops: {}, research: { default: true } };
    await withConfig({ agents: { entries } }, async (snapshot, configPath) => {
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
    await withConfig({ agents: { entries: { ops: { default: "yes" } } } }, (snapshot) => {
      expect(snapshot.valid).toBe(false);
      expect(snapshot.issues).toContainEqual(
        expect.objectContaining({ path: "agents.entries.ops.default" }),
      );
    });
  });
});
