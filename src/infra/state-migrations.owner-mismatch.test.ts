import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { assertDoctorPreflightMigrationsComplete } from "../commands/doctor-config-preflight-migrations.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import {
  OPENCLAW_AGENT_SCHEMA_VERSION,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { assertOpenClawDatabasesReady } from "../state/openclaw-database-preflight.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { autoMigrateLegacyState } from "./state-migrations.doctor.js";
import * as migrationTargets from "./state-migrations.media-persistence-targets.js";
import { migrateLegacyMediaPersistence } from "./state-migrations.media-persistence.js";
import {
  createEvent,
  createLegacyDatabaseFixture,
  readDatabaseSnapshot,
  writeArchive,
} from "./state-migrations.media-persistence.test-support.js";
import { throwIfDoctorStateMigrationRefused } from "./state-migrations.messages.js";

afterEach(() => vi.restoreAllMocks());

function mutateDatabase(target: string, sql: string, ...values: SQLInputValue[]) {
  const database = new DatabaseSync(target);
  try {
    database.prepare(sql).run(...values);
  } finally {
    database.close();
  }
}

async function copiedOwnerFixture(
  state: OpenClawTestState,
  eventsBySession: Parameters<typeof createLegacyDatabaseFixture>[0]["eventsBySession"] = {},
) {
  const cfg = { agents: { entries: { main: {}, cleaner: {} } } };
  await state.writeConfig(cfg);
  const source = createLegacyDatabaseFixture({ env: state.env, eventsBySession });
  const target = state.statePath("agents", "cleaner", "agent", "openclaw-agent.sqlite");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  const run = () =>
    autoMigrateLegacyState({
      cfg,
      doctorOnlyStateMigrations: true,
      env: state.env,
      homedir: () => state.home,
      legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
    });
  return { cfg, source, target, run };
}

it("retains archives beside a refused database", async () => {
  await withOpenClawTestState({ prefix: "openclaw shared archives " }, async (state) => {
    const source = createLegacyDatabaseFixture({ env: state.env, eventsBySession: {} });
    const healthy = createLegacyDatabaseFixture({
      agentId: "healthy",
      env: state.env,
      eventsBySession: {},
    });
    const directory = state.statePath("custom stores");
    const target = path.join(directory, "cleaner.sqlite");
    const healthyPath = path.join(directory, "healthy.sqlite");
    fs.mkdirSync(directory, { recursive: true });
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    fs.renameSync(healthy, healthyPath);
    mutateDatabase(target, "UPDATE schema_meta SET updated_at = updated_at + 1");
    const original = fs.readFileSync(target);
    const archivePath = path.join(directory, "history.jsonl.deleted.2026-09-10T01-02-03.000Z");
    writeArchive(
      archivePath,
      [
        createEvent({
          id: "event-1",
          parentId: null,
          timestamp: 1,
          message: { role: "user", MediaPath: "/media/fixture.png", MediaType: "image/png" },
        }),
      ],
      false,
    );
    const archiveBytes = fs.readFileSync(archivePath);

    const result = await migrateLegacyMediaPersistence({
      env: state.env,
      configuredAgentDatabaseTargets: [
        { agentId: "healthy", path: healthyPath },
        { agentId: "cleaner", path: target },
      ],
    });

    expect(result.refusedAgentDatabasePaths).toEqual([target]);
    expect(readDatabaseSnapshot(healthyPath).version.user_version).toBe(
      OPENCLAW_AGENT_SCHEMA_VERSION,
    );
    expect(fs.readFileSync(target).equals(original)).toBe(true);

    expect(fs.readFileSync(archivePath)).toEqual(archiveBytes);
  });
});

it("recovers identical wrong-owner copies despite short reads", async () => {
  await withOpenClawTestState({ prefix: "openclaw owner mismatch " }, async (state) => {
    const { cfg, source, target, run } = await copiedOwnerFixture(state);
    const original = fs.readFileSync(source);
    expect(fs.readFileSync(target).equals(original)).toBe(true);
    const discovery = vi.spyOn(migrationTargets, "resolveAgentDatabaseMigrationTargets");
    const files = [
      { identity: fs.statSync(source), maxBytes: 8191, shortReads: 0 },
      { identity: fs.statSync(target), maxBytes: 4093, shortReads: 0 },
    ];
    const read = fs.readSync.bind(fs);
    const reads = vi
      .spyOn(fs, "readSync")
      .mockImplementation(
        (
          descriptor: number,
          buffer: NodeJS.ArrayBufferView,
          offsetOrOptions: number | fs.ReadOptions = {},
          length?: number,
          position?: fs.ReadPosition | null,
        ) => {
          const options =
            typeof offsetOrOptions === "number"
              ? { offset: offsetOrOptions, length, position }
              : offsetOrOptions;
          const opened = fs.fstatSync(descriptor);
          const file = files.find(
            ({ identity }) => identity.dev === opened.dev && identity.ino === opened.ino,
          );
          const requested = options.length ?? buffer.byteLength - (options.offset ?? 0);
          if (file && file.shortReads === 0 && requested > file.maxBytes) {
            file.shortReads += 1;
            return read(descriptor, buffer, { ...options, length: file.maxBytes });
          }
          return read(descriptor, buffer, options);
        },
      );

    const result = await run();
    reads.mockRestore();

    expect(files.every((file) => file.shortReads === 1)).toBe(true);
    expect(result.warnings.join("\n")).toContain("cleaner");
    expect(discovery).toHaveBeenCalledTimes(1);
    expect(result.stepReceipts.find((receipt) => receipt.id === "media-persistence")).toMatchObject(
      {
        recoveredAgentDatabasePaths: [target],
      },
    );
    expect(() => throwIfDoctorStateMigrationRefused(result.stepReceipts)).not.toThrow();
    const copies = fs
      .readdirSync(path.dirname(target))
      .filter((file) => file.startsWith("openclaw-agent.sqlite.corrupt-"));
    expect(copies).toHaveLength(1);
    expect(fs.readFileSync(path.join(path.dirname(target), copies[0]!))).toEqual(original);
    expect(result.warnings.join("\n")).toContain(copies[0]);
    const fresh = openOpenClawAgentDatabase({ agentId: "cleaner", env: state.env });
    const sql =
      "SELECT agent_id, (SELECT COUNT(*) FROM transcript_events) AS count FROM schema_meta WHERE meta_key = 'primary'";
    expect(fresh.db.prepare(sql).get()).toMatchObject({ agent_id: "cleaner", count: 0 });
    await expect(
      assertOpenClawDatabasesReady({ env: state.env, operation: "gateway-startup", config: cfg }),
    ).resolves.toBeUndefined();
  });
});

it("runs independent repairs while refusing divergent copies", async () => {
  await withOpenClawTestState({ prefix: "openclaw divergent owner " }, async (state) => {
    const event = { type: "message", id: "shared", timestamp: 1, message: { role: "user" } };
    const { cfg, target, run } = await copiedOwnerFixture(state, {
      history: [event],
    });
    mutateDatabase(
      target,
      "UPDATE transcript_events SET event_json = ? WHERE session_id = 'history'",
      JSON.stringify({
        ...event,
        message: { ...event.message, content: "History present only in the misplaced copy." },
      }),
    );
    const original = fs.readFileSync(target);
    const execPath = await state.writeJson("exec-approvals.json", {
      version: 1,
      defaults: { security: "allowlist", ask: "on-miss" },
      agents: {},
    });
    const result = await run();

    expect(fs.existsSync(execPath)).toBe(false);
    expect(
      openOpenClawStateDatabase({ env: state.env })
        .db.prepare(
          "SELECT default_security FROM exec_approvals_config WHERE config_key = 'current'",
        )
        .get()?.default_security,
    ).toBe("allowlist");
    expect(fs.readFileSync(target).equals(original)).toBe(true);
    const receipts = Object.fromEntries(
      result.stepReceipts.map((receipt) => [receipt.id, receipt]),
    );
    const blocked = {
      outcome: "refused",
      changes: [],
      refusal: { code: "blocked-by-agent-database-refusal" },
    };
    expect(receipts).toMatchObject({
      "media-persistence": {
        outcome: "refused",
        refusal: { code: "agent-database-ownership-mismatch" },
      },
      "transcript-directives": blocked,
      "plugin-doctor-post-session-state": blocked,
    });
    expect(
      result.stepReceipts.flatMap((receipt) => receipt.recoveredAgentDatabasePaths ?? []),
    ).toEqual([]);
    expect(result.postSessionPluginMigration).toBeUndefined();
    const warning = result.warnings.join("\n");
    expect(warning).toContain(target);
    expect(warning).toContain("belongs to agent main");
    expect(warning).toContain("quarantine move");
    expect(warning).toContain(".corrupt-");
    expect(warning).toContain("openclaw doctor --fix");
    expect(() => throwIfDoctorStateMigrationRefused(result.stepReceipts)).toThrow(
      "Independent state repairs were run",
    );
    await expect(
      assertDoctorPreflightMigrationsComplete({
        cfg,
        stepReceipts: result.stepReceipts,
        report: () => {},
      }),
    ).resolves.toBeUndefined();
    expect(result.stepReceipts.find((receipt) => receipt.id === "media-persistence")?.outcome).toBe(
      "warning",
    );
    expect(fs.readFileSync(target).equals(original)).toBe(true);
  });
});
