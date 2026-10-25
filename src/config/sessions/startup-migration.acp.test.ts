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
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import * as legacyMainMigration from "./legacy-main-session-migration.js";
import { replaceSessionEntrySync } from "./session-accessor.js";
import { resolveSqliteSessionKey } from "./session-accessor.sqlite-scope.js";
import { markCanonicalSessionValidationPending } from "./session-canonical-key.js";
import { runSessionStartupMigration } from "./startup-migration.js";

function migrationAcpMeta(agent: string, runtimeSessionName: string, lastActivityAt = 100) {
  return {
    backend: "fixture",
    agent,
    runtimeSessionName,
    mode: "persistent" as const,
    state: "idle" as const,
    lastActivityAt,
  };
}

function acpConfig(...agentIds: string[]) {
  return {
    agents: {
      ownership: "explicit" as const,
      entries: Object.fromEntries(agentIds.map((id) => [id, {}])),
    },
  };
}

function withAcpState(
  agentIds: string[],
  run: (state: OpenClawTestState & ReturnType<typeof acpHarness>) => Promise<void>,
  shared = false,
) {
  return withOpenClawTestState({ scenario: "empty" }, async (state) => {
    const harness = acpHarness(
      state.env,
      agentIds,
      shared ? state.statePath("shared.sqlite") : undefined,
    );
    await state.writeConfig(harness.cfg);
    await run({ ...state, ...harness });
  });
}

function acpHarness(env: NodeJS.ProcessEnv, agentIds: string[], storePath?: string) {
  const cfg = { ...acpConfig(...agentIds), session: storePath ? { store: storePath } : undefined };
  const handoff = vi.fn<
    NonNullable<Parameters<typeof runSessionStartupMigration>[0]["handoffDatabase"]>
  >(async () => {});
  return {
    cfg,
    handoff,
    startup: (selectedAgents?: ReadonlySet<string>) =>
      runSessionStartupMigration({
        cfg,
        env,
        agentIds: selectedAgents,
        log: { info() {}, warn() {} },
        handoffDatabase: handoff,
      }),
    seed: (key: string, agentId = "main") => seedSession(env, key, agentId),
  };
}

function seedSession(env: NodeJS.ProcessEnv, sessionKey: string, agentId: string) {
  const entry = {
    sessionId: `session-${sessionKey}`,
    lifecycleRevision: `revision-${sessionKey}`,
    updatedAt: 100,
  };
  replaceSessionEntrySync({ agentId, env, sessionKey }, entry);
  return entry;
}

function seedMeta(
  env: NodeJS.ProcessEnv,
  sessionKey: string,
  lifecycleRevision: string,
  meta: ReturnType<typeof migrationAcpMeta>,
  now = 100,
) {
  writeAcpSessionMetaForMigration({ env, sessionKey, lifecycleRevision, meta, now: () => now });
}

it.each([false, true])(
  "inspects legacy keys while ACP inspection is pending, refusing handoff on ACP failure=%s",
  async (refuse) => {
    await withAcpState(["main"], async ({ env, cfg, startup, handoff, seed }) => {
      seed("agent:main:main");
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
      const inspectLegacy = vi.spyOn(legacyMainMigration, "migrateLegacyMainSessionKeys");
      const outcome = startup().then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        await entered.promise;
        expect(inspectLegacy).toHaveBeenCalledWith({ cfg, env, mode: "detect" });
        expect(handoff).not.toHaveBeenCalled();
        release.resolve();
        expect(await outcome).toEqual(refuse ? new Error("ACP inspection refused") : undefined);
        expect(handoff).toHaveBeenCalledTimes(refuse ? 0 : 1);
      } finally {
        release.resolve();
        await outcome;
        reading.mockRestore();
        inspectLegacy.mockRestore();
      }
    });
  },
);

it.each(["recorded", "ownerless", "literal"] as const)(
  "startup defers %s ACP bindings until their physical store is admitted",
  async (shape) => {
    await withAcpState(["main", "deferred"], async ({ env, startup, handoff, seed }) => {
      seed("agent:main:main");
      const sessionKey =
        shape === "recorded"
          ? "agent:deferred:acp:legacy"
          : shape === "ownerless"
            ? "global"
            : buildAcpDatabaseSessionKey("absent", "retired");
      const entry = seed(sessionKey, "deferred");
      seedMeta(
        env,
        sessionKey,
        entry.lifecycleRevision,
        migrationAcpMeta("deferred", "deferred-runtime"),
      );
      const deferredPath = resolveOpenClawAgentSqlitePath({ agentId: "deferred", env });
      await closeOpenClawAgentDatabaseByPathAsync(deferredPath);
      const refusal = createAgentDatabaseInspectionRefusal({
        agentId: "deferred",
        paths: [deferredPath],
        reason: "Inspection and preparation continue after the listener binds",
        pending: true,
      });
      recordAgentDatabaseAdmissions([refusal], { env, source: "startup" });
      await expect(startup()).resolves.toBeUndefined();
      expect(handoff.mock.calls.map(([target]) => target.agentId)).toEqual(["main"]);
      expect(readAgentDatabaseAdmissionRefusal("deferred", { env })).toBe(refusal);
      handoff.mockClear();
      await expect(
        preparePendingAgentDatabase(refusal, { env, assertCurrent() {} }, () =>
          startup(new Set(["deferred"])),
        ),
      ).rejects.toThrow("ACP metadata requires offline migration");
      expect(handoff).not.toHaveBeenCalled();
      expect(readAgentDatabaseAdmissionRefusal("deferred", { env })).toBe(refusal);
    });
  },
);

it("startup refuses unresolved ACP ownership even without a discovered agent store", async () => {
  await withAcpState(["main", "ops"], async ({ env, startup }) => {
    seedMeta(
      env,
      "@agent:main:agent:ops:acp:legacy",
      "unresolved-revision",
      migrationAcpMeta("ops", "unresolved-runtime"),
    );
    await expect(startup()).rejects.toThrow("unresolved shared ACP owner");
  });
});

it("startup requires offline ACP repair before handing restored stores to runtime", async () => {
  await withAcpState(["main", "ops"], async ({ env, cfg, startup, handoff }) => {
    const entry = {
      sessionId: "restored-acp-session",
      lifecycleRevision: "restored-revision",
      updatedAt: 100,
    };
    const meta = migrationAcpMeta("main", "restored-runtime");
    const literalKey = buildAcpDatabaseSessionKey("absent", "other");
    const owners = new Set<string>();
    for (const [shape, agentId, sessionKey, sourceKey] of [
      ["raw-key", "main", "agent:main:acp:raw", "agent:main:acp:raw"],
      [
        "ownerless-key",
        "main",
        "agent:main:acp:ownerless",
        buildAcpDatabaseSessionKey("agent:main:acp:ownerless"),
      ],
      ["embedded-entry", "main", "agent:main:acp:embedded", undefined],
      ["unsettled-embedded", "main", "agent:main:acp:unsettled", undefined],
      ["literal-encoded-key", "ops", literalKey, literalKey],
      [
        "encoded-inner-alias",
        "main",
        "agent:main:main",
        buildAcpDatabaseSessionKey("MAIN", "main"),
      ],
    ] as const) {
      handoff.mockClear();
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
        runSqliteImmediateTransactionSync(db, () =>
          markCanonicalSessionValidationPending(database),
        );
        const raw = `${JSON.stringify(currentEntry).slice(0, -1)},"acp":null,"acp":${JSON.stringify(meta)}}`;
        db.prepare(
          "UPDATE session_nodes SET entry_json = ?, entry_valid = 0 WHERE session_key = ?",
        ).run(raw, sessionKey);
        expect(
          db.prepare("SELECT entry_valid FROM session_nodes WHERE session_key = ?").get(sessionKey),
        ).toEqual({ entry_valid: 0 });
      }
      if (sourceKey) {
        seedMeta(env, sourceKey, currentEntry.lifecycleRevision, meta);
      }
      if (shape === "unsettled-embedded") {
        await expect(startup()).rejects.toMatchObject({
          message: `invalid persisted session row requires repair for ${sessionKey}; stop the Gateway and run openclaw doctor --fix`,
        });
      } else {
        await expect(startup()).rejects.toThrow('run "openclaw doctor --fix"');
      }
      expect(handoff).not.toHaveBeenCalled();
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
      expect(handoff).toHaveBeenCalledTimes(owners.size);
      expect(await repairAcpSessionMetaKeysForDoctor({ cfg, env, apply: false })).toMatchObject({
        found: 0,
        repaired: 0,
        warnings: [],
      });
      const { db } = openOpenClawStateDatabase({ env });
      const canonicalKey = buildAcpDatabaseSessionKey(
        resolveSqliteSessionKey(sessionKey, agentId),
        agentId,
      );
      expect(
        db.prepare("SELECT session_key FROM acp_sessions WHERE session_key = ?").get(canonicalKey),
      ).toEqual({ session_key: canonicalKey });
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
    await withAcpState(
      ["main", "ops"],
      async ({ env, cfg, startup, handoff }) => {
        const storePath = cfg.session?.store;
        if (storePath) {
          openOpenClawAgentDatabase({ agentId: "main", path: storePath, env });
        }
        for (const agentId of ["main", "ops"]) {
          replaceSessionEntrySync(
            { agentId, storePath, env, sessionKey: "global" },
            {
              sessionId: `scope-${agentId}`,
              lifecycleRevision: `revision-${agentId}`,
              updatedAt: 100,
            },
          );
        }
        seedMeta(env, "global", "revision-ops", migrationAcpMeta("ops", "ops-runtime"));
        if (shared) {
          await expect(startup(new Set(["main"]))).rejects.toThrow('run "openclaw doctor --fix"');
          expect(handoff).not.toHaveBeenCalled();
        } else {
          await expect(startup(new Set(["main"]))).resolves.toBeUndefined();
          expect(handoff).toHaveBeenCalledTimes(1);
        }
        handoff.mockClear();
        await expect(startup(new Set(["ops"]))).rejects.toThrow('run "openclaw doctor --fix"');
        expect(handoff).not.toHaveBeenCalled();
      },
      shared,
    );
  },
);

it("startup preserves unbound ACP rows retained by Doctor without serving their metadata", async () => {
  await withAcpState(["main"], async ({ env, cfg, startup, handoff, seed }) => {
    const entry = seed("agent:main:main");
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
      seedMeta(
        env,
        sessionKey,
        "old-revision",
        migrationAcpMeta("main", "retained-runtime", 50),
        50,
      );
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
    await expect(startup()).resolves.toBeUndefined();
    expect(handoff).toHaveBeenCalledTimes(1);
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
