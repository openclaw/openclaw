import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { listPluginDoctorStateMigrationEntries } from "../plugins/doctor-contract-registry.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import {
  autoMigrateLegacyPluginDoctorState,
  runPostSessionPluginDoctorStateRepairs,
} from "./state-migrations.plugin-doctor.js";
import { resetAutoMigrateLegacyStateDirForTest } from "./state-migrations.state-dir.js";

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
        // The lease owner validates again after the callback returns. Model a lost
        // lease at that boundary, after migrations have already committed.
        if (controls.failSettlement) {
          throw new Error("lease settlement failed");
        }
        return result;
      })) satisfies typeof actual.withPluginLifecycleLease,
  };
});

const tempDirs = createTrackedTempDirs();

afterEach(async () => {
  controls.entries = [];
  controls.failSettlement = false;
  resetAutoMigrateLegacyStateDirForTest();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  await tempDirs.cleanup();
});

describe("plugin Doctor migrations", () => {
  it("requires explicit Doctor to repair shared schema before plugin migrations", async () => {
    const root = await tempDirs.make("openclaw-plugin-doctor-shared-schema-");
    const stateDir = path.join(root, ".openclaw");
    const env = { ...process.env, HOME: root, OPENCLAW_STATE_DIR: stateDir };
    const cfg = {};
    const stateDbPath = path.join(stateDir, "state", "openclaw.sqlite");
    fs.mkdirSync(path.dirname(stateDbPath), { recursive: true });
    const db = new DatabaseSync(stateDbPath);
    try {
      db.exec(`
        CREATE TABLE agent_databases (
          agent_id TEXT PRIMARY KEY,
          path TEXT NOT NULL,
          schema_version INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL,
          size_bytes INTEGER
        );
        INSERT INTO agent_databases VALUES ('main', 'agent.sqlite', 1, 10, 20);
      `);
    } finally {
      db.close();
    }
    const migrateLegacyState = vi.fn(() => ({
      changes: ["plugin state migrated"],
      warnings: [],
    }));
    controls.entries = [
      {
        pluginId: "memory-core",
        channelIds: [],
        migration: {
          id: "memory-core-test",
          label: "Memory Core test migration",
          detectLegacyState: () => ({ preview: ["plugin state"] }),
          migrateLegacyState,
        },
      },
    ];

    await expect(
      autoMigrateLegacyPluginDoctorState({ config: cfg, env, homedir: () => root }),
    ).rejects.toThrow("agent-databases-composite-primary-key");
    expect(migrateLegacyState).not.toHaveBeenCalled();
    const preserved = new DatabaseSync(stateDbPath, { readOnly: true });
    try {
      expect(preserved.prepare("SELECT * FROM agent_databases").all()).toEqual([
        {
          agent_id: "main",
          path: "agent.sqlite",
          schema_version: 1,
          last_seen_at: 10,
          size_bytes: 20,
        },
      ]);
    } finally {
      preserved.close();
    }

    const result = await autoMigrateLegacyPluginDoctorState({
      config: cfg,
      env,
      homedir: () => root,
      doctorOnlyStateMigrations: true,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toContain(
      "Migrated shared state agent database registry primary key → agent_id,path",
    );
    expect(result.changes).toContain("plugin state migrated");
    expect(migrateLegacyState).toHaveBeenCalledOnce();
  });
  it.each([
    {
      name: "reordered",
      actionIds: ["z-prepare", "a-finalize"],
      plannedActions: [
        { pluginId: "owner", id: "a-finalize" },
        { pluginId: "owner", id: "z-prepare" },
      ],
    },
    {
      name: "removed",
      actionIds: ["z-prepare", "a-finalize"],
      plannedActions: [{ pluginId: "owner", id: "z-prepare" }],
    },
    {
      name: "duplicated",
      actionIds: ["z-prepare", "z-prepare"],
      plannedActions: [
        { pluginId: "owner", id: "z-prepare" },
        { pluginId: "owner", id: "z-prepare" },
      ],
    },
  ])("refuses a genuinely $name action within one owner", async ({ actionIds, plannedActions }) => {
    const root = await tempDirs.make("openclaw-plugin-doctor-order-guard-");
    const env = {
      ...process.env,
      HOME: root,
      OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
      OPENCLAW_STATE_DIR: root,
    };
    const observed: string[] = [];
    controls.entries = actionIds.map((id) => ({
      pluginId: "owner",
      channelIds: [],
      trustedForDurableStores: false,
      migration: {
        id,
        label: id,
        phase: "after-session-repair" as const,
        detectLegacyState: () => {
          observed.push(`detect ${id}`);
          return { preview: ["pending"] };
        },
        migrateLegacyState: () => {
          observed.push(`migrate ${id}`);
          return { changes: [`migrated ${id}`], warnings: [] };
        },
      },
    }));

    await expect(
      runPostSessionPluginDoctorStateRepairs({
        config: {},
        env,
        maintenanceAuthority: { assertCurrent() {} },
        plannedActions,
      }),
    ).resolves.toEqual({
      changes: [],
      completedPluginIds: undefined,
      requiredPluginIds: ["owner"],
      warnings: [expect.stringContaining("immutable action order")],
      warningDisposition: undefined,
    });
    expect(observed).toEqual([]);
  });

  it.each(["none", "later-action", "later-warning", "detector", "lease-settlement"] as const)(
    "preserves completed mutations and replay truth when failure is %s",
    async (failure) => {
      const root = await tempDirs.make("openclaw-plugin-doctor-settlement-");
      const env = {
        ...process.env,
        HOME: root,
        OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
        OPENCLAW_STATE_DIR: root,
      };
      const markers = [path.join(root, "first"), path.join(root, "second")] as const;
      controls.failSettlement = failure === "lease-settlement";
      controls.entries = markers.map((marker, index) => ({
        pluginId: "settlement-owner",
        channelIds: [],
        trustedForDurableStores: false,
        migration: {
          id: `action-${index}`,
          label: `Action ${index}`,
          phase: "after-session-repair",
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
        },
      }));
      const params = {
        config: {},
        env,
        maintenanceAuthority: { assertCurrent() {} },
        plannedActions: controls.entries.map(({ pluginId, migration }) => ({
          pluginId,
          id: migration.id,
        })),
      };

      const first = await runPostSessionPluginDoctorStateRepairs(params);

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
        expect(first.warnings.join("\n")).toContain(
          failure === "later-action"
            ? "second action failed"
            : failure === "later-warning"
              ? "refusal"
              : failure === "detector"
                ? "second detector failed"
                : "lease settlement failed",
        );
      }

      const replay = await runPostSessionPluginDoctorStateRepairs(params);
      expect(replay.requiredPluginIds).toEqual(["settlement-owner"]);
      expect(replay.completedPluginIds).toEqual(
        failure === "none" || failure === "later-warning" ? ["settlement-owner"] : undefined,
      );
      expect(replay.changes).toEqual([]);
      expect(fs.readFileSync(markers[0], "utf8")).toBe("committed");
    },
  );
});
