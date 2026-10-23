import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
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
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
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
const restorers: Array<() => void> = [];
afterEach(() => {
  for (const restore of restorers.splice(0)) {
    restore();
  }
  vi.restoreAllMocks();
});

function setup() {
  const fixture = createFixture();
  const store = (agentId = "ops", ownerStorePath?: string) => {
    const path = databasePath(fixture.stateDir, agentId);
    return { databaseAgentId: agentId, ownerStorePath: ownerStorePath ?? path, path };
  };
  const options = (agentId = "ops") => ({ agentId, path: store(agentId).path, env: fixture.env });
  const seed = (
    key = "agent:ops:chat",
    agentId = "ops",
    entry?: Parameters<typeof seedClaim>[0]["entry"],
  ) => seedClaim({ databaseAgentId: agentId, databasePath: store(agentId).path, key, entry });
  const reader = (ownerStorePath?: string) =>
    captureSessionRetirementReader(store("ops", ownerStorePath), fixture.env);
  const list = () => listSessionEntryKeysReadOnly({ ...options(), storePath: store().path });
  return { ...fixture, store, options, seed, reader, list };
}

it("compares retained history without acquiring Doctor deletion custody", () => {
  const fixture = setup();
  const key = "agent:main:chat";
  fixture.seed(key, "main");
  const options = fixture.options("main");
  runOpenClawAgentWriteTransaction(({ db }) => {
    ensureOpenClawAgentBoardSchemaInTransaction(db);
    ensureSessionPendingInputsSchema(db);
    ensureSessionInputCompletionsSchema(db);
  }, options);
  const database = openOpenClawAgentDatabase(options);
  const store = fixture.store("main");
  const observed = trackSqliteStatementExecutions(
    requireNativeSqliteDatabase(database.db),
    ["node", "input"],
    (sql) => {
      if (!/^select /i.test(sql)) {
        return null;
      }
      if (/\b(?:session_pending_inputs|session_input_completions)\b/.test(sql)) {
        return "input";
      }
      const node =
        /\b(?:board_widgets|board_tabs|session_members|session_participants|session_progress_cards|session_suggestions|session_reactions|heartbeat_outcomes)\b/;
      return node.test(sql) || sql.startsWith('select "legacy_acp_migration_json" ')
        ? "node"
        : null;
    },
  );
  restorers.push(observed.restore);
  const comparison = readComparisonClaim(database, store, key, "agent:ops:chat");
  expect(comparison).toMatchObject({
    canonicalKey: "agent:ops:chat",
    key,
    entry: { sessionId: "session-agent-main-chat" },
    generations: [expect.anything()],
  });
  expect(observed.counts).toEqual({ node: 0, input: 0 });
  const custody = readClaim(database, store, key, "agent:ops:chat");
  expect(custody?.generations[0]?.contentFingerprint).toBe(
    comparison?.generations[0]?.contentFingerprint,
  );
  expect(custody?.nodeArtifactFingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(custody?.generations[0]?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(observed.counts.node).toBeGreaterThan(0);
  expect(observed.counts.input).toBe(2);
});

it("keeps detailed legacy detection current after a foreign transcript commit", async () => {
  const fixture = setup();
  const sourcePath = fixture.store("main").path;
  const destinationPath = fixture.store().path;
  const entry = { sessionId: "shared-generation", updatedAt: 100 };
  fixture.seed("agent:main:chat", "main", entry);
  fixture.seed("agent:ops:chat", "ops", entry);
  const detect = () =>
    migrateLegacyMainSessionKeys({
      cfg: fixture.cfg,
      env: fixture.env,
      mode: "detect",
      forceScan: true,
    });
  const outcome = (kind: string, paths: string[], sourceKeys: string[]) => [
    { kind, canonicalKey: "agent:ops:chat", paths, sourceKeys },
  ];
  expect((await detect()).outcomes).toEqual(
    outcome("canonical-exists-identical", [sourcePath], ["agent:main:chat"]),
  );
  runOpenClawAgentWriteTransaction((database) => {
    appendTranscriptEventInTransaction(
      database,
      {
        ...fixture.options(),
        sessionId: entry.sessionId,
        sessionKey: "agent:ops:chat",
      },
      { type: "message", id: "foreign-later", text: "Canonical history changed." },
    );
  }, fixture.options());
  const changed = await detect();
  expect(changed).toMatchObject({ complete: false, ledgerComplete: false, changes: [] });
  expect(changed.outcomes).toEqual(
    outcome(
      "divergent-canonical",
      [destinationPath, sourcePath],
      ["agent:ops:chat", "agent:main:chat"],
    ),
  );
  expect(changed.warnings).toContain(
    `session: divergent-canonical for agent:ops:chat; preserved claims ${destinationPath}#agent:ops:chat, ${sourcePath}#agent:main:chat. Run openclaw doctor --fix to quarantine the losing claims.`,
  );
});

it("lists workspace keys off-thread and rejects a captured absence after a foreign creation", async () => {
  const fixture = setup();
  const readAbsent = fixture.reader();
  expect(await fixture.list()).toEqual([]);
  fixture.seed();
  await expect(readAbsent.read({ operation: "keys" })).rejects.toThrow("identity changed");
  const observed = observeHostDataSql();
  restorers.push(observed.restore);
  expect(await fixture.list()).toEqual(["agent:ops:chat"]);
  expect(observed.queries.filter((sql) => /\bsession_nodes\b/.test(sql))).toEqual([]);
  fixture.seed("agent:ops:later");
  expect(await fixture.list()).toEqual(["agent:ops:chat", "agent:ops:later"]);
  const ownerStorePath = `${fixture.store().path}.json`;
  const readAlias = fixture.reader(ownerStorePath);
  fs.writeFileSync(ownerStorePath, "{}\n");
  await expect(readAlias.read({ operation: "keys" })).rejects.toThrow("identity changed");
});

it("retains missing stores while another legacy store is read", async () => {
  const fixture = setup();
  fixture.seed("agent:main:chat", "main");
  const unreadable: Array<{ path: string; error: unknown }> = [];
  const scan = prepareComparisonClaimsFromStores({
    env: fixture.env,
    legacyAgentId: "main",
    ownerAgentId: "ops",
    stores: [fixture.store("main"), fixture.store()],
    onUnreadable: (store, error) => unreadable.push({ path: store.path, error }),
  });
  const result = scan.read();
  fixture.seed("agent:main:late");
  expect((await result).legacy.map((claim) => claim.key)).toEqual(["agent:main:chat"]);
  expect(unreadable).toEqual([{ path: fixture.store().path, error: expect.anything() }]);
  expect(String(unreadable[0]?.error)).toContain("identity changed");
});

it("refuses retirement facts after a native write bypasses the held FIFO", async () => {
  const fixture = setup();
  fixture.seed();
  const reader = fixture.reader();
  await expect(
    withSessionRetirementReaders([reader], async () => {
      const facts = await reader.read({ operation: "keys" });
      fixture.seed("agent:ops:late");
      return facts;
    }),
  ).rejects.toBeInstanceOf(SessionEntryChangedDuringReadError);
});

it.each(["refusal", "eviction"] as const)(
  "settles an ordered retirement %s without waiting on its following writer",
  async (settlement) => {
    const fixture = setup();
    const key = "agent:ops:retirement";
    fixture.seed(key);
    const cleanupEntered = createDeferredCore();
    const releaseCleanup = createDeferredCore();
    const writerSettled = createDeferredCore();
    const readFailure = new Error("Retirement reader failed after dispatch");
    let following: Promise<string> | undefined;
    vi.spyOn(maintenanceLane.pool, "rotate").mockImplementation(() => {
      cleanupEntered.resolve();
      return Promise.race([writerSettled.promise, releaseCleanup.promise]);
    });
    for (const { pool } of [maintenanceLane, targetDiscoveryLane]) {
      const run = pool.run.bind(pool);
      vi.spyOn(pool, "canCloseNativeResources").mockReturnValue(false);
      vi.spyOn(pool, "run").mockImplementation(async (input, controls) => {
        const request = typeof input === "function" ? await input() : input;
        if (request.kind !== "session-retirement-read") {
          return run(request, controls);
        }
        following = runOpenClawAgentWriteAdmission(fixture.options(), () => {
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
      });
    }
    const reading = fixture.list();
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
    }
  },
);
