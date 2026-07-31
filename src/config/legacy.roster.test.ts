import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";

const persistedAuthProbe = vi.hoisted(() => ({ enabled: false }));
vi.mock("../channels/plugins/persisted-auth-state.js", () => ({
  listBundledChannelIdsWithPersistedAuthState: () => ["whatsapp"],
  hasBundledChannelPersistedAuthState: () => persistedAuthProbe.enabled,
}));

import { resolveAgentRoute } from "../routing/resolve-route.js";
import { configIncludeOwnsAgentRoster } from "./agent-roster-provenance.js";
import { readConfigFileSnapshot, resetConfigRuntimeState } from "./config.js";
import {
  inheritLegacyDefaultAgentId,
  listLegacyOwnershipWarnings,
  retainLegacyDefaultAgentId,
  tryGetLegacyDefaultAgentId,
} from "./legacy.default-agent-owner.js";
import { migratePersistedImplicitMainRoster } from "./legacy.js";
import type { OpenClawConfig } from "./types.openclaw.js";
import {
  validateConfigObjectRaw,
  validateConfigObjectRawWithPlugins,
  validateConfigObjectWithPlugins,
} from "./validation.js";

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
      expect(rosterSnapshot.sourceConfigBeforeMigrations?.agents?.list).toEqual([
        { id: "ops", default: true },
      ]);
      expect(rosterSnapshot.sourceConfig.agents?.entries).toEqual({ ops: {} });
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
          agents: { entries: { main: { default: true } } },
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
        main: { default: true },
        ops: {},
      });
      expect(snapshot.includeProvenance).toEqual([
        {
          path: ["agents", "entries"],
          kind: "single",
          hasSiblingOverrides: false,
          targetPath: path.join(configDir, "entries.json"),
        },
        {
          path: [],
          kind: "single",
          hasSiblingOverrides: true,
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
        JSON.stringify({ entries: { main: { default: true } } }),
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
      const entries = { main: { default: true } };
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
                default: true,
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

      expect(snapshot.sourceConfigBeforeMigrations?.agents?.list?.[0]?.id).toBe("10");
      expect(snapshot.agentRosterIncludeOwned).toBe(true);
      expect(configIncludeOwnsAgentRoster(snapshot)).toBe(true);
    });
  });

  it("preserves malformed agents values for validation", () => {
    expect(migratePersistedImplicitMainRoster({ agents: "invalid" })).toEqual({
      config: { agents: "invalid" },
      changed: false,
      diagnostics: [],
    });
  });

  it("converts a legacy list, materializes its retired default, and strips the marker", () => {
    expect(
      migratePersistedImplicitMainRoster({
        agents: {
          defaults: { workspace: "/srv/ops" },
          list: [
            { id: "ops", workspace: "/srv/ops" },
            { id: "writer", default: true },
          ],
        },
      }),
    ).toEqual({
      config: {
        agents: {
          entries: {
            ops: { workspace: "/srv/ops" },
            writer: { workspace: "/srv/ops" },
          },
          defaults: {
            workspace: "/srv/ops",
            heartbeat: { agentId: "writer" },
            systemAgent: { agentId: "writer" },
            authInheritance: { agentId: "writer" },
          },
        },
        talk: { agentId: "writer" },
      },
      changed: true,
      diagnostics: [
        "Moved agents.list to keyed agents.entries.",
        'Pinned the retired default agent "writer" to its current workspace.',
        'Assigned ambient heartbeat runs to agent "writer".',
        'Assigned ambient system-agent consults to agent "writer".',
        'Preserved inherited credential ownership for agent "writer".',
        'Assigned ambient Talk sessions to agent "writer".',
        "Removed retired agents.entries.*.default markers.",
      ],
      insertedPaths: [
        ["agents", "entries", "writer", "workspace"],
        ["agents", "defaults", "heartbeat", "agentId"],
        ["agents", "defaults", "systemAgent", "agentId"],
        ["agents", "defaults", "authInheritance", "agentId"],
        ["talk", "agentId"],
      ],
      retainedLegacyDefaultAgentId: "writer",
    });
  });

  it("preserves the first legacy list owner when no marker was authored", () => {
    const migrated = migratePersistedImplicitMainRoster({
      agents: {
        defaults: {
          heartbeat: { agentId: "10" },
          systemAgent: { agentId: "10" },
        },
        list: [{ id: "10", workspace: "/srv/10" }, { id: "2" }],
      },
      channels: { telegram: { enabled: true } },
      talk: { agentId: "10" },
    });
    expect(migrated.config).toMatchObject({
      agents: {
        defaults: {
          heartbeat: { agentId: "10" },
          systemAgent: { agentId: "10" },
        },
        entries: { "2": {}, "10": {} },
      },
      bindings: [{ agentId: "10", match: { channel: "telegram", accountId: "*" } }],
      talk: { agentId: "10" },
    });
    expect(migrated.retainedLegacyDefaultAgentId).toBe("10");
  });

  it("does not persist redundant compatibility owners for main or a sole agent", () => {
    const mainFleet = migratePersistedImplicitMainRoster({
      session: { store: "/tmp/main-fleet-sessions.json" },
      agents: { entries: { main: { default: true }, ops: {} } },
    }).config as OpenClawConfig;
    const soleAgent = migratePersistedImplicitMainRoster({
      session: { store: "/tmp/sole-ops-sessions.json" },
      agents: { entries: { ops: { default: true } } },
    }).config as OpenClawConfig;

    expect(mainFleet.agents?.defaults?.authInheritance).toBeUndefined();
    expect(mainFleet.agents?.defaults?.sessionStore).toBeUndefined();
    expect(soleAgent.agents?.defaults?.authInheritance).toBeUndefined();
    expect(soleAgent.agents?.defaults?.sessionStore).toBeUndefined();
  });

  it.each([
    {
      label: "missing default",
      list: [{ id: "10" }, { id: "2" }],
    },
    {
      label: "duplicate defaults",
      list: [
        { id: "10", default: true },
        { id: "2", default: true },
      ],
    },
  ])("preserves original list order for numeric ids with $label", ({ list }) => {
    const migrated = migratePersistedImplicitMainRoster({ agents: { list } });
    expect(migrated.changed).toBe(true);
    expect(migrated.config).toMatchObject({ agents: { entries: { "2": {}, "10": {} } } });
  });

  it("preserves a __proto__ agent as an own keyed entry", () => {
    const migrated = migratePersistedImplicitMainRoster({
      agents: { list: [{ id: "__proto__" }] },
    });
    const config = migrated.config as {
      agents: { entries: Record<string, { default?: boolean }> };
    };

    expect(Object.hasOwn(config.agents.entries, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(config.agents.entries, "__proto__")?.value).toEqual({});
  });

  it("preserves an own __proto__ entry field for strict schema rejection", () => {
    const unsafeEntry = JSON.parse('{"__proto__":{"tools":{"allow":["*"]}}}') as Record<
      string,
      unknown
    >;
    const migrated = migratePersistedImplicitMainRoster({
      agents: { entries: { ops: unsafeEntry } },
    });
    const entry = (
      migrated.config as {
        agents: { entries: Record<string, Record<string, unknown>> };
      }
    ).agents.entries.ops!;

    expect(Object.getPrototypeOf(entry)).toBe(Object.prototype);
    expect(Object.hasOwn(entry, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(entry, "__proto__")?.value).toEqual({
      tools: { allow: ["*"] },
    });
    expect(entry.tools).toBeUndefined();
    expect(entry.default).toBeUndefined();
    const validation = validateConfigObjectRaw(migrated.config);
    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(validation.issues).toContainEqual({
        path: "agents.entries.ops.__proto__",
        message: "agent entries must not contain blocked object keys",
      });
    }
  });

  it("leaves malformed legacy list entries for schema validation", () => {
    const malformed = { agents: { list: [null, { id: "ops", default: true }] } };
    expect(migratePersistedImplicitMainRoster(malformed)).toEqual({
      config: malformed,
      changed: false,
      diagnostics: [],
    });
  });

  it.each([
    { list: [{ default: true }] },
    { list: [{ id: "" }] },
    { list: [{ id: "Ops" }] },
    { list: [{ id: "ops" }, { id: "ops" }] },
  ])("leaves invalid or colliding legacy ids for schema validation", ({ list }) => {
    const raw = { agents: { list } };
    expect(migratePersistedImplicitMainRoster(raw)).toEqual({
      config: raw,
      changed: false,
      diagnostics: [],
    });
  });

  it("migrates a persisted empty roster to explicit main", async () => {
    await withTempHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, JSON.stringify({ agents: { entries: {} } }));
      resetConfigRuntimeState();

      const snapshot = await readConfigFileSnapshot();

      expect(snapshot.sourceConfig.agents?.entries).toEqual({ main: {} });
      expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toEqual({
        agents: { entries: {} },
      });
    });
  });

  it.each([{ ownership: "explicit" as const }, { ownership: "explicit" as const, entries: {} }])(
    "leaves an explicitly empty fleet for schema rejection",
    (agents) => {
      const raw = { agents };
      expect(migratePersistedImplicitMainRoster(raw)).toEqual({
        config: raw,
        changed: false,
        diagnostics: [],
      });
      expect(validateConfigObjectRaw(raw).ok).toBe(false);
    },
  );

  it("clears retained ownership metadata when a reused config becomes explicit", () => {
    const raw = {
      agents: { ownership: "explicit" as const, entries: { ops: {}, research: {} } },
    };
    retainLegacyDefaultAgentId(raw, "ops", {
      warnings: [{ path: "agents.entries", message: "legacy owner retained" }],
    });

    const migrated = migratePersistedImplicitMainRoster(raw);

    expect(migrated.config).toBe(raw);
    expect(tryGetLegacyDefaultAgentId(raw)).toBeUndefined();
    expect(listLegacyOwnershipWarnings(raw)).toEqual([]);

    const target = retainLegacyDefaultAgentId({ agents: { entries: { ops: {} } } }, "ops", {
      warnings: [{ path: "agents.entries", message: "stale target metadata" }],
    });
    inheritLegacyDefaultAgentId(raw, target);
    expect(tryGetLegacyDefaultAgentId(target)).toBeUndefined();
    expect(listLegacyOwnershipWarnings(target)).toEqual([]);
  });

  it.each([
    {
      label: "legacy marker-free entries",
      entries: { ops: {}, research: {} },
      expected: { ops: {}, research: {} },
      expectedOwner: "ops",
    },
    {
      label: "duplicate defaults",
      entries: { ops: {}, research: { default: true }, writer: { default: true } },
      expected: { ops: {}, research: {}, writer: {} },
      expectedOwner: "research",
    },
    {
      label: "false default markers",
      entries: { ops: { default: false }, research: { default: false } },
      expected: { ops: {}, research: {} },
      expectedOwner: "ops",
    },
  ])("strips $label markers in memory", async ({ entries, expected, expectedOwner }) => {
    await withTempHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, JSON.stringify({ agents: { entries } }));
      resetConfigRuntimeState();

      const snapshot = await readConfigFileSnapshot();

      expect(snapshot.valid).toBe(true);
      expect(snapshot.sourceConfig.agents?.entries).toMatchObject(expected);
      if (expectedOwner) {
        expect(snapshot.sourceConfig.agents?.entries?.[expectedOwner]?.workspace).toEqual(
          expect.any(String),
        );
      }
      expect(snapshot.sourceConfig.agents?.defaults?.heartbeat?.agentId).toBe(expectedOwner);
      expect(snapshot.sourceConfig.agents?.defaults?.systemAgent?.agentId).toBe(expectedOwner);
      expect(snapshot.sourceConfig.agents?.defaults?.authInheritance?.agentId).toBe(
        expectedOwner === "main" ? undefined : expectedOwner,
      );
      expect(snapshot.sourceConfig.talk?.agentId).toBe(expectedOwner);
      expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toEqual({
        agents: { entries },
      });
    });
  });

  it("materializes each missing marker-free surface despite a narrower peer binding", () => {
    const raw = {
      agents: { entries: { ops: {}, research: {} } },
      channels: { telegram: { enabled: true } },
      bindings: [{ agentId: "research", match: { channel: "telegram", accountId: "work" } }],
    };

    const migrated = migratePersistedImplicitMainRoster(raw);

    expect(migrated.changed).toBe(true);
    expect(migrated.config).toMatchObject({
      agents: {
        defaults: {
          heartbeat: { agentId: "ops" },
          systemAgent: { agentId: "ops" },
          authInheritance: { agentId: "ops" },
        },
        entries: { ops: { workspace: expect.any(String) }, research: {} },
      },
      bindings: [
        { agentId: "research", match: { channel: "telegram", accountId: "work" } },
        { agentId: "ops", match: { channel: "telegram", accountId: "*" } },
      ],
      talk: { agentId: "ops" },
    });
    expect(tryGetLegacyDefaultAgentId(migrated.config as OpenClawConfig)).toBe("ops");

    const validation = validateConfigObjectWithPlugins(raw, {
      pluginValidation: "skip",
      env: { HOME: "/tmp/openclaw-marker-free-validation" } as NodeJS.ProcessEnv,
    });
    expect(validation.ok).toBe(true);
    expect(validation.warnings.map((warning) => warning.path)).toEqual([
      "agents.entries.ops.workspace",
      "channels.telegram",
      "agents.defaults.heartbeat.agentId",
      "agents.defaults.systemAgent.agentId",
      "agents.defaults.authInheritance.agentId",
      "talk.agentId",
    ]);
  });

  it("treats the durable explicit-ownership generation as ownerless by design", () => {
    const raw = {
      agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
    };

    const migrated = migratePersistedImplicitMainRoster(raw);

    expect(migrated).toEqual({ config: raw, changed: false, diagnostics: [] });
    expect(tryGetLegacyDefaultAgentId(migrated.config as OpenClawConfig)).toBeUndefined();
  });

  it("preserves malformed explicit ownership values for schema rejection", () => {
    const raw = {
      agents: {
        defaults: { heartbeat: { agentId: 42 } },
        entries: { ops: { workspace: 42 }, research: {} },
      },
    };

    const migrated = migratePersistedImplicitMainRoster(raw);
    expect(
      (migrated.config as { agents?: { entries?: { ops?: { workspace?: unknown } } } }).agents
        ?.entries?.ops?.workspace,
    ).toBe(42);
    expect(
      (
        migrated.config as {
          agents?: { defaults?: { heartbeat?: { agentId?: unknown } } };
        }
      ).agents?.defaults?.heartbeat?.agentId,
    ).toBe(42);
    expect(validateConfigObjectRaw(migrated.config).ok).toBe(false);
  });

  it.each([
    ["runtime", validateConfigObjectWithPlugins],
    ["raw", validateConfigObjectRawWithPlugins],
  ] as const)(
    "uses the isolated env during %s plugin-aware roster migration",
    (_label, validate) => {
      const home = path.join("/tmp", "openclaw-isolated-validation-home");
      const result = validate(
        { agents: { entries: { ops: { default: true }, research: {} } } },
        {
          env: { HOME: home, OPENCLAW_STATE_DIR: path.join(home, "state") },
          pluginValidation: "skip",
        },
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.agents?.entries?.ops?.workspace).toBe(
          path.join(home, ".openclaw", "workspace"),
        );
      }
    },
  );

  it("binds an env-activated Discord channel before retiring a multi-agent marker", async () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "env-only-token");
    try {
      await withTempHome(async (home) => {
        const configPath = path.join(home, ".openclaw", "openclaw.json");
        await fs.mkdir(path.dirname(configPath), { recursive: true });
        await fs.writeFile(
          configPath,
          JSON.stringify({
            agents: { entries: { ops: { default: true }, research: {} } },
          }),
        );
        resetConfigRuntimeState();

        const snapshot = await readConfigFileSnapshot();

        expect(snapshot.config.bindings).toContainEqual({
          agentId: "ops",
          match: { channel: "discord", accountId: "*" },
        });
        expect(tryGetLegacyDefaultAgentId(snapshot.config)).toBe("ops");
        expect(
          resolveAgentRoute({
            cfg: snapshot.config,
            channel: "discord",
            accountId: "default",
            peer: { kind: "direct", id: "user-1" },
          }).agentId,
        ).toBe("ops");
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("binds a persisted-auth-only channel before retiring a marker-free owner", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, "state");
      await fs.mkdir(stateDir, { recursive: true });
      persistedAuthProbe.enabled = true;
      try {
        const result = validateConfigObjectWithPlugins(
          {
            agents: { entries: { ops: {}, research: {} } },
            channels: { whatsapp: { enabled: false } },
            plugins: { entries: { whatsapp: { enabled: true } } },
          },
          {
            env: {
              HOME: home,
              OPENCLAW_STATE_DIR: stateDir,
            } as NodeJS.ProcessEnv,
            pluginValidation: "skip",
          },
        );

        expect(result.ok).toBe(true);
        if (!result.ok) {
          return;
        }
        expect(result.config.bindings).toContainEqual({
          agentId: "ops",
          match: { channel: "whatsapp", accountId: "*" },
        });
        expect(tryGetLegacyDefaultAgentId(result.config)).toBe("ops");
      } finally {
        persistedAuthProbe.enabled = false;
      }
    });
  });

  it("materializes a sole legacy marker before preserving malformed siblings", () => {
    const migrated = migratePersistedImplicitMainRoster({
      agents: { entries: { ops: { default: true }, broken: null } },
    });
    expect(migrated.config).toMatchObject({
      agents: {
        defaults: {
          heartbeat: { agentId: "ops" },
          systemAgent: { agentId: "ops" },
        },
        entries: { ops: {}, broken: null },
      },
      talk: { agentId: "ops" },
    });
  });

  it("keeps marker-free entries and leaves wholly malformed maps unchanged", () => {
    expect(
      migratePersistedImplicitMainRoster({ agents: { entries: { invalid: null, ops: {} } } }),
    ).toEqual({
      config: { agents: { entries: { invalid: null, ops: {} } } },
      changed: false,
      diagnostics: [],
    });
    const malformed = { agents: { entries: { first: null, second: "invalid" } } };
    expect(migratePersistedImplicitMainRoster(malformed)).toEqual({
      config: malformed,
      changed: false,
      diagnostics: [],
    });
    const invalidMarker = { agents: { entries: { ops: { default: "yes" } } } };
    expect(migratePersistedImplicitMainRoster(invalidMarker)).toEqual({
      config: invalidMarker,
      changed: false,
      diagnostics: [],
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
        expect.objectContaining({ path: "agents.entries.ops" }),
      );
    });
  });
});
