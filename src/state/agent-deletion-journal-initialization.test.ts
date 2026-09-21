import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { prepareConfigFileWrite } from "../config/backup-rotation.js";
import { withDeferredPluginMigrationsCurrent } from "../infra/deferred-plugin-migrations.js";
import * as stateCoordinator from "../infra/state-database-coordinator.js";
import { discoverAgentDatabaseMigrationTargets } from "../infra/state-migrations.media-persistence-targets.js";
import { migrateLegacyMediaPersistence } from "../infra/state-migrations.media-persistence.js";
import { createLegacyDatabaseFixture } from "../infra/state-migrations.media-persistence.test-support.js";
import { closeOpenClawAgentDatabasesForTest } from "./openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  withOpenClawStateStartupMigrationCheckpointDatabase,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("agent deletion journal initialization", () => {
  it("captures checkpoint freshness after an earlier config publication obtains the state coordinator", async () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("journal-checkpoint-publication-") };
    const originalAgentPath = createLegacyDatabaseFixture({
      env,
      eventsBySession: {},
      schemaVersion: 19,
    });
    closeOpenClawStateDatabaseForTest();
    const statePath = resolveOpenClawStateSqlitePath(env);
    for (const suffix of ["", "-wal", "-shm"]) {
      fs.rmSync(statePath + suffix, { force: true });
    }
    const customPath = path.join(tempDirs.make("journal-checkpoint-custom-"), "history.sqlite");
    fs.renameSync(originalAgentPath, customPath);
    const bytes = fs.readFileSync(customPath);
    const configPath = path.join(env.OPENCLAW_STATE_DIR, "openclaw.json");
    fs.writeFileSync(configPath, "{}");
    const config = JSON.stringify({ session: { store: customPath } });
    await using preparedFile = await prepareConfigFileWrite({
      configPath,
      content: config,
      previousRaw: "{}",
      fsModule: fs,
    });
    const acquire = stateCoordinator.acquireStateDatabaseCoordinator;
    const publication = vi
      .spyOn(stateCoordinator, "acquireStateDatabaseCoordinator")
      .mockImplementationOnce((options) => {
        withDeferredPluginMigrationsCurrent({ env, expectedPending: [] }, () =>
          preparedFile.publish(),
        );
        return acquire(options);
      });
    try {
      const journal = withOpenClawStateStartupMigrationCheckpointDatabase(
        (database) =>
          database
            .prepare("SELECT name FROM sqlite_schema WHERE name = 'agent_deletion_journal'")
            .get(),
        { env },
      );
      expect(journal).toBeUndefined();
      expect(fs.readFileSync(configPath, "utf8")).toBe(config);
      expect(
        discoverAgentDatabaseMigrationTargets({
          env,
          configuredAgentDatabaseTargets: [{ agentId: "main", path: customPath }],
          registeredAgentDatabases: [],
        }).targets,
      ).toEqual([]);
      expect(fs.readFileSync(customPath)).toEqual(bytes);
    } finally {
      publication.mockRestore();
    }
  });

  it.each([
    "missing-table",
    "missing-database",
    "missing-database-canonical-custom",
    "missing-database-custom-store",
    "missing-database-config-include",
    "missing-database-session-store",
    "missing-database-acp-store",
  ])("preserves missing history across operations: %s", async (missing) => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("journal-existing-") };
    let agentPath = createLegacyDatabaseFixture({ env, eventsBySession: {}, schemaVersion: 19 });
    closeOpenClawStateDatabaseForTest();
    const statePath = resolveOpenClawStateSqlitePath(env);
    if (missing === "missing-table") {
      const db = new DatabaseSync(statePath);
      db.exec("DROP TABLE agent_deletion_journal");
      db.close();
    } else {
      for (const suffix of ["", "-wal", "-shm"]) {
        fs.rmSync(statePath + suffix, { force: true });
      }
    }
    if (missing === "missing-database-canonical-custom") {
      const customPath = path.join(path.dirname(agentPath), "history.sqlite");
      fs.renameSync(agentPath, customPath);
      agentPath = customPath;
    }
    if (
      missing === "missing-database-custom-store" ||
      missing === "missing-database-config-include" ||
      missing === "missing-database-session-store" ||
      missing === "missing-database-acp-store"
    ) {
      const agentDir = tempDirs.make("journal-custom-agent-");
      const customPath = path.join(
        agentDir,
        missing === "missing-database-acp-store"
          ? "history.archivist.sqlite"
          : missing === "missing-database-session-store"
            ? "history.main.sqlite"
            : "openclaw-agent.sqlite",
      );
      fs.renameSync(agentPath, customPath);
      agentPath = customPath;
      const configPath = path.join(env.OPENCLAW_STATE_DIR, "openclaw.json");
      if (missing === "missing-database-config-include") {
        fs.writeFileSync(
          configPath,
          JSON.stringify({
            env: { L1072_AGENT_DIR: agentDir },
            agents: { $include: "./agents.json5" },
          }),
        );
        fs.writeFileSync(
          path.join(env.OPENCLAW_STATE_DIR, "agents.json5"),
          "{ entries: { main: { agentDir: '${L1072_AGENT_DIR}' } } }",
        );
      } else {
        fs.writeFileSync(
          configPath,
          JSON.stringify(
            missing === "missing-database-acp-store"
              ? {
                  acp: { defaultAgent: "archivist" },
                  session: { store: path.join(agentDir, "history.{agentId}.sqlite") },
                }
              : missing === "missing-database-session-store"
                ? { session: { store: path.join(agentDir, "history.json") } }
                : { agents: { entries: { main: { agentDir } } } },
          ),
        );
      }
    }
    const bytes = fs.readFileSync(agentPath);
    for (let operation = 0; operation < 2; operation += 1) {
      const opened = openOpenClawStateDatabase({ env });
      expect(
        opened.db
          .prepare("SELECT name FROM sqlite_master WHERE name = 'agent_deletion_journal'")
          .get(),
      ).toBeUndefined();
      closeOpenClawStateDatabaseForTest();
      const discovery = discoverAgentDatabaseMigrationTargets({
        env,
        configuredAgentDatabaseTargets: [{ agentId: "main", path: agentPath }],
        registeredAgentDatabases: [],
      });
      expect(discovery.targets).toEqual([]);
      expect(discovery.warnings.join("\n")).toContain(
        "deletion journal missing; 1 store held back",
      );
      const migration = await migrateLegacyMediaPersistence({
        env,
        configuredAgentDatabaseTargets: [{ agentId: "main", path: agentPath }],
      });
      expect(migration.warningDisposition, JSON.stringify(migration)).toBe("recoverable");
      expect(migration.warnings.join("\n")).toContain("1 store held back");
      expect(fs.readFileSync(agentPath)).toEqual(bytes);
    }
  });

  it.each(["missing", "inline", "include-env"])(
    "creates a known-empty journal for fresh state (config: %s)",
    (configSource) => {
      const env = { OPENCLAW_STATE_DIR: tempDirs.make("journal-fresh-") };
      if (configSource !== "missing") {
        fs.writeFileSync(
          path.join(env.OPENCLAW_STATE_DIR, "openclaw.json"),
          configSource === "inline"
            ? "{ agents: { entries: { main: {} } } }"
            : JSON.stringify({
                env: { L1072_AGENT_DIR: path.join(env.OPENCLAW_STATE_DIR, "custom-agent") },
                agents: { $include: "./agents.json5" },
              }),
        );
        if (configSource === "include-env") {
          fs.writeFileSync(
            path.join(env.OPENCLAW_STATE_DIR, "agents.json5"),
            "{ entries: { main: { agentDir: '${L1072_AGENT_DIR}' } } }",
          );
        }
        fs.mkdirSync(path.join(env.OPENCLAW_STATE_DIR, "agents"));
        fs.writeFileSync(path.join(env.OPENCLAW_STATE_DIR, "agents", ".DS_Store"), "");
      }
      const opened = openOpenClawStateDatabase({ env });
      expect(
        opened.db.prepare("SELECT count(*) AS count FROM agent_deletion_journal").get(),
      ).toEqual({ count: 0 });
      const discovery = discoverAgentDatabaseMigrationTargets({
        env,
        configuredAgentDatabaseTargets: [],
        registeredAgentDatabases: [],
      });
      expect(discovery.warnings).toEqual([]);
      expect(discovery.retainedTargets).toEqual([]);
    },
  );

  it.each([
    "existing-empty-database",
    "shared-wal",
    "shared-shm",
    "shared-journal",
    "invalid-json5",
    "missing-include",
    "unresolved-storage-env",
    "unresolved-session-owner-env",
    "unresolved-roster-id-env",
    "unresolved-runtime-type-env",
    "invalid-roster",
    "invalid-agent-dir",
  ] as const)("does not infer empty deletion history from %s", (source) => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("journal-unknown-") };
    if (source === "existing-empty-database") {
      const pathname = resolveOpenClawStateSqlitePath(env);
      fs.mkdirSync(path.dirname(pathname));
      new DatabaseSync(pathname).close();
    } else if (source === "shared-wal" || source === "shared-shm" || source === "shared-journal") {
      const pathname = resolveOpenClawStateSqlitePath(env);
      fs.mkdirSync(path.dirname(pathname));
      const suffix = { "shared-wal": "-wal", "shared-shm": "-shm", "shared-journal": "-journal" }[
        source
      ];
      fs.writeFileSync(pathname + suffix, Buffer.alloc(64));
    } else {
      const config = {
        "invalid-json5": "{ agents:",
        "missing-include": "{ $include: './missing.json5' }",
        "unresolved-storage-env":
          "{ agents: { entries: { main: { agentDir: '${L1072_ABSENT_AGENT_DIR}' } } } }",
        "unresolved-session-owner-env":
          "{ acp: { defaultAgent: '${L1072_ABSENT_AGENT_ID}' }, session: { store: 'history.{agentId}.sqlite' } }",
        "unresolved-roster-id-env":
          "{ agents: { list: [{ id: '${L1072_ABSENT_AGENT_ID}' }] }, session: { store: 'history.{agentId}.sqlite' } }",
        "unresolved-runtime-type-env":
          "{ agents: { entries: { main: { runtime: { type: '${L1072_ABSENT_RUNTIME}', acp: { agent: 'archivist' } } } } }, session: { store: 'history.{agentId}.sqlite' } }",
        "invalid-roster": "{ agents: { entries: 'invalid' } }",
        "invalid-agent-dir": "{ agents: { entries: { main: { agentDir: 42 } } } }",
      }[source];
      fs.writeFileSync(path.join(env.OPENCLAW_STATE_DIR, "openclaw.json"), config);
    }
    for (let operation = 0; operation < 2; operation += 1) {
      const opened = openOpenClawStateDatabase({ env });
      expect(
        opened.db
          .prepare("SELECT name FROM sqlite_master WHERE name = 'agent_deletion_journal'")
          .get(),
      ).toBeUndefined();
      closeOpenClawStateDatabaseForTest();
    }
  });
});
