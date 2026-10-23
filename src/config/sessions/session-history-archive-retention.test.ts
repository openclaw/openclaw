import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Compilable } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { useSqliteWorkerFault } from "../../../test/helpers/sqlite-worker-fault.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { ensureSessionTranscriptArchiveSchema } from "../../state/openclaw-agent-session-transcript-archive-schema.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { prunePublishedSessionArchivesByRetention } from "./session-accessor.sqlite-archive-store.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import * as pageReclamation from "./session-accessor.sqlite-page-reclamation.js";
import {
  getSessionKysely,
  resolveSqliteTranscriptArchiveDirectory,
  runExclusiveSqliteSessionWrite,
} from "./session-accessor.sqlite-scope.js";
import type {
  PublishedSessionTranscriptArchive,
  SessionArchivePruningOperations,
} from "./session-history-archive-pruning.types.js";

const deletionFault = useSqliteWorkerFault([
  {
    name: "refuse_late_archive_retention",
    match: /^delete from session_transcript_archives\b/u,
    sql: `CREATE TEMP TRIGGER refuse_late_archive_retention
      BEFORE DELETE ON main.session_transcript_archives
      WHEN OLD.session_id LIKE 'rollback-%' AND
        (SELECT count(*) FROM main.session_transcript_archives
         WHERE session_id LIKE 'rollback-%') = 1
      BEGIN SELECT RAISE(ABORT, 'synthetic late archive retention failure'); END;`,
  },
]);

let state: OpenClawTestState;
let database: OpenClawAgentDatabase;
let directory: string;
const options = () => ({ agentId: "main", path: database.path, env: state.env });
const db = () => getSessionKysely(database.db);
const rows = <T>(query: Compilable<T>) => executeSqliteQuerySync(database.db, query).rows;
const archiveRows = () =>
  rows(db().selectFrom("session_transcript_archives").selectAll().orderBy("session_id"));
const retainedIds = () =>
  rows(
    db().selectFrom("session_transcript_archives").select("session_id").orderBy("session_id"),
  ).map((row) => row.session_id);
const scope = (sessionKey: string) => ({
  agentId: "main",
  storePath: database.path,
  env: state.env,
  sessionKey,
});
const prune = () =>
  prunePublishedSessionArchivesByRetention({
    scope: options(),
    nowMs: 100,
    rules: [{ reason: "deleted", olderThanMs: 10 }],
  });

beforeAll(async () => {
  state = await createOpenClawTestState({
    prefix: "archive-retention-",
    scenario: "minimal",
    layout: "state-only",
  });
  database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
  ensureSessionTranscriptArchiveSchema(database.db);
  directory = resolveSqliteTranscriptArchiveDirectory(options());
  fs.mkdirSync(directory, { recursive: true });
});

beforeEach(() => {
  database = openOpenClawAgentDatabase(options());
  rows(db().deleteFrom("session_transcript_archives"));
  rows(db().deleteFrom("session_nodes"));
  for (const name of fs.readdirSync(directory)) {
    if (name.endsWith(".retention-test")) {
      fs.unlinkSync(path.join(directory, name));
    }
  }
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => state.cleanup());

type Archive = Omit<PublishedSessionTranscriptArchive, "published_at"> & {
  published_at: number | null;
};
function updateArchive(sessionId: string, patch: Partial<Archive>) {
  rows(
    db().updateTable("session_transcript_archives").set(patch).where("session_id", "=", sessionId),
  );
}
function seed(sessionId: string, overrides: Partial<Archive> = {}) {
  const row = {
    session_id: sessionId,
    session_key: `agent:main:${sessionId}`,
    generation: "retained-generation",
    archive_name: `${sessionId}.retention-test`,
    archive_sha256: createHash("sha256").update("synthetic history").digest("hex"),
    encoding: "identity",
    reason: "deleted",
    created_at: 1,
    published_at: 1,
    ...overrides,
  };
  rows(
    db()
      .insertInto("session_transcript_archives")
      .values({ ...row, archive_blob: Buffer.from("synthetic history") }),
  );
  return row;
}

function interceptArchives(
  wrap: (archives: SessionArchivePruningOperations) => Partial<SessionArchivePruningOperations>,
) {
  const withPages = pageReclamation.withSqliteSessionPageReclamation;
  vi.spyOn(pageReclamation, "withSqliteSessionPageReclamation").mockImplementation(
    <T>(...args: Parameters<typeof withPages<T>>) => {
      const [input, run] = args;
      return withPages(input, (reclaim, assertCurrent, prepared, archives) =>
        run(reclaim, assertCurrent, prepared, { ...archives, ...wrap(archives) }),
      );
    },
  );
}

it("prunes through the worker while preserving reason, age, path, and file rules", async () => {
  seed("expired");
  seed("boundary", { created_at: 90 });
  seed("reset", { reason: "reset" });
  seed("outside", { archive_name: ".." });
  const present = seed("present");
  fs.writeFileSync(path.join(directory, present.archive_name), "retained");
  seed("pending", { published_at: null });
  const prepare = vi.spyOn(requireNodeSqlite().DatabaseSync.prototype, "prepare");
  expect(await prune()).toBe(1);
  const hostArchiveQueries = prepare.mock.calls.filter(([sql]) =>
    /(?:from|into|update)\s+["`]?session_transcript_archives/i.test(sql),
  );
  prepare.mockRestore();
  expect(hostArchiveQueries).toEqual([]);
  expect(retainedIds()).toEqual(["boundary", "outside", "pending", "present", "reset"]);
});

it("selects at most 256 published rows in stable order before applying retention rules", async () => {
  for (let index = 257; index >= 0; index -= 1) {
    seed(`bounded-${String(index).padStart(3, "0")}`);
  }
  expect(await prune()).toBe(256);
  expect(retainedIds()).toEqual(["bounded-256", "bounded-257"]);
});

it("rolls back the entire retention batch on a late delete failure and permits retry", async () => {
  seed("prime-retention-owner");
  expect(await prune()).toBe(1);
  for (let index = 0; index < 16; index++) {
    seed(`rollback-${String(index).padStart(3, "0")}`);
  }
  seed("retained-reset", { reason: "reset" });
  const before = archiveRows();
  deletionFault.enable();
  try {
    await expect(prune()).rejects.toThrow("synthetic late archive retention failure");
    database = openOpenClawAgentDatabase(options());
    expect(archiveRows()).toEqual(before);
  } finally {
    deletionFault.disable();
  }

  expect(await prune()).toBe(16);
  expect(archiveRows()).toEqual(before.filter((row) => row.session_id === "retained-reset"));
});

it("admits foreground writes during retention selection and between deletion batches", async ({
  signal,
}) => {
  for (let index = 0; index < 17; index++) {
    seed(`batch-${String(index).padStart(3, "0")}`);
  }
  const entered = createDeferred();
  const release = createDeferred();
  const target = scope("agent:main:retention-owner");
  replaceSessionEntrySync(target, { sessionId: "live-generation", updatedAt: Date.now() });
  const writeForeground = (previousSessionId?: string) =>
    runExclusiveSqliteSessionWrite(
      options(),
      async () =>
        replaceSessionEntrySync(target, {
          sessionId: "live-generation",
          updatedAt: Date.now(),
          label: previousSessionId ?? "selection write",
          ...(previousSessionId ? { previousSessionId } : {}),
        }),
      "session-entry.patch",
    );
  let selectionWrite: Promise<unknown> | undefined;
  let foreground: Promise<unknown> | undefined;
  interceptArchives((archives) => ({
    readRetentionCandidates: async () => {
      entered.resolve();
      await release.promise;
      return archives.readRetentionCandidates();
    },
    pruneRetention: async (retention) => {
      const removed = await archives.pruneRetention(retention);
      // Queue while the first batch still owns the writer.
      foreground ??= writeForeground("batch-016");
      return removed;
    },
  }));
  const work = prune();
  try {
    await withinTest(
      awaitGateBeforeSettlement(entered.promise, work, "retention never reached selection"),
      signal,
    );
    selectionWrite = writeForeground();
    await withinTest(selectionWrite, signal);
    release.resolve();
    expect(await withinTest(work, signal)).toBe(16);
    await foreground;
    expect(retainedIds()).toEqual(["batch-016"]);
  } finally {
    release.resolve();
    await Promise.allSettled([work, foreground, selectionWrite]);
  }
});

it.each(["changed", "revoked", "rejected"])(
  "rechecks a delayed retention delete when candidates are %s",
  async (outcome) => {
    const candidates =
      outcome === "changed"
        ? ["created", "file", "generation", "name", "publication", "reference"]
        : ["candidate"];
    const candidatesBefore = candidates.map((sessionId) => seed(sessionId));
    seed("unaffected");
    replaceSessionEntrySync(scope("agent:main:owner"), {
      sessionId: "live-generation",
      updatedAt: 1,
    });
    const entered = createDeferred();
    const release = createDeferred();
    let attempts = 0;
    interceptArchives((archives) => ({
      pruneRetention: async (retention) => {
        attempts += 1;
        entered.resolve();
        await release.promise;
        if (outcome === "rejected") {
          throw new Error("injected retention rejection");
        }
        return archives.pruneRetention(retention);
      },
    }));
    const work = prune();
    try {
      await awaitGateBeforeSettlement(entered.promise, work, "retention never reached deletion");
      expect(retainedIds()).toEqual([...candidates, "unaffected"]);
      if (outcome === "revoked") {
        closeOpenClawAgentDatabaseByPath(database.path);
      } else if (outcome === "changed") {
        updateArchive("created", { created_at: 99 });
        const file = candidatesBefore.find((row) => row.session_id === "file")!;
        fs.writeFileSync(path.join(directory, file.archive_name), "republished");
        for (const [id, patch] of [
          ["generation", { generation: "replacement-generation" }],
          ["name", { archive_name: "replacement.retention-test" }],
          ["publication", { published_at: null }],
        ] as const) {
          updateArchive(id, patch);
        }
        rows(db().updateTable("session_nodes").set({ current_session_id: "reference" }));
      }
      release.resolve();
      if (outcome !== "changed") {
        await expect(work).rejects.toThrow(/revoked|closed|injected retention rejection/);
        if (outcome === "revoked") {
          await closeOpenClawAgentDatabaseByPathAsync(database.path);
        }
        database = openOpenClawAgentDatabase(options());
        expect(retainedIds()).toEqual([...candidates, "unaffected"]);
      } else {
        expect(await work).toBe(1);
        expect(retainedIds()).toEqual(candidates);
      }
      expect(attempts).toBe(1);
    } finally {
      release.resolve();
      await Promise.allSettled([work]);
    }
  },
);
