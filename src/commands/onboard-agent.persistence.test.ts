import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  prepareSystemAgentRunAdmission,
  resolveAdmittedRunActiveAssertion,
} from "../agents/admitted-run-context.js";
import {
  readConfigFileSnapshot,
  replaceConfigFile,
  resetConfigRuntimeState,
} from "../config/config.js";
import { migrateLegacyMainSessionKeys } from "../config/sessions/legacy-main-session-migration.js";
import { readExactSessionEntryRowForCanonicalRepair } from "../config/sessions/session-accessor.sqlite-canonical-repair.js";
import { listSessionEntriesReadOnly } from "../config/sessions/session-accessor.sqlite-entry-list.read.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { readTranscriptEventRows } from "../config/sessions/session-accessor.sqlite-read.js";
import { appendTranscriptEventInTransaction } from "../config/sessions/session-accessor.sqlite-transcript-store.js";
import { runSessionStartupMigration } from "../config/sessions/startup-migration-runtime.js";
import * as sessionTargets from "../config/sessions/targets.js";
import { resetAgentRunRegistryForTest } from "../infra/agent-run-registry.js";
import { completeAgentDeletionJournalInDatabase } from "../state/agent-deletion-journal.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import {
  beginAgentDeletionJournal,
  readAgentDeletionJournal,
} from "../test-utils/agent-deletion-journal.js";
import { readAgentProvenance } from "../test-utils/agent-provenance.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { ensureOnboardingAgent } from "./onboard-agent.js";

const migrationWindow = vi.hoisted(() => ({
  afterPublication: undefined as (() => void) | undefined,
}));
vi.mock("../config/config.js", async (original) => {
  const actual = await original<typeof import("../config/config.js")>();
  return {
    ...actual,
    readConfigFileSnapshot: async () => {
      const snapshot = await actual.readConfigFileSnapshot();
      if (snapshot.config.agents?.entries?.robby) {
        const afterPublication = migrationWindow.afterPublication;
        migrationWindow.afterPublication = undefined;
        afterPublication?.();
      }
      return snapshot;
    },
  };
});

const legacyKey = "agent:main:main";
const databasePath = (stateDir: string, agentId: string) =>
  path.join(stateDir, "agents", agentId, "agent", "openclaw-agent.sqlite");

function readEntry(storePath: string, agentId: string, key: string) {
  return runOpenClawAgentWriteTransaction(
    (database) => readExactSessionEntryRowForCanonicalRepair(database, key)?.entry,
    { agentId, path: storePath },
  );
}

function readLedgerStatus() {
  return withExistingOpenClawStateDatabaseReadOnly(
    ({ db }) =>
      db
        .prepare(
          "SELECT status FROM migration_sources WHERE source_key = 'legacy-main-session-keys'",
        )
        .get() as { status: string } | undefined,
  );
}

async function seedLegacyHistory(rawHome: string) {
  const stateDir = path.join(await fs.realpath(rawHome), ".openclaw");
  setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
  deleteTestEnvValue("OPENCLAW_AGENT_DIR");
  resetConfigRuntimeState();
  await replaceConfigFile({ nextConfig: {}, afterWrite: { mode: "auto" } });
  const sourcePath = databasePath(stateDir, "main");
  const entry = { sessionId: "legacy-main-session", updatedAt: 100 };
  runOpenClawAgentWriteTransaction(
    (database) => {
      writeSessionEntry(database, legacyKey, entry, {
        allowStoredAliases: true,
        previousEntry: null,
      });
      appendTranscriptEventInTransaction(
        database,
        {
          agentId: "main",
          path: sourcePath,
          sessionId: entry.sessionId,
          sessionKey: legacyKey,
        },
        { type: "message", text: "legacy history" },
        { allowStoredAlias: true },
      );
    },
    { agentId: "main", path: sourcePath },
  );
  return {
    stateDir,
    sourcePath,
    ownerPath: databasePath(stateDir, "robby"),
    entry,
  };
}

describe("onboarding authored config persistence", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv(["OPENCLAW_AGENT_DIR", "OPENCLAW_STATE_DIR", "OPENCLAW_TOKEN"]);
  });

  afterEach(() => {
    migrationWindow.afterPublication = undefined;
    resetAgentRunRegistryForTest();
    envSnapshot.restore();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    resetConfigRuntimeState();
  });

  it.each(["sourceConfig", "config"] as const)(
    "creates a named first agent from %s while retaining authored env references and includes",
    async (configShape) => {
      await withTempHome(async (rawHome) => {
        const home = await fs.realpath(rawHome);
        const configDir = path.join(home, ".openclaw");
        const configPath = path.join(configDir, "openclaw.json");
        const includePath = path.join(configDir, "channels.json");
        const includeRaw = JSON.stringify({ channels: { telegram: { enabled: true } } });
        await fs.mkdir(configDir, { recursive: true });
        await fs.writeFile(includePath, includeRaw);
        await fs.writeFile(
          configPath,
          `{
          $include: "./channels.json",
          gateway: { auth: { mode: "token", token: "\${OPENCLAW_TOKEN}" } }
        }`,
        );
        setTestEnvValue("OPENCLAW_TOKEN", "plaintext-secret");
        resetConfigRuntimeState();

        const snapshot = await readConfigFileSnapshot();
        const baseConfig = snapshot[configShape];
        const candidate = {
          ...baseConfig,
          gateway: { ...baseConfig.gateway, mode: "local" as const },
        };
        const result = await ensureOnboardingAgent({
          config: candidate,
          workspace: path.join(home, "workspace"),
          baseConfig,
          firstAgent: { name: "roster-proof" },
        });
        await replaceConfigFile({ nextConfig: result.config, afterWrite: { mode: "auto" } });

        const persistedRaw = await fs.readFile(configPath, "utf8");
        expect(result).toMatchObject({ agentId: "roster-proof", createdAgent: true });
        expect(JSON.parse(persistedRaw).agents.entries).toEqual({
          "roster-proof": expect.objectContaining({
            name: "roster-proof",
            workspace: path.join(home, "workspace"),
          }),
        });
        expect(persistedRaw).toContain("${OPENCLAW_TOKEN}");
        expect(persistedRaw).not.toContain("plaintext-secret");
        expect(persistedRaw).toContain("./channels.json");
        expect(await fs.readFile(includePath, "utf8")).toBe(includeRaw);
      });
    },
  );

  it.each([
    { entries: { existing: { name: "Existing" } } },
    { entries: { main: {} } },
    {
      ownership: "explicit",
      defaults: { systemAgent: { agentId: "main" } },
      entries: { main: {} },
    },
    {
      ownership: "explicit",
      defaults: { systemAgent: { agentId: "alpha" } },
      entries: {
        alpha: { model: "fixture/alpha" },
        beta: { model: "fixture/beta" },
      },
    },
  ])("leaves an existing roster config byte-identical: %j", async (agents) => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".openclaw");
      const configPath = path.join(configDir, "openclaw.json");
      const raw = `${JSON.stringify({ agents }, null, 2)}\n`;
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(configPath, raw);
      resetConfigRuntimeState();
      const snapshot = await readConfigFileSnapshot();
      expect(snapshot.valid).toBe(true);

      const result = await ensureOnboardingAgent({
        config: snapshot.config,
        workspace: path.join(home, "workspace"),
        firstAgent: { name: "ignored" },
      });

      expect(result.createdAgent).toBe(false);
      expect(result.config.agents?.entries).toEqual(snapshot.config.agents?.entries);
      expect(snapshot.sourceConfigBeforeMigrations?.agents).toEqual(agents);
      expect(snapshot.sourceConfig.agents).not.toHaveProperty("list");
      expect(await fs.readFile(configPath, "utf8")).toBe(raw);
    });
  });

  it("reports legacy session repairs without migrating during first-agent onboarding", async () => {
    await withTempHome(async (rawHome) => {
      const { stateDir, sourcePath, ownerPath, entry } = await seedLegacyHistory(rawHome);
      const result = await ensureOnboardingAgent({
        config: {},
        workspace: path.join(stateDir, "workspace"),
        firstAgent: { name: "robby" },
      });
      expect(result.agentId).toBe("robby");
      expect
        .soft(listSessionEntriesReadOnly({ agentId: "robby", storePath: ownerPath }))
        .toEqual([]);
      expect.soft(readEntry(sourcePath, "main", legacyKey)).toMatchObject(entry);
      expect(result.sessionMigrationWarnings).toEqual([
        expect.stringContaining("openclaw doctor --fix"),
      ]);
      expect(readLedgerStatus()).toBeUndefined();
    });
  });

  it.each(["locked", "closed after publication"] as const)(
    "preserves history when %s until an explicit Doctor repair",
    async (boundary) => {
      await withTempHome(async (rawHome) => {
        const { stateDir, sourcePath, ownerPath, entry } = await seedLegacyHistory(rawHome);
        const canonicalKey = "agent:robby:main";
        const sourceDatabase = openOpenClawAgentDatabase({
          agentId: "main",
          path: sourcePath,
        });
        const admission = prepareSystemAgentRunAdmission({}, "onboard-migration", "main", "setup");
        const beforePersistentApply = resolveAdmittedRunActiveAssertion(
          await admission.admit("embedded"),
        )!;
        const beforeRows = readTranscriptEventRows(sourceDatabase, entry.sessionId);
        if (boundary === "locked") {
          sourceDatabase.db.exec("BEGIN IMMEDIATE");
        } else {
          beginAgentDeletionJournal({
            agentId: "robby",
            operationId: "previous-robby",
            deleteFiles: false,
            agentDir: path.join(stateDir, "agents", "robby", "agent"),
            sessionsDir: path.join(stateDir, "agents", "robby", "sessions"),
            workspaceDir: path.join(stateDir, "workspace"),
          });
          runOpenClawStateWriteTransaction((sharedStateDatabase) =>
            completeAgentDeletionJournalInDatabase(sharedStateDatabase, "robby", "previous-robby"),
          );
          migrationWindow.afterPublication = () => {
            beforePersistentApply();
            admission.close();
          };
        }
        let result: Awaited<ReturnType<typeof ensureOnboardingAgent>> | undefined;
        try {
          result = await ensureOnboardingAgent({
            config: {},
            workspace: path.join(stateDir, "workspace"),
            firstAgent: { name: "robby" },
            beforePersistentApply,
          });
        } finally {
          if (boundary === "locked") {
            sourceDatabase.db.exec("ROLLBACK");
          }
          admission.close();
        }

        expect(result?.agentId).toBe("robby");
        expect(result?.sessionMigrationWarnings).toEqual([
          expect.stringContaining("openclaw doctor --fix"),
        ]);
        if (boundary === "closed after publication") {
          expect(readAgentDeletionJournal("robby")).toBeUndefined();
          expect(readAgentProvenance("robby")).toMatchObject({ createdVia: "operator" });
        }
        expect(
          readExactSessionEntryRowForCanonicalRepair(sourceDatabase, legacyKey)?.entry,
        ).toMatchObject(entry);
        expect(readTranscriptEventRows(sourceDatabase, entry.sessionId)).toEqual(beforeRows);
        expect(
          listSessionEntriesReadOnly({
            agentId: "robby",
            storePath: ownerPath,
          }),
        ).toEqual([]);
        expect.soft(readLedgerStatus()).toBeUndefined();
        const published = await readConfigFileSnapshot();
        expect(Object.keys(published.config.agents?.entries ?? {})).toEqual(["robby"]);
        const log = { info: vi.fn(), warn: vi.fn() };
        const resolveTargets = vi
          .spyOn(sessionTargets, "resolveAllAgentSessionStoreTargetsSync")
          .mockReturnValue([]);
        try {
          await runSessionStartupMigration({ cfg: published.config, env: process.env, log });
        } finally {
          resolveTargets.mockRestore();
        }
        expect(readEntry(sourcePath, "main", legacyKey)).toMatchObject(entry);
        expect(listSessionEntriesReadOnly({ agentId: "robby", storePath: ownerPath })).toEqual([]);
        expect(readLedgerStatus()).toBeUndefined();
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("openclaw doctor --fix"));
        await migrateLegacyMainSessionKeys({
          cfg: published.config,
          env: process.env,
          mode: "doctor-fix",
        });
        expect(readEntry(ownerPath, "robby", canonicalKey)).toMatchObject(entry);
        expect(readEntry(sourcePath, "main", legacyKey)).toBeUndefined();
        expect(readLedgerStatus()).toEqual({ status: "completed" });
      });
    },
  );
});
