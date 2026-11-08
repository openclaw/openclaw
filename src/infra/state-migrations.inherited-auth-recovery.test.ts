import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as ownership from "../agents/auth-profiles/path-resolve.js";
import { resolveSharedMainAuthAgentDir } from "../agents/auth-profiles/shared-main-dir.js";
import { inspectSharedAuthLegacyRowsReadOnly } from "../agents/auth-profiles/shared-store-bootstrap.js";
import * as sqlite from "../agents/auth-profiles/sqlite.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import { completeAgentDeletionJournalInDatabase } from "../state/agent-deletion-journal.js";
import * as agentDb from "../state/openclaw-agent-db.js";
import * as stateDb from "../state/openclaw-state-db.js";
import { beginAgentDeletionJournal } from "../test-utils/agent-deletion-journal.js";
import * as doctor from "./state-migrations.doctor.js";
import * as migration from "./state-migrations.shared-auth-store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  vi.restoreAllMocks();
  sqlite.closeAuthProfileReadPool();
  await agentDb.closeOpenClawAgentDatabasesAsync();
  agentDb.closeOpenClawAgentDatabasesForTest();
  await stateDb.closeOpenClawStateDatabaseAsync();
  stateDb.closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

function makeStore(id: string) {
  return {
    version: 1,
    profiles: { [id]: { type: "api_key" as const, provider: "openai", key: "synthetic-key" } },
  };
}

async function createFixture() {
  const stateDir = fs.realpathSync.native(tempDirs.make("inherited-auth-recovery-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_AGENT_DIR", "");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_AGENT_DIR: undefined };
  const ownerDir = path.join(stateDir, "agents/ops/agent");
  const sourcePath = path.join(ownerDir, "openclaw-agent.sqlite");
  const store = makeStore("openai:owner");
  const runtimeState = { version: 1, order: { openai: ["openai:owner"] } };
  sqlite.writePersistedAuthProfileStoreRaw(store, ownerDir);
  sqlite.writePersistedAuthProfileStateRaw(runtimeState, ownerDir);
  const config: OpenClawConfig = {
    agents: { defaults: { authInheritance: { agentId: "ops" } }, entries: { ops: {} } },
    plugins: { enabled: false },
  };
  const detect = async () =>
    (
      await doctor.detectLegacyStateMigrations({
        cfg: config,
        env,
        doctorOnlyStateMigrations: true,
        pluginSessionStoreAgentIds: [],
        legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
      })
    ).sharedAuthStore;
  const detected = await detect();
  expect(detected).toMatchObject({ ownerId: "ops", sourcePath, hasLegacy: true });
  return { stateDir, env, ownerDir, sourcePath, store, runtimeState, detect, detected };
}

function readReceipts(env: NodeJS.ProcessEnv) {
  return stateDb
    .openOpenClawStateDatabase({ env })
    .db.prepare(
      "SELECT source_key, source_path, source_sha256, source_record_count, status, removed_source FROM migration_sources WHERE migration_kind = 'shared-auth-store-state-db' ORDER BY target_table",
    )
    .all();
}

describe("Doctor inherited auth recovery", () => {
  it.each(["copied", "ownership-flipped", "cleaned"] as const)(
    "resumes the non-main source receipt after %s without consuming private main rows",
    async (stage) => {
      const fixture = await createFixture();
      const originalRows = inspectSharedAuthLegacyRowsReadOnly(fixture.sourcePath);
      const stateWrite = stateDb.runOpenClawStateWriteTransaction;
      const agentWrite = agentDb.runOpenClawAgentWriteTransaction;
      const stateFailure = vi
        .spyOn(stateDb, "runOpenClawStateWriteTransaction")
        .mockImplementation((callback, options, transaction) => {
          if (
            transaction?.operationLabel ===
            (stage === "copied"
              ? "state-migration.shared-auth-ownership"
              : "state-migration.shared-auth-finalize")
          ) {
            throw new Error("synthetic interrupted relocation");
          }
          return stateWrite(callback, options, transaction);
        });
      const agentFailure = vi
        .spyOn(agentDb, "runOpenClawAgentWriteTransaction")
        .mockImplementation((callback, options, transaction) => {
          if (
            stage === "ownership-flipped" &&
            transaction?.operationLabel === "state-migration.shared-auth-cleanup"
          ) {
            throw new Error("synthetic interrupted relocation");
          }
          return agentWrite(callback, options, transaction);
        });
      const interrupted = await migration.migrateSharedAuthStore(fixture);
      expect(interrupted.warnings).toEqual([
        expect.stringContaining("synthetic interrupted relocation"),
      ]);
      stateFailure.mockRestore();
      agentFailure.mockRestore();
      const expectedReceipts = ["auth_profile_state", "auth_profile_store"].map((table) => ({
        source_key:
          "shared-auth-store:" +
          createHash("sha256")
            .update(path.resolve(fixture.sourcePath))
            .update("\0")
            .update(table)
            .digest("hex"),
        source_path: fixture.sourcePath,
        source_sha256: createHash("sha256")
          .update(
            JSON.stringify(
              table === "auth_profile_state" ? originalRows.state : originalRows.store,
            ),
          )
          .digest("hex"),
        source_record_count: 1,
        status: stage === "copied" ? "copied" : "ownership-flipped",
        removed_source: 0,
      }));
      expect(readReceipts(fixture.env)).toEqual(expectedReceipts);
      expect(inspectSharedAuthLegacyRowsReadOnly(fixture.sourcePath)).toEqual(
        stage === "cleaned" ? { store: null, state: null } : originalRows,
      );
      const privateMain = makeStore("openai:private-main");
      const mainDir = resolveSharedMainAuthAgentDir(fixture.env);
      if (stage !== "copied") {
        sqlite.writePersistedAuthProfileStoreRaw(privateMain, mainDir);
      }
      const targetStore =
        stage === "cleaned"
          ? {
              ...fixture.store,
              profiles: { ...fixture.store.profiles, ...makeStore("openai:target-only").profiles },
            }
          : fixture.store;
      if (stage === "cleaned") {
        stateDb.runOpenClawStateWriteTransaction(
          ({ db }) => {
            db.prepare(
              "UPDATE config_machine_state SET value_json = ? WHERE state_key = 'authProfiles.store'",
            ).run(JSON.stringify(targetStore));
          },
          { env: fixture.env },
        );
      }
      // Reopen the durable state: recovery must not depend on the failed invocation's handles.
      await agentDb.closeOpenClawAgentDatabasesAsync();
      await stateDb.closeOpenClawStateDatabaseAsync();
      const resumed = await fixture.detect();
      expect(resumed).toMatchObject({
        ownerId: "ops",
        sourcePath: fixture.sourcePath,
        hasLegacy: true,
      });
      const result = await migration.migrateSharedAuthStore({ ...fixture, detected: resumed });
      expect(result.warnings).toEqual([]);
      expect(result.notices).toBeUndefined();
      expect(sqlite.readPersistedSharedAuthProfileStoreRaw(fixture.env)).toEqual(targetStore);
      expect(sqlite.readPersistedSharedAuthProfileStateRaw(fixture.env)).toEqual(
        fixture.runtimeState,
      );
      expect(inspectSharedAuthLegacyRowsReadOnly(fixture.sourcePath)).toEqual({
        store: null,
        state: null,
      });
      if (stage !== "copied") {
        expect(sqlite.readPersistedAuthProfileStoreRaw(mainDir)).toEqual(privateMain);
      }
      for (const receipt of expectedReceipts) {
        receipt.status = "completed";
        receipt.removed_source = 1;
      }
      expect(readReceipts(fixture.env)).toEqual(expectedReceipts);
      expect(ownership.resolveSharedAuthStoreOwnership(fixture.env)).toEqual({
        location: "state-db",
      });
      const settled = await fixture.detect();
      expect(settled.hasLegacy).toBe(false);
      expect(await migration.migrateSharedAuthStore({ ...fixture, detected: settled })).toEqual({
        changes: [],
        warnings: [],
      });
    },
  );

  it.each(["deletion", "main conflict"] as const)(
    "preserves the non-main source when %s appears during the awaited snapshot close",
    async (change) => {
      const fixture = await createFixture();
      const originalRows = inspectSharedAuthLegacyRowsReadOnly(fixture.sourcePath);
      const close = agentDb.closeOpenClawAgentDatabaseByPathAsync;
      let injected = false;
      const closeHook = vi
        .spyOn(agentDb, "closeOpenClawAgentDatabaseByPathAsync")
        .mockImplementation(async (databasePath, expectedAgentId) => {
          const closed = await close(databasePath, expectedAgentId);
          if (databasePath !== fixture.sourcePath || injected) {
            return closed;
          }
          injected = true;
          if (change === "deletion") {
            beginAgentDeletionJournal(
              {
                agentId: "ops",
                operationId: "delete-during-auth-snapshot",
                agentDir: fixture.ownerDir,
                workspaceDir: path.join(fixture.stateDir, "workspace-ops"),
                sessionsDir: path.join(fixture.stateDir, "agents/ops/sessions"),
                deleteFiles: false,
              },
              { env: fixture.env },
            );
            stateDb.runOpenClawStateWriteTransaction(
              (database) =>
                completeAgentDeletionJournalInDatabase(
                  database,
                  "ops",
                  "delete-during-auth-snapshot",
                ),
              { env: fixture.env },
            );
          } else {
            sqlite.writePersistedAuthProfileStoreRaw(
              makeStore("openai:main-conflict"),
              resolveSharedMainAuthAgentDir(fixture.env),
            );
          }
          return closed;
        });
      const result = await migration.migrateSharedAuthStore(fixture);
      closeHook.mockRestore();
      expect(injected).toBe(true);
      expect(result).toMatchObject({
        changes: [],
        outcome: "skipped",
        warningDisposition: "recoverable",
      });
      expect(result.warnings).toEqual([
        expect.stringContaining(
          change === "deletion" ? "held for agent ops" : "main also stores credentials",
        ),
      ]);
      expect(inspectSharedAuthLegacyRowsReadOnly(fixture.sourcePath)).toEqual(originalRows);
      expect(ownership.resolveSharedAuthStoreOwnership(fixture.env)).toEqual({
        location: "legacy-main",
      });
      expect(readReceipts(fixture.env)).toEqual([]);
      expect(
        stateDb
          .openOpenClawStateDatabase({ env: fixture.env })
          .db.prepare(
            "SELECT state_key FROM config_machine_state WHERE state_key IN ('auth.sharedStore', 'authProfiles.store', 'authProfiles.state')",
          )
          .all(),
      ).toEqual([]);
      if (change === "main conflict") {
        expect(
          sqlite.readPersistedAuthProfileStoreRaw(resolveSharedMainAuthAgentDir(fixture.env)),
        ).toEqual(makeStore("openai:main-conflict"));
      }
    },
  );
});
