import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import {
  closeOpenClawAgentDatabaseByPath,
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
} from "./session-accessor.sqlite-scope.js";
import type { PublishedSessionTranscriptArchive } from "./session-history-archive-pruning.types.js";

let state: OpenClawTestState;
let database: OpenClawAgentDatabase;
let directory: string;
const options = () => ({ agentId: "main", path: database.path, env: state.env });
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
  const db = getSessionKysely(database.db);
  executeSqliteQuerySync(database.db, db.deleteFrom("session_transcript_archives"));
  executeSqliteQuerySync(database.db, db.deleteFrom("session_nodes"));
  for (const name of fs.readdirSync(directory)) {
    if (name.endsWith(".retention-test")) {
      fs.unlinkSync(path.join(directory, name));
    }
  }
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => state.cleanup());

function seed(sessionId: string, overrides: Partial<PublishedSessionTranscriptArchive> = {}) {
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
  executeSqliteQuerySync(
    database.db,
    getSessionKysely(database.db)
      .insertInto("session_transcript_archives")
      .values({ ...row, archive_blob: Buffer.from("synthetic history") }),
  );
  return row;
}

function retainedIds() {
  return executeSqliteQuerySync(
    database.db,
    getSessionKysely(database.db)
      .selectFrom("session_transcript_archives")
      .select("session_id")
      .orderBy("session_id"),
  ).rows.map((row) => row.session_id);
}

it("prunes through the worker while preserving reason, age, path, and file rules", async () => {
  seed("expired");
  seed("boundary", { created_at: 90 });
  seed("reset", { reason: "reset" });
  seed("outside", { archive_name: ".." });
  const present = seed("present");
  fs.writeFileSync(path.join(directory, present.archive_name), "retained");
  seed("pending");
  executeSqliteQuerySync(
    database.db,
    getSessionKysely(database.db)
      .updateTable("session_transcript_archives")
      .set({ published_at: null })
      .where("session_id", "=", "pending"),
  );
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

it.each([
  "publication",
  "generation",
  "name",
  "created",
  "reference",
  "file",
  "revoked",
  "rejected",
])("rechecks a delayed retention delete after %s changes", async (change) => {
  const row = seed("candidate");
  seed("unaffected");
  replaceSessionEntrySync(
    { agentId: "main", storePath: database.path, env: state.env, sessionKey: "agent:main:owner" },
    { sessionId: "live-generation", updatedAt: 1 },
  );
  const entered = createDeferred();
  const release = createDeferred();
  const withPages = pageReclamation.withSqliteSessionPageReclamation;
  let attempts = 0;
  vi.spyOn(pageReclamation, "withSqliteSessionPageReclamation").mockImplementation(
    <T>(...args: Parameters<typeof withPages<T>>) => {
      const [input, run] = args;
      return withPages(input, (reclaim, assertCurrent, prepared, archives) =>
        run(reclaim, assertCurrent, prepared, {
          ...archives,
          pruneRetention: async (retention) => {
            attempts += 1;
            entered.resolve();
            await release.promise;
            if (change === "rejected") {
              throw new Error("injected retention rejection");
            }
            return archives.pruneRetention(retention);
          },
        }),
      );
    },
  );
  const work = prune();
  try {
    await awaitGateBeforeSettlement(entered.promise, work, "retention never reached deletion");
    expect(retainedIds()).toEqual(["candidate", "unaffected"]);
    const db = getSessionKysely(database.db);
    if (change === "reference") {
      executeSqliteQuerySync(
        database.db,
        db.updateTable("session_nodes").set({ current_session_id: row.session_id }),
      );
    } else if (change === "file") {
      fs.writeFileSync(path.join(directory, row.archive_name), "republished");
    } else if (change === "revoked") {
      closeOpenClawAgentDatabaseByPath(database.path);
    } else if (change !== "rejected") {
      executeSqliteQuerySync(
        database.db,
        db
          .updateTable("session_transcript_archives")
          .set(
            change === "publication"
              ? { published_at: null }
              : change === "generation"
                ? { generation: "replacement-generation" }
                : change === "name"
                  ? { archive_name: "replacement.retention-test" }
                  : { created_at: 99 },
          )
          .where("session_id", "=", row.session_id),
      );
    }
    release.resolve();
    if (change === "revoked" || change === "rejected") {
      await expect(work).rejects.toThrow(/revoked|closed|injected retention rejection/);
      database = openOpenClawAgentDatabase(options());
      expect(retainedIds()).toEqual(["candidate", "unaffected"]);
    } else {
      expect(await work).toBe(1);
      expect(retainedIds()).toEqual(["candidate"]);
    }
    expect(attempts).toBe(1);
  } finally {
    release.resolve();
    await Promise.allSettled([work]);
  }
});
