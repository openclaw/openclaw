import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import type { listPluginDoctorStateMigrationEntries } from "../plugins/doctor-contract-registry.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createOpenClawStateLeaseLostError } from "../state/openclaw-state-lease-error.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import {
  autoMigrateLegacyPluginDoctorState,
  runPluginDoctorStateMigrationPlans,
  runPostSessionPluginDoctorStateRepairs as repairPluginState,
} from "./state-migrations.plugin-doctor.js";

const controls = vi.hoisted(() => ({
  entries: [] as ReturnType<typeof listPluginDoctorStateMigrationEntries>,
  failSettlement: false,
}));

vi.mock("../plugins/doctor-contract-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/doctor-contract-registry.js")>()),
  listPluginDoctorStateMigrationEntries: () => controls.entries,
}));

vi.mock("../plugins/plugin-lifecycle-lease.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/plugin-lifecycle-lease.js")>();
  return {
    ...actual,
    withPluginLifecycleLease: ((options, run) =>
      actual.withPluginLifecycleLease(options, async (lease) => {
        const result = await run(lease);
        // Fail settlement after the callback's mutations committed.
        if (controls.failSettlement) {
          throw createOpenClawStateLeaseLostError(
            {
              scope: "core:agent-database-maintenance",
              key: "global",
              leaseLabel: "agent database maintenance lease",
            },
            new Error("lease expired or ownership lost"),
          );
        }
        return result;
      })) satisfies typeof actual.withPluginLifecycleLease,
  };
});

const tempDirs = createTrackedTempDirs();

type Entry = ReturnType<typeof listPluginDoctorStateMigrationEntries>[number];
type Migration = Pick<Entry["migration"], "detectLegacyState"> &
  Partial<Omit<Entry["migration"], "id" | "detectLegacyState">>;
const unchanged = () => ({ changes: [], warnings: [] });
function entry(pluginId: string, id: string, migration: Migration): Entry {
  return {
    pluginId,
    channelIds: [],
    migration: { id, label: id, migrateLegacyState: unchanged, ...migration },
  };
}
function postEntry(pluginId: string, id: string, migration: Migration): Entry {
  return {
    ...entry(pluginId, id, { phase: "after-session-repair", ...migration }),
    trustedForDurableStores: false,
  };
}
function repairParams(env: NodeJS.ProcessEnv) {
  return { config: {}, env, maintenanceAuthority: { assertCurrent() {} } };
}
async function repairEnv() {
  const root = await tempDirs.make("openclaw-plugin-doctor-");
  return {
    ...process.env,
    HOME: root,
    OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
    OPENCLAW_STATE_DIR: root,
  };
}
const plannedActions = () =>
  controls.entries.map(({ pluginId, migration }) => ({ pluginId, id: migration.id }));

afterEach(async () => {
  controls.entries = [];
  controls.failSettlement = false;
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  await tempDirs.cleanup();
});

it.each(["postgres", "sqlite"] as const)(
  "gates legacy imports and replay for %s",
  async (engine) => {
    const skipped = engine === "postgres";
    const stateDir = await tempDirs.make("openclaw-doctor-sqlite-only-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    let imported = false;
    const detectLegacyState = vi.fn(() => (imported ? null : { preview: ["legacy"] }));
    const migrateLegacyState = vi.fn(() => {
      imported = true;
      return { changes: ["imported"], warnings: [] };
    });
    const undeclaredDetector = vi.fn(() => null);
    controls.entries = [
      entry("legacy-owner", "legacy-import", {
        label: "Legacy import",
        sqliteOnly: { family: "state", postgresNote: "Preserve the source." },
        detectLegacyState,
        migrateLegacyState,
      }),
      entry("unrestricted-owner", "ordinary-repair", {
        detectLegacyState: undeclaredDetector,
      }),
    ];
    const params = {
      detected: { stateDir, oauthDir: stateDir, doctorOnlyStateMigrations: true },
      config: { database: { engine } },
      env,
      plannedActions: plannedActions(),
    };
    const first = await runPluginDoctorStateMigrationPlans(params);
    const replay = await runPluginDoctorStateMigrationPlans(params);

    expect(first).toMatchObject({ warnings: [], changes: skipped ? [] : ["imported"] });
    expect(replay).toMatchObject({ warnings: [], changes: [] });
    expect(migrateLegacyState).toHaveBeenCalledTimes(skipped ? 0 : 1);
    if (skipped) {
      expect(detectLegacyState).not.toHaveBeenCalled();
    }
    expect(undeclaredDetector).toHaveBeenCalled();
    expect(first.notices).toEqual(
      skipped ? [expect.stringContaining("Preserve the source.")] : undefined,
    );
    expect(replay.notices).toEqual(first.notices);
    expect(replay.completedPluginIds).toEqual(["legacy-owner", "unrestricted-owner"]);
  },
);

it("refuses pre-July shared schema before plugin migrations", async () => {
  const root = await tempDirs.make("openclaw-plugin-doctor-shared-schema-");
  const stateDir = path.join(root, ".openclaw");
  const env = { ...process.env, HOME: root, OPENCLAW_STATE_DIR: stateDir };
  const stateDbPath = path.join(stateDir, "state", "openclaw.sqlite");
  fs.mkdirSync(path.dirname(stateDbPath), { recursive: true });
  {
    using db = new DatabaseSync(stateDbPath);
    db.exec(`CREATE TABLE agent_databases (
      agent_id TEXT PRIMARY KEY, path TEXT NOT NULL, schema_version INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL, size_bytes INTEGER);
      INSERT INTO agent_databases VALUES ('main', 'agent.sqlite', 1, 10, 20);`);
  }
  const migrateLegacyState = vi.fn(unchanged);
  controls.entries = [
    entry("memory-core", "memory-core-test", {
      detectLegacyState: () => ({ preview: ["plugin state"] }),
      migrateLegacyState,
    }),
  ];

  const params = { config: {}, env, homedir: () => root };
  await expect(autoMigrateLegacyPluginDoctorState(params)).rejects.toThrow(
    "unsupported agent database registry schema",
  );
  expect(migrateLegacyState).not.toHaveBeenCalled();
  {
    using preserved = new DatabaseSync(stateDbPath, { readOnly: true });
    expect(preserved.prepare("SELECT * FROM agent_databases").all()).toEqual([
      {
        agent_id: "main",
        path: "agent.sqlite",
        schema_version: 1,
        last_seen_at: 10,
        size_bytes: 20,
      },
    ]);
  }

  const result = await autoMigrateLegacyPluginDoctorState({
    ...params,
    doctorOnlyStateMigrations: true,
  });

  expect(result.warnings).toEqual([
    expect.stringContaining("unsupported agent database registry schema"),
  ]);
  expect(result.changes).toEqual([]);
  expect(migrateLegacyState).not.toHaveBeenCalled();
});
it.each([
  ["reordered", ["z-prepare", "a-finalize"], ["a-finalize", "z-prepare"]],
  ["removed", ["z-prepare", "a-finalize"], ["z-prepare"]],
  ["duplicated", ["z-prepare", "z-prepare"], ["z-prepare", "z-prepare"]],
] as const)(
  "refuses a genuinely %s action within one owner",
  async (_name, actionIds, plannedIds) => {
    const env = await repairEnv();
    const detect = vi.fn(() => ({ preview: ["pending"] }));
    const migrate = vi.fn(unchanged);
    controls.entries = actionIds.map((id) =>
      postEntry("owner", id, {
        detectLegacyState: detect,
        migrateLegacyState: migrate,
      }),
    );

    await expect(
      repairPluginState({
        ...repairParams(env),
        plannedActions: plannedIds.map((id) => ({ pluginId: "owner", id })),
      }),
    ).resolves.toEqual({
      changes: [],
      completedPluginIds: undefined,
      requiredPluginIds: ["owner"],
      warnings: [expect.stringContaining("immutable action order")],
      warningDisposition: undefined,
    });
    expect(detect).not.toHaveBeenCalled();
    expect(migrate).not.toHaveBeenCalled();
  },
);

it.each([
  ["none", undefined],
  ["later-action", "second action failed"],
  ["later-warning", "refusal"],
  ["detector", "second detector failed"],
  ["lease-settlement", "lease expired or ownership lost"],
] as const)(
  "preserves completed mutations and replay truth when failure is %s",
  async (failure, message) => {
    const env = await repairEnv();
    const root = env.OPENCLAW_STATE_DIR;
    const markers = [path.join(root, "first"), path.join(root, "second")] as const;
    controls.failSettlement = failure === "lease-settlement";
    controls.entries = markers.map((marker, index) =>
      postEntry("settlement-owner", `action-${index}`, {
        label: `Action ${index}`,
        detectLegacyState: () => {
          if (failure === "detector" && index === 1) {
            throw new Error("second detector failed");
          }
          return fs.existsSync(marker) ? null : { preview: ["pending"] };
        },
        migrateLegacyState: () => {
          if (failure === "later-action" && index === 1) {
            throw new Error("second action failed");
          }
          fs.writeFileSync(marker, "committed");
          return {
            changes: [`committed action ${index}`],
            warnings: index === 0 ? ["advisory"] : failure === "later-warning" ? ["refusal"] : [],
            ...(index === 0 ? { warningDisposition: "recoverable" as const } : {}),
          };
        },
      }),
    );
    const params = {
      ...repairParams(env),
      plannedActions: plannedActions(),
      // Replay certification needs a consumer; model the session owner's settlement hook.
      beforeCompletion: async () => {},
    };

    const first = await repairPluginState(params);

    expect(first.requiredPluginIds).toEqual(["settlement-owner"]);
    expect(first.completedPluginIds).toBeUndefined();
    expect(fs.readFileSync(markers[0], "utf8")).toBe("committed");
    expect(fs.existsSync(markers[1])).toBe(!["later-action", "detector"].includes(failure));
    expect(first.changes).toEqual(
      ["later-action", "detector"].includes(failure)
        ? ["committed action 0"]
        : ["committed action 0", "committed action 1"],
    );
    if (failure === "none") {
      expect(first.warnings).toEqual(["advisory"]);
      expect(first.warningDisposition).toBe("recoverable");
    } else {
      expect(first.warningDisposition).toBeUndefined();
      expect(first.warnings.join("\n")).toContain(message);
    }

    const replay = await repairPluginState(params);
    expect(replay).toMatchObject({ requiredPluginIds: ["settlement-owner"], changes: [] });
    expect(replay.completedPluginIds).toEqual(
      failure === "none" || failure === "later-warning" ? ["settlement-owner"] : undefined,
    );
    expect(fs.readFileSync(markers[0], "utf8")).toBe("committed");
  },
);

it("runs default-phase detectors only when completion certification has a consumer", async () => {
  const env = await repairEnv();
  const detected: string[] = [];
  controls.entries = (["default", "after-session-repair"] as const).map((phase) =>
    Object.assign(
      entry("owner", `${phase}-action`, {
        ...(phase === "after-session-repair" ? { phase } : {}),
        detectLegacyState: () => {
          detected.push(phase);
          return null;
        },
      }),
      { trustedForDurableStores: false },
    ),
  );
  const params = repairParams(env);

  // Nothing deferred and no retained sources: the fresh-install shape.
  const uncertified = await repairPluginState(params);

  expect(detected).toEqual(["after-session-repair"]);
  expect(uncertified).toEqual({
    changes: [],
    completedPluginIds: undefined,
    requiredPluginIds: ["owner"],
    warnings: [],
  });

  const certified = await repairPluginState({
    ...params,
    beforeCompletion: async () => {},
  });

  expect(detected).toEqual(["after-session-repair", "after-session-repair", "default"]);
  expect(certified.completedPluginIds).toEqual(["owner"]);
});
