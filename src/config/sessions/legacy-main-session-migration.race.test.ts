import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import {
  prepareSystemAgentRunAdmission,
  resolveAdmittedRunActiveAssertion,
} from "../../agents/admitted-run-context.js";
import { resetAgentRunRegistryForTest } from "../../infra/agent-run-registry.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../../state/openclaw-state-db-readonly.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { migrateLegacyMainSessionKeys } from "./legacy-main-session-migration.js";
import {
  databasePath,
  setupLegacyMainSessionMigrationTests,
} from "./legacy-main-session-migration.test-support.js";
import { readExactSessionEntryRowForCanonicalRepair } from "./session-accessor.sqlite-canonical-repair.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { replaceSessionOwnerInTransaction } from "./session-accessor.sqlite-owner.js";
import { readTranscriptEventRows } from "./session-accessor.sqlite-read.js";
import { runExclusiveSqliteSessionWrite } from "./session-accessor.sqlite-scope.js";
import { appendTranscriptEventInTransaction } from "./session-accessor.sqlite-transcript-store.js";

const race = vi.hoisted(() => ({
  beforeDelete: undefined as (() => void) | undefined,
  afterDelete: undefined as (() => void) | undefined,
  queued: undefined as ((pathname: string | undefined) => void) | undefined,
}));

vi.mock("./session-accessor.sqlite-scope.js", async (original) => {
  const actual = await original<typeof import("./session-accessor.sqlite-scope.js")>();
  return {
    ...actual,
    runExclusiveSqliteSessionWrite: (
      ...args: Parameters<typeof actual.runExclusiveSqliteSessionWrite>
    ) => {
      const pending = actual.runExclusiveSqliteSessionWrite(...args);
      race.queued?.(args[0].path);
      return pending;
    },
  };
});

vi.mock("./session-accessor.sqlite-lifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-accessor.sqlite-lifecycle.js")>();
  return {
    ...actual,
    deleteSessionEntryLifecycle: async (
      params: Parameters<typeof actual.deleteSessionEntryLifecycle>[0],
    ) => {
      const beforeDelete = race.beforeDelete;
      race.beforeDelete = undefined;
      beforeDelete?.();
      const result = await actual.deleteSessionEntryLifecycle(params);
      const afterDelete = race.afterDelete;
      race.afterDelete = undefined;
      afterDelete?.();
      return result;
    },
  };
});

afterEach(() => {
  race.beforeDelete = undefined;
  race.afterDelete = undefined;
  race.queued = undefined;
  resetAgentRunRegistryForTest();
});
const { createFixture } = setupLegacyMainSessionMigrationTests();

async function holdWriter(agentId: string, dbPath: string, env: NodeJS.ProcessEnv, label: string) {
  const entered = createDeferred();
  const resume = createDeferred();
  const pending = runExclusiveSqliteSessionWrite(
    { agentId, path: dbPath, env },
    async () => {
      entered.resolve();
      await resume.promise;
    },
    label,
  );
  await entered.promise;
  return { pending, resume: () => resume.resolve() };
}

function claim(agentId: string, dbPath: string, env: NodeJS.ProcessEnv, key: string) {
  const options = { agentId, path: dbPath, env };
  const write = (run: Parameters<typeof runOpenClawAgentWriteTransaction>[0]) =>
    runOpenClawAgentWriteTransaction(run, options);
  const read = () => {
    const result = withOpenClawAgentDatabaseReadOnly((database) => {
      const entry = readExactSessionEntryRowForCanonicalRepair(database, key)?.entry;
      return (
        entry && {
          entry,
          events: readTranscriptEventRows(database, entry.sessionId).map((row) => row.eventJson),
        }
      );
    }, options);
    return result.found ? result.value : undefined;
  };
  const appendTo = (database: OpenClawAgentDatabase, id: string) =>
    appendTranscriptEventInTransaction(
      database,
      { ...options, sessionId: "race-session", sessionKey: key },
      { id, type: "message" },
      { allowStoredAlias: true },
    );
  const append = (id: string) => write((database) => appendTo(database, id));
  const seed = () =>
    write((database) => {
      const entry = {
        sessionId: "race-session",
        updatedAt: 100,
        owner: { actor: { type: "human" as const, id: "migration-owner" }, assignedAt: 40 },
      };
      writeSessionEntry(database, key, entry, {
        allowStoredAliases: true,
        previousEntry: null,
      });
      replaceSessionOwnerInTransaction(database, key, entry.owner);
      appendTo(database, "event-1");
    });
  return { read, seed, append, write };
}

it.each(["import queue", "in-place queue", "cleanup queue", "ledger"] as const)(
  "preserves committed work but defers new migration writes after closure at %s",
  async (boundary) => {
    await withOpenClawTestState({ label: "migration-lifetime" }, async (state) => {
      const mainPath = databasePath(state.stateDir, "main");
      const opsPath = databasePath(state.stateDir, "ops");
      const inPlace = boundary === "in-place queue";
      const sourceAgentId = inPlace ? "ops" : "main";
      const sourcePath = inPlace ? opsPath : mainPath;
      const cfg = {
        agents: { entries: { ops: {} } },
        ...(inPlace ? { session: { store: opsPath } } : {}),
      };
      const migrate = (beforePersistentApply?: () => void) =>
        migrateLegacyMainSessionKeys({
          cfg,
          env: state.env,
          mode: "doctor-fix",
          beforePersistentApply,
        });
      await state.writeConfig(cfg);
      const source = claim(sourceAgentId, sourcePath, state.env, "agent:main:chat");
      const destination = claim("ops", opsPath, state.env, "agent:ops:chat");
      source.seed();
      const original = source.read()!;
      const admission = prepareSystemAgentRunAdmission(cfg, "migration-race", "ops", "setup");
      const beforePersistentApply = resolveAdmittedRunActiveAssertion(
        await admission.admit("embedded"),
      )!;
      const queued = createDeferred();
      let blocker: Awaited<ReturnType<typeof holdWriter>> | undefined;
      let migration: Promise<unknown> | undefined;
      const readLedger = () =>
        withExistingOpenClawStateDatabaseReadOnly(
          ({ db }) =>
            db
              .prepare(
                "SELECT * FROM migration_sources WHERE source_key = 'legacy-main-session-keys'",
              )
              .all(),
          { env: state.env },
        );
      const ledgerBefore = readLedger();
      try {
        if (boundary === "ledger") {
          race.afterDelete = () => admission.close();
        } else {
          const blockedPath = boundary === "cleanup queue" ? mainPath : opsPath;
          blocker = await holdWriter(
            boundary === "cleanup queue" ? "main" : "ops",
            blockedPath,
            state.env,
            "session-migration.legacy-main-in-place",
          );
          race.queued = (pathname) => {
            if (pathname === blockedPath) {
              race.queued = undefined;
              queued.resolve();
            }
          };
        }
        migration = migrate(beforePersistentApply).then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        );
        if (boundary !== "ledger") {
          await withTestTimeout(
            Promise.race([
              queued.promise,
              migration.then(() => {
                throw new Error("migration ended before writer queue");
              }),
            ]),
            10_000,
            "migration never queued",
          );
          beforePersistentApply();
          admission.close();
          blocker?.resume();
        }
        expect
          .soft(await migration)
          .toMatchObject({ error: new Error("admitted run authority is no longer active") });
        expect.soft(readLedger()).toEqual(ledgerBefore);
        const copied = boundary === "cleanup queue" || boundary === "ledger";
        expect.soft(source.read()).toEqual(boundary === "ledger" ? undefined : original);
        const retained = destination.read();
        if (copied) {
          expect
            .soft([retained?.events, retained?.entry.owner])
            .toEqual([original.events, original.entry.owner]);
        } else {
          expect.soft(retained).toBeUndefined();
          if (!inPlace) {
            expect.soft(fs.existsSync(opsPath)).toBe(false);
          }
        }
        expect((await migrate()).complete).toBe(true);
        expect(source.read()).toBeUndefined();
        const recoveredClaim = destination.read();
        expect([recoveredClaim?.events, recoveredClaim?.entry.owner]).toEqual([
          original.events,
          original.entry.owner,
        ]);
        expect(readLedger()).toEqual([expect.objectContaining({ status: "completed" })]);
      } finally {
        race.queued = undefined;
        race.afterDelete = undefined;
        blocker?.resume();
        await blocker?.pending;
        await migration;
        admission.close();
      }
    });
  },
);

async function runCleanupRace(
  mutateSource: (source: ReturnType<typeof claim>) => void,
  boundary: "copy" | "cleanup" = "cleanup",
) {
  const { stateDir, env, cfg } = createFixture();
  const mainPath = databasePath(stateDir, "main");
  const opsPath = databasePath(stateDir, "ops");
  const source = claim("main", mainPath, env, "agent:main:chat");
  const destination = claim("ops", opsPath, env, "agent:ops:chat");
  source.seed();
  let blocker: Awaited<ReturnType<typeof holdWriter>> | undefined;
  if (boundary === "cleanup") {
    race.beforeDelete = () => mutateSource(source);
  } else {
    blocker = await holdWriter("ops", opsPath, env, "session.import.batch");
    race.queued = (pathname) => {
      if (pathname === opsPath) {
        race.queued = undefined;
        mutateSource(source);
        blocker?.resume();
      }
    };
  }

  try {
    const result = await migrateLegacyMainSessionKeys({ cfg, env, mode: "doctor-fix" });
    return { source, destination, result };
  } finally {
    blocker?.resume();
    await blocker?.pending;
  }
}

it.each(["copy", "cleanup"] as const)(
  "preserves changed source history before %s",
  async (boundary) => {
    const { source, destination, result } = await runCleanupRace(
      (target) => target.append("event-2"),
      boundary,
    );

    expect(result.complete).toBe(false);
    expect(result.outcomes.map((outcome) => outcome.kind)).toContain("divergent-canonical");
    expect(source.read()?.events).toHaveLength(2);
    if (boundary === "copy") {
      expect(destination.read()).toBeUndefined();
    } else {
      expect(destination.read()?.events).toHaveLength(1);
    }
  },
);

it("preserves both claims when the source entry becomes locked before cleanup", async () => {
  const { source, destination, result } = await runCleanupRace((target) => {
    target.write((database) => {
      const key = "agent:main:chat";
      const current = readExactSessionEntryRowForCanonicalRepair(database, key)?.entry;
      if (!current) {
        throw new Error("missing race source entry");
      }
      writeSessionEntry(
        database,
        key,
        { ...current, modelSelectionLocked: true },
        { allowStoredAliases: true, previousEntry: current },
      );
    });
  });

  expect(result.complete).toBe(false);
  expect(result.outcomes.map((outcome) => outcome.kind)).toContain("divergent-canonical");
  expect(source.read()?.entry.modelSelectionLocked).toBe(true);
  expect(destination.read()?.events).toHaveLength(1);
});
