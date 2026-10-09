import fs from "node:fs";
import { expect, it, vi } from "vitest";
import {
  observeHostDataSql,
  trackSqliteStatementExecutions,
} from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { ensureOpenClawAgentBoardSchemaInTransaction } from "../../state/openclaw-agent-board-schema.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import {
  ensureSessionInputCompletionsSchema,
  ensureSessionPendingInputsSchema,
} from "../../state/openclaw-agent-pending-inputs-schema.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { prepareComparisonClaimsFromStores } from "./legacy-main-session-key-scan.js";
import { readClaim, readComparisonClaim } from "./legacy-main-session-migration-claims.js";
import { migrateLegacyMainSessionKeys } from "./legacy-main-session-migration.js";
import {
  databasePath,
  seedClaim,
  setupLegacyMainSessionMigrationTests,
} from "./legacy-main-session-migration.test-support.js";
import { listSessionEntryKeysReadOnly } from "./session-accessor.sqlite-entry.js";
import { appendTranscriptEventInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { SessionEntryChangedDuringReadError } from "./session-entry-read-errors.js";
import {
  captureSessionRetirementReader,
  withSessionRetirementReaders,
} from "./session-retirement-read.js";
import { maintenanceLane, targetDiscoveryLane } from "./session-transcript-worker-resources.js";

const { createFixture } = setupLegacyMainSessionMigrationTests();

it("compares retained history without acquiring Doctor deletion custody", () => {
  const fixture = createFixture();
  const pathname = databasePath(fixture.stateDir, "main");
  const key = "agent:main:chat";
  seedClaim({ databaseAgentId: "main", databasePath: pathname, key });
  const options = { agentId: "main", path: pathname, env: fixture.env };
  runOpenClawAgentWriteTransaction(({ db }) => {
    ensureOpenClawAgentBoardSchemaInTransaction(db);
    ensureSessionPendingInputsSchema(db);
    ensureSessionInputCompletionsSchema(db);
  }, options);
  const database = openOpenClawAgentDatabase(options);
  const store = { databaseAgentId: "main", ownerStorePath: pathname, path: pathname };
  const observed = trackSqliteStatementExecutions(database.db, ["node", "input"], (sql) => {
    if (!/^select /i.test(sql)) {
      return null;
    }
    if (/\b(?:session_pending_inputs|session_input_completions)\b/.test(sql)) {
      return "input";
    }
    return /\b(?:board_widgets|board_tabs|session_members|session_participants|session_progress_cards|session_suggestions|session_reactions|heartbeat_outcomes)\b/.test(
      sql,
    ) || sql.startsWith('select "legacy_acp_migration_json" ')
      ? "node"
      : null;
  });
  try {
    const comparison = readComparisonClaim(database, store, key, "agent:ops:chat");
    expect(comparison).toMatchObject({
      canonicalKey: "agent:ops:chat",
      key,
      entry: { sessionId: "session-agent-main-chat" },
    });
    expect(comparison?.generations).toHaveLength(1);
    expect(observed.counts).toEqual({ node: 0, input: 0 });
    const custody = readClaim(database, store, key, "agent:ops:chat");
    expect(custody?.generations[0]?.contentFingerprint).toBe(
      comparison?.generations[0]?.contentFingerprint,
    );
    expect(custody?.nodeArtifactFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(custody?.generations[0]?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(observed.counts.node).toBeGreaterThan(0);
    expect(observed.counts.input).toBe(2);
  } finally {
    observed.restore();
  }
});

it("keeps detailed legacy detection current after a foreign transcript commit", async () => {
  const fixture = createFixture();
  const sourcePath = databasePath(fixture.stateDir, "main");
  const destinationPath = databasePath(fixture.stateDir, "ops");
  const entry = { sessionId: "shared-generation", updatedAt: 100 };
  seedClaim({ databaseAgentId: "main", databasePath: sourcePath, key: "agent:main:chat", entry });
  seedClaim({
    databaseAgentId: "ops",
    databasePath: destinationPath,
    key: "agent:ops:chat",
    entry,
  });
  const detect = () =>
    migrateLegacyMainSessionKeys({
      cfg: fixture.cfg,
      env: fixture.env,
      mode: "detect",
      forceScan: true,
    });
  expect((await detect()).outcomes).toEqual([
    {
      kind: "canonical-exists-identical",
      canonicalKey: "agent:ops:chat",
      paths: [sourcePath],
      sourceKeys: ["agent:main:chat"],
    },
  ]);
  runOpenClawAgentWriteTransaction(
    (database) => {
      appendTranscriptEventInTransaction(
        database,
        {
          agentId: "ops",
          path: destinationPath,
          sessionId: entry.sessionId,
          sessionKey: "agent:ops:chat",
        },
        { type: "message", id: "foreign-later", text: "Canonical history changed." },
      );
    },
    { agentId: "ops", path: destinationPath, env: fixture.env },
  );
  const changed = await detect();
  expect(changed).toMatchObject({ complete: false, ledgerComplete: false, changes: [] });
  expect(changed.outcomes).toEqual([
    {
      kind: "divergent-canonical",
      canonicalKey: "agent:ops:chat",
      paths: [destinationPath, sourcePath],
      sourceKeys: ["agent:ops:chat", "agent:main:chat"],
    },
  ]);
  expect(changed.warnings).toContain(
    `session: divergent-canonical for agent:ops:chat; preserved claims ${destinationPath}#agent:ops:chat, ${sourcePath}#agent:main:chat. Run openclaw doctor --fix to quarantine the losing claims.`,
  );
});

it("lists workspace keys off-thread and rejects a captured absence after a foreign creation", async () => {
  const fixture = createFixture();
  const pathname = databasePath(fixture.stateDir, "ops");
  const scope = { agentId: "ops", env: fixture.env, storePath: pathname };
  const readAbsent = captureSessionRetirementReader(
    { databaseAgentId: "ops", ownerStorePath: pathname, path: pathname },
    fixture.env,
  );
  expect(await listSessionEntryKeysReadOnly(scope)).toEqual([]);
  seedClaim({ databaseAgentId: "ops", databasePath: pathname, key: "agent:ops:chat" });
  await expect(readAbsent.read({ operation: "keys" })).rejects.toThrow("identity changed");
  const observed = observeHostDataSql();
  try {
    expect(await listSessionEntryKeysReadOnly(scope)).toEqual(["agent:ops:chat"]);
    expect(observed.queries.filter((sql) => /\bsession_nodes\b/.test(sql))).toEqual([]);
  } finally {
    observed.restore();
  }
  seedClaim({ databaseAgentId: "ops", databasePath: pathname, key: "agent:ops:later" });
  expect(await listSessionEntryKeysReadOnly(scope)).toEqual(["agent:ops:chat", "agent:ops:later"]);
  const ownerStorePath = `${pathname}.json`;
  const readAlias = captureSessionRetirementReader(
    { databaseAgentId: "ops", ownerStorePath, path: pathname },
    fixture.env,
  );
  fs.writeFileSync(ownerStorePath, "{}\n");
  await expect(readAlias.read({ operation: "keys" })).rejects.toThrow("identity changed");
});

it("retains missing stores while another legacy store is read", async () => {
  const fixture = createFixture();
  const sourcePath = databasePath(fixture.stateDir, "main");
  const missingPath = databasePath(fixture.stateDir, "ops");
  seedClaim({ databaseAgentId: "main", databasePath: sourcePath, key: "agent:main:chat" });
  const unreadable: Array<{ path: string; error: unknown }> = [];
  const scan = prepareComparisonClaimsFromStores({
    env: fixture.env,
    legacyAgentId: "main",
    ownerAgentId: "ops",
    stores: [
      { databaseAgentId: "main", ownerStorePath: sourcePath, path: sourcePath },
      { databaseAgentId: "ops", ownerStorePath: missingPath, path: missingPath },
    ],
    onUnreadable: (store, error) => unreadable.push({ path: store.path, error }),
  });
  const result = scan.read();
  seedClaim({ databaseAgentId: "ops", databasePath: missingPath, key: "agent:main:late" });
  expect((await result).legacy.map((claim) => claim.key)).toEqual(["agent:main:chat"]);
  expect(unreadable).toHaveLength(1);
  expect(unreadable[0]?.path).toBe(missingPath);
  expect(String(unreadable[0]?.error)).toContain("identity changed");
});

it("refuses retirement facts after a native write bypasses the held FIFO", async () => {
  const fixture = createFixture();
  const pathname = databasePath(fixture.stateDir, "ops");
  seedClaim({ databaseAgentId: "ops", databasePath: pathname, key: "agent:ops:chat" });
  const reader = captureSessionRetirementReader(
    { databaseAgentId: "ops", ownerStorePath: pathname, path: pathname },
    fixture.env,
  );
  await expect(
    withSessionRetirementReaders([reader], async () => {
      const facts = await reader.read({ operation: "keys" });
      seedClaim({ databaseAgentId: "ops", databasePath: pathname, key: "agent:ops:late" });
      return facts;
    }),
  ).rejects.toBeInstanceOf(SessionEntryChangedDuringReadError);
});

it.each(["refusal", "eviction"] as const)(
  "settles an ordered retirement %s without waiting on its following writer",
  async (settlement) => {
    const fixture = createFixture();
    const pathname = databasePath(fixture.stateDir, "ops");
    const key = "agent:ops:retirement";
    seedClaim({ databaseAgentId: "ops", databasePath: pathname, key });
    const options = { agentId: "ops", path: pathname, env: fixture.env };
    const cleanupEntered = createDeferredCore();
    const releaseCleanup = createDeferredCore();
    const writerSettled = createDeferredCore();
    const readFailure = new Error("Retirement reader failed after dispatch");
    let following: Promise<string> | undefined;
    const cleanup = vi.spyOn(maintenanceLane.pool, "rotate").mockImplementation(() => {
      cleanupEntered.resolve();
      return Promise.race([writerSettled.promise, releaseCleanup.promise]);
    });
    const pools = [maintenanceLane, targetDiscoveryLane].flatMap(({ pool }) => {
      const run = pool.run.bind(pool);
      return [
        vi.spyOn(pool, "canCloseNativeResources").mockReturnValue(false),
        vi.spyOn(pool, "run").mockImplementation(async (input, controls) => {
          const request = typeof input === "function" ? await input() : input;
          if (request.kind !== "session-retirement-read") {
            return run(request, controls);
          }
          following = runOpenClawAgentWriteAdmission(options, () => {
            writerSettled.resolve();
            return "following writer";
          });
          if (settlement === "refusal") {
            throw readFailure;
          }
          return {
            ok: true,
            value: { kind: "session-retirement-read", result: { operation: "keys", keys: [key] } },
            closedHistoryDatabase: request.database,
          };
        }),
      ];
    });
    const reading = listSessionEntryKeysReadOnly({ ...options, storePath: pathname });
    try {
      const outcome = await Promise.race([
        reading.catch((error: unknown) => error),
        cleanupEntered.promise.then(
          () => new Error("Retirement cleanup waits on its own queued writer"),
        ),
      ]);
      if (settlement === "refusal") {
        expect(outcome).toBe(readFailure);
      } else {
        expect(outcome).toEqual([key]);
      }
      await expect(following).resolves.toBe("following writer");
    } finally {
      releaseCleanup.resolve();
      await Promise.allSettled([reading, following]);
      cleanup.mockRestore();
      for (const spy of pools) {
        spy.mockRestore();
      }
    }
  },
);
