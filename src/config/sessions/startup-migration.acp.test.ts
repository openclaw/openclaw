import { expect, it, vi } from "vitest";
import { repairAcpSessionMetaKeysForDoctor } from "../../acp/runtime/session-meta-doctor.js";
import { buildAcpDatabaseSessionKey } from "../../acp/runtime/session-meta-keys.js";
import {
  readAcpSessionEntry,
  writeAcpSessionMetaForMigration,
} from "../../acp/runtime/session-meta.js";
import { noteSessionTranscriptHealth } from "../../commands/doctor-session-transcripts.js";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createAgentDatabaseInspectionRefusal,
  preparePendingAgentDatabase,
  readAgentDatabaseAdmissionRefusal,
  recordAgentDatabaseAdmissions,
} from "../../state/agent-database-admission.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import * as stateReads from "../../state/openclaw-state-db-readonly.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { migrateLegacyMainSessionKeys } from "./legacy-main-session-migration.js";
import { replaceSessionEntrySync } from "./session-accessor.js";
import { resolveSqliteSessionKey } from "./session-accessor.sqlite-scope.js";
import { seedCanonicalSessionValidation } from "./session-canonical-validation.js";
import { runSessionStartupMigration } from "./startup-migration.js";

it.each([false, true])(
  "inspects legacy keys while ACP inspection is pending, refusing handoff on ACP failure=%s",
  async (refuse) => {
    await withOpenClawTestState({ scenario: "empty" }, async ({ env, writeConfig }) => {
      const cfg = { agents: { ownership: "explicit" as const, entries: { main: {} } } };
      await writeConfig(cfg);
      replaceSessionEntrySync(
        { agentId: "main", env, sessionKey: "agent:main:main" },
        { sessionId: "retained-session", updatedAt: 100 },
      );
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const originalRead = stateReads.executeExistingOpenClawStateRead;
      const reading = vi
        .spyOn(stateReads, "executeExistingOpenClawStateRead")
        .mockImplementation(async (...args) => {
          if (args[1].type === "acpSessions.list") {
            entered.resolve();
            await release.promise;
            if (refuse) {
              throw new Error("ACP inspection refused");
            }
          }
          return await originalRead(...args);
        });
      const inspectLegacy = vi.fn(migrateLegacyMainSessionKeys);
      const handoffDatabase = vi.fn(async () => {});
      const outcome = runSessionStartupMigration({
        cfg,
        env,
        log: { info() {}, warn() {} },
        handoffDatabase,
        deps: { migrateLegacyMainSessionKeys: inspectLegacy },
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        await entered.promise;
        expect(inspectLegacy).toHaveBeenCalledWith({ cfg, env, mode: "detect" });
        expect(handoffDatabase).not.toHaveBeenCalled();
        release.resolve();
        expect(await outcome).toEqual(refuse ? new Error("ACP inspection refused") : undefined);
        expect(handoffDatabase).toHaveBeenCalledTimes(refuse ? 0 : 1);
      } finally {
        release.resolve();
        await outcome;
        reading.mockRestore();
      }
    });
  },
);

it.each(["recorded", "ownerless", "literal"] as const)(
  "startup defers %s ACP bindings until their physical store is admitted",
  async (shape) => {
    await withOpenClawTestState({ scenario: "empty" }, async ({ env, writeConfig }) => {
      const cfg = {
        agents: { ownership: "explicit" as const, entries: { main: {}, deferred: {} } },
      };
      await writeConfig(cfg);
      replaceSessionEntrySync(
        { agentId: "main", env, sessionKey: "agent:main:main" },
        { sessionId: "ready-session", updatedAt: 100 },
      );
      const sessionKey =
        shape === "recorded"
          ? "agent:deferred:acp:legacy"
          : shape === "ownerless"
            ? "global"
            : buildAcpDatabaseSessionKey("absent", "retired");
      replaceSessionEntrySync(
        { agentId: "deferred", env, sessionKey },
        { sessionId: "deferred-session", lifecycleRevision: "deferred-revision", updatedAt: 100 },
      );
      writeAcpSessionMetaForMigration({
        env,
        sessionKey,
        lifecycleRevision: "deferred-revision",
        meta: {
          backend: "fixture",
          agent: "deferred",
          runtimeSessionName: "deferred-runtime",
          mode: "persistent",
          state: "idle",
          lastActivityAt: 100,
        },
        now: () => 100,
      });
      const deferredPath = resolveOpenClawAgentSqlitePath({ agentId: "deferred", env });
      await closeOpenClawAgentDatabaseByPathAsync(deferredPath);
      const refusal = createAgentDatabaseInspectionRefusal({
        agentId: "deferred",
        paths: [deferredPath],
        reason: "Inspection and preparation continue after the listener binds",
        pending: true,
      });
      recordAgentDatabaseAdmissions([refusal], { env, source: "startup" });
      const handedOff: string[] = [];
      const startup = (agentIds?: ReadonlySet<string>) =>
        runSessionStartupMigration({
          cfg,
          env,
          agentIds,
          log: { info() {}, warn() {} },
          handoffDatabase: async ({ agentId }) => {
            handedOff.push(agentId);
          },
        });
      await expect(startup()).resolves.toBeUndefined();
      expect(handedOff).toEqual(["main"]);
      expect(readAgentDatabaseAdmissionRefusal("deferred", { env })).toBe(refusal);
      handedOff.length = 0;
      await expect(
        preparePendingAgentDatabase(refusal, { env, assertCurrent() {} }, () =>
          startup(new Set(["deferred"])),
        ),
      ).rejects.toThrow("ACP metadata requires offline migration");
      expect(handedOff).toEqual([]);
      expect(readAgentDatabaseAdmissionRefusal("deferred", { env })).toBe(refusal);
    });
  },
);

it("startup refuses unresolved ACP ownership even without a discovered agent store", async () => {
  await withOpenClawTestState({ scenario: "empty" }, async ({ env, writeConfig }) => {
    const cfg = { agents: { ownership: "explicit" as const, entries: { main: {}, ops: {} } } };
    await writeConfig(cfg);
    writeAcpSessionMetaForMigration({
      env,
      sessionKey: "@agent:main:agent:ops:acp:legacy",
      lifecycleRevision: "unresolved-revision",
      meta: {
        backend: "fixture",
        agent: "ops",
        runtimeSessionName: "unresolved-runtime",
        mode: "persistent",
        state: "idle",
        lastActivityAt: 100,
      },
      now: () => 100,
    });
    await expect(
      runSessionStartupMigration({ cfg, env, log: { info() {}, warn() {} } }),
    ).rejects.toThrow("unresolved shared ACP owner");
  });
});

it("startup requires offline ACP repair before handing restored stores to runtime", async () => {
  await withOpenClawTestState({ scenario: "empty" }, async ({ env, writeConfig }) => {
    const cfg = { agents: { ownership: "explicit" as const, entries: { main: {}, ops: {} } } };
    await writeConfig(cfg);
    const handoffDatabase = vi.fn(async () => {});
    const log = { info: vi.fn(), warn: vi.fn() };
    const startup = () => runSessionStartupMigration({ cfg, env, log, handoffDatabase });
    const entry = {
      sessionId: "restored-acp-session",
      lifecycleRevision: "restored-revision",
      updatedAt: 100,
    };
    const meta = {
      backend: "fixture",
      agent: "main",
      runtimeSessionName: "restored-runtime",
      mode: "persistent" as const,
      state: "idle" as const,
      lastActivityAt: 100,
    };
    const literalKey = buildAcpDatabaseSessionKey("absent", "other");
    const owners = new Set<string>();
    for (const { shape, agentId, sessionKey, sourceKey } of [
      {
        shape: "raw-key",
        agentId: "main",
        sessionKey: "agent:main:acp:raw",
        sourceKey: "agent:main:acp:raw",
      },
      {
        shape: "ownerless-key",
        agentId: "main",
        sessionKey: "agent:main:acp:ownerless",
        sourceKey: buildAcpDatabaseSessionKey("agent:main:acp:ownerless"),
      },
      {
        shape: "embedded-entry",
        agentId: "main",
        sessionKey: "agent:main:acp:embedded",
        sourceKey: undefined,
      },
      {
        shape: "unsettled-embedded",
        agentId: "main",
        sessionKey: "agent:main:acp:unsettled",
        sourceKey: undefined,
      },
      {
        shape: "literal-encoded-key",
        agentId: "ops",
        sessionKey: literalKey,
        sourceKey: literalKey,
      },
      {
        shape: "encoded-inner-alias",
        agentId: "main",
        sessionKey: "agent:main:main",
        sourceKey: buildAcpDatabaseSessionKey("MAIN", "main"),
      },
    ]) {
      handoffDatabase.mockClear();
      owners.add(agentId);
      const scope = { cfg, env, agentId, sessionKey };
      const currentEntry = {
        ...entry,
        sessionId: `${entry.sessionId}-${shape}`,
        lifecycleRevision: `${entry.lifecycleRevision}-${shape}`,
      };
      replaceSessionEntrySync(
        scope,
        sourceKey === undefined ? { ...currentEntry, acp: meta } : currentEntry,
      );
      if (shape === "unsettled-embedded") {
        const database = openOpenClawAgentDatabase({ agentId, env });
        const { db } = database;
        runSqliteImmediateTransactionSync(db, () => seedCanonicalSessionValidation(database));
        const raw = `${JSON.stringify(currentEntry).slice(0, -1)},"acp":null,"acp":${JSON.stringify(meta)}}`;
        db.prepare(
          "UPDATE session_nodes SET entry_json = ?, entry_valid = 0 WHERE session_key = ?",
        ).run(raw, sessionKey);
        expect(
          db.prepare("SELECT entry_valid FROM session_nodes WHERE session_key = ?").get(sessionKey),
        ).toEqual({ entry_valid: 0 });
      }
      if (sourceKey) {
        writeAcpSessionMetaForMigration({
          env,
          sessionKey: sourceKey,
          lifecycleRevision: currentEntry.lifecycleRevision,
          meta,
          now: () => 100,
        });
      }
      if (shape === "unsettled-embedded") {
        await expect(startup()).rejects.toMatchObject({
          message: `invalid persisted session row requires repair for ${sessionKey}; stop the Gateway and run openclaw doctor --fix`,
        });
      } else {
        await expect(startup()).rejects.toThrow('run "openclaw doctor --fix"');
      }
      expect(handoffDatabase).not.toHaveBeenCalled();
      const warnings: string[] = [];
      await noteSessionTranscriptHealth({
        cfg,
        env,
        shouldRepair: true,
        postSessionPluginMigrationPlanBound: true,
        onWarnings: (reported) => warnings.push(...reported),
      });
      expect(warnings).toEqual([]);
      expect(readAcpSessionEntry(scope)?.acp).toEqual(meta);
      await expect(startup()).resolves.toBeUndefined();
      expect(handoffDatabase).toHaveBeenCalledTimes(owners.size);
      expect(await repairAcpSessionMetaKeysForDoctor({ cfg, env, apply: false })).toMatchObject({
        found: 0,
        repaired: 0,
        warnings: [],
      });
      const { db } = openOpenClawStateDatabase({ env });
      expect(
        db
          .prepare("SELECT session_key FROM acp_sessions WHERE session_key = ?")
          .get(buildAcpDatabaseSessionKey(resolveSqliteSessionKey(sessionKey, agentId), agentId)),
      ).toEqual({
        session_key: buildAcpDatabaseSessionKey(
          resolveSqliteSessionKey(sessionKey, agentId),
          agentId,
        ),
      });
    }
    const nullKey = "agent:main:acp:last-null";
    const nullScope = { agentId: "main", sessionKey: nullKey, env };
    const nullEntry = {
      ...entry,
      sessionId: "null-metadata-session",
      lifecycleRevision: "null-metadata-revision",
    };
    replaceSessionEntrySync(nullScope, nullEntry);
    const rawNull = `${JSON.stringify(nullEntry).slice(0, -1)},"acp":${JSON.stringify(meta)},"acp":null}`;
    const { db: agentDatabase } = openOpenClawAgentDatabase({ agentId: "main", env });
    agentDatabase
      .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
      .run(rawNull, nullKey);
    // Keep this row admitted so the ACP check sees JSON's last property value.
    agentDatabase
      .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
      .run(nullKey);
    await expect(startup()).resolves.toBeUndefined();
    expect(readAcpSessionEntry({ ...nullScope, cfg })?.acp).toBeUndefined();
    expect(
      agentDatabase
        .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
        .get(nullKey),
    ).toEqual({ entry_json: rawNull });
  });
});

it.each([false, true])(
  "ownerless ACP refusal follows physical store scope (shared: %s)",
  async (shared) => {
    await withOpenClawTestState({ scenario: "empty" }, async (state) => {
      const storePath = shared ? state.statePath("shared.sqlite") : undefined;
      const cfg = {
        agents: { ownership: "explicit" as const, entries: { main: {}, ops: {} } },
        session: storePath ? { store: storePath } : undefined,
      };
      await state.writeConfig(cfg);
      if (storePath) {
        openOpenClawAgentDatabase({ agentId: "main", path: storePath, env: state.env });
      }
      for (const agentId of ["main", "ops"]) {
        replaceSessionEntrySync(
          {
            agentId,
            storePath,
            env: state.env,
            sessionKey: "global",
          },
          {
            sessionId: `scope-${agentId}`,
            lifecycleRevision: `revision-${agentId}`,
            updatedAt: 100,
          },
        );
      }
      writeAcpSessionMetaForMigration({
        env: state.env,
        sessionKey: "global",
        lifecycleRevision: "revision-ops",
        meta: {
          backend: "fixture",
          agent: "ops",
          runtimeSessionName: "ops-runtime",
          mode: "persistent",
          state: "idle",
          lastActivityAt: 100,
        },
        now: () => 100,
      });
      const handoffDatabase = vi.fn(async () => {});
      const startup = (agentId: string) =>
        runSessionStartupMigration({
          cfg,
          env: state.env,
          agentIds: new Set([agentId]),
          log: { info: vi.fn(), warn: vi.fn() },
          handoffDatabase,
        });
      if (shared) {
        await expect(startup("main")).rejects.toThrow('run "openclaw doctor --fix"');
        expect(handoffDatabase).not.toHaveBeenCalled();
      } else {
        await expect(startup("main")).resolves.toBeUndefined();
        expect(handoffDatabase).toHaveBeenCalledTimes(1);
      }
      handoffDatabase.mockClear();
      await expect(startup("ops")).rejects.toThrow('run "openclaw doctor --fix"');
      expect(handoffDatabase).not.toHaveBeenCalled();
    });
  },
);

it("startup preserves unbound ACP rows retained by Doctor without serving their metadata", async () => {
  await withOpenClawTestState({ scenario: "empty" }, async ({ env, writeConfig }) => {
    const cfg = { agents: { ownership: "explicit" as const, entries: { main: {} } } };
    await writeConfig(cfg);
    const entry = {
      sessionId: "current-session",
      lifecycleRevision: "current-revision",
      updatedAt: 100,
    };
    replaceSessionEntrySync({ agentId: "main", env, sessionKey: "agent:main:main" }, entry);
    const staleKey = "agent:main:acp:stale";
    replaceSessionEntrySync({ agentId: "main", env, sessionKey: staleKey }, entry);
    const keys = [
      "agent:main:acp:absent",
      "agent:main:acp:binding:absent",
      staleKey,
      "orphan-bare-key",
      "agent:retired:acp:absent",
    ];
    for (const sessionKey of keys) {
      writeAcpSessionMetaForMigration({
        env,
        sessionKey,
        lifecycleRevision: "old-revision",
        meta: {
          backend: "fixture",
          agent: "main",
          runtimeSessionName: "retained-runtime",
          mode: "persistent",
          state: "idle",
          lastActivityAt: 50,
        },
        now: () => 50,
      });
    }
    const { db } = openOpenClawStateDatabase({ env });
    const before = db.prepare("SELECT * FROM acp_sessions ORDER BY session_key").all();
    const repair = await repairAcpSessionMetaKeysForDoctor({
      cfg,
      env,
      apply: true,
      authority: { assertCurrent() {} },
    });
    expect(repair.repaired).toBe(0);
    expect(repair.warnings).toHaveLength(keys.length);
    const handoffDatabase = vi.fn(async () => {});
    await expect(
      runSessionStartupMigration({
        cfg,
        env,
        log: { info: vi.fn(), warn: vi.fn() },
        handoffDatabase,
      }),
    ).resolves.toBeUndefined();
    expect(handoffDatabase).toHaveBeenCalledTimes(1);
    for (const sessionKey of keys) {
      expect(
        readAcpSessionEntry({
          cfg,
          env,
          agentId: sessionKey.startsWith("agent:retired:") ? "retired" : "main",
          sessionKey,
        })?.acp,
      ).toBeUndefined();
    }
    expect(db.prepare("SELECT * FROM acp_sessions ORDER BY session_key").all()).toEqual(before);
  });
});
