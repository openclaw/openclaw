import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db.js";
import { SqliteReclamationRequestRefusedError } from "./session-accessor.sqlite-reclamation-commit.js";
import type { SessionColdReadPreparation } from "./session-cold-storage-read.js";
import type { SessionColdMutationResult } from "./session-cold-storage-worker.js";
import { restoreSessionColdTranscript } from "./session-cold-storage.js";

type Receipt = { result: SessionColdMutationResult; cleanupIncomplete?: boolean };
const observed = vi.hoisted(() => ({
  worker: vi.fn<() => Promise<Receipt[]>>(),
  native: vi.fn(),
  caller: vi.fn(),
  request: vi.fn(),
  release: vi.fn(),
  claimCurrent: true,
}));

vi.mock("../../state/openclaw-agent-db-readonly.js", () => ({
  withOpenClawAgentDatabaseReadOnly: observed.native,
  retainOpenClawAgentDatabaseReadOnly: (options: OpenClawAgentDatabaseOptions) => ({
    found: true,
    database: { path: options.path, db: { prepare: observed.native } },
    claim: {
      assertCurrent() {
        if (!observed.claimCurrent) {
          throw new Error("database owner retired");
        }
      },
      isCurrent: () => observed.claimCurrent,
      release: observed.release,
    },
  }),
}));
vi.mock("./session-accessor.sqlite-scope.js", async () => ({
  toDatabaseOptions: (await import("./session-accessor.sqlite-scope-helpers.js")).toDatabaseOptions,
  prepareSqliteTranscriptReadScope: vi.fn(),
  resolveSqliteTranscriptReadScope: vi.fn(),
  runExclusiveSqliteSessionWrite: async <T>(_options: unknown, run: () => Promise<T>) =>
    await run(),
}));
vi.mock("./session-accessor.sqlite-worker-request.js", () => ({
  withSqliteMutationWorkerLifetime: async <T>(
    _options: unknown,
    run: (owner: {
      assertCurrent: () => void;
      commitGate: SharedArrayBuffer;
      signal: AbortSignal;
    }) => Promise<T>,
  ) =>
    await run({
      assertCurrent: observed.request,
      commitGate: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
      signal: new AbortController().signal,
    }),
}));
vi.mock("./session-accessor.sqlite-reclamation-commit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-accessor.sqlite-reclamation-commit.js")>()),
  withSqliteReclamationAuthorization: async <T>(
    _gate: SharedArrayBuffer,
    _database: unknown,
    assertCurrent: () => void,
    run: (authorize: () => void) => Promise<T>,
  ) => await run(assertCurrent),
}));
vi.mock("./session-accessor.sqlite-archive.js", () => ({
  runSqliteTranscriptArchiveWorkerOperation: observed.worker,
}));
vi.mock("../../state/openclaw-agent-db.js", async () => ({
  resolveOpenClawAgentSqlitePath: (await import("../../state/openclaw-agent-db.paths.js"))
    .resolveOpenClawAgentSqlitePath,
}));

vi.mock("../../state/openclaw-state-worker-context.js", () => ({
  captureOpenClawStateReadWorkerContext: vi.fn(),
}));
vi.mock("./session-accessor.sqlite-page-reclamation.js", () => ({
  withSqliteSessionPageReclamation: vi.fn(),
}));
vi.mock("./session-history-archive-pruning.js", () => ({ reclaimSqliteFreePages: vi.fn() }));
vi.mock("./session-history-eviction.js", () => ({ collectAdmissionProtectedSessionIds: vi.fn() }));

vi.mock("./session-transcript-worker-runtime.js", () => ({
  withSessionHistoryWorkerDatabase: vi.fn(),
}));
vi.mock("./targets.js", () => ({
  resolveSessionStoreTargets: vi.fn(),
}));

const preparation: SessionColdReadPreparation = {
  target: {
    agentId: "main",
    sessionId: "archived-transcript",
    path: "/synthetic/cold-publication.sqlite",
    env: { OPENCLAW_STATE_DIR: "/synthetic/cold-publication" },
  },
  readMetadata: async () => ({
    session_id: "archived-transcript",
    generation: "archived-generation",
    archive_name: "archive.jsonl.zst",
    archive_sha256: "0".repeat(64),
    event_count: 1,
    raw_bytes: 100,
    archive_bytes: 80,
    last_seq: 1,
    archived_at: 1,
    storage: "file",
  }),
};
const result: SessionColdMutationResult = {
  archivedTranscripts: 0,
  externalizedTranscripts: 0,
  restored: true,
  sessionKey: "agent:main:committed-window",
};
const changes = vi.fn();
const factChanges = vi.fn();
let unsubscribe: () => void;

beforeEach(() => {
  vi.resetAllMocks();
  observed.claimCurrent = true;
  observed.native.mockImplementation(() => {
    throw new Error("Restore publication executed SQLite on the calling thread");
  });
  const unsubscribeChanges = sessionChanges.subscribe(changes);
  const unsubscribeFacts = sessionChanges.subscribeFacts(factChanges);
  unsubscribe = () => {
    unsubscribeChanges();
    unsubscribeFacts();
  };
});
afterEach(() => {
  unsubscribe();
  expect(observed.native).not.toHaveBeenCalled();
  expect(observed.release).toHaveBeenCalledOnce();
});

function restore() {
  return restoreSessionColdTranscript(preparation.target, observed.caller, preparation);
}

it("publishes the committed key exactly once after the worker settles, without host SQLite", async () => {
  const entered = createDeferred();
  const settled = createDeferred<Receipt[]>();
  observed.worker.mockImplementation(() => {
    entered.resolve();
    return settled.promise;
  });
  const pending = restore();
  try {
    await awaitGateBeforeSettlement(entered.promise, pending, "Restore worker was not dispatched");
    expect(changes).not.toHaveBeenCalled();
    expect(observed.release).not.toHaveBeenCalled();
  } finally {
    settled.resolve([{ result }]);
    await pending;
  }
  expect(changes).toHaveBeenCalledExactlyOnceWith({
    storePath: preparation.target.path,
    sessionKey: "agent:main:committed-window",
  });
  expect(factChanges).toHaveBeenCalledExactlyOnceWith({
    storePath: preparation.target.path,
    sessionKey: "agent:main:committed-window",
    facts: { kind: "unchanged" },
  });
});

it.each(["refused", "rejected", "cleanup incomplete", "database", "caller", "request"])(
  "does not publish after restoration loses completion or authority: %s",
  async (outcome) => {
    observed.worker.mockImplementation(async () => {
      if (outcome === "refused") {
        throw new SqliteReclamationRequestRefusedError("restore refused");
      }
      if (outcome === "rejected") {
        throw new Error("restore rejected");
      }
      if (outcome === "database") {
        observed.claimCurrent = false;
      } else if (outcome === "caller" || outcome === "request") {
        observed[outcome].mockImplementation(() => {
          throw new Error("restore authority retired");
        });
      }
      return [{ result, ...(outcome === "cleanup incomplete" ? { cleanupIncomplete: true } : {}) }];
    });
    if (outcome === "database") {
      await restore();
    } else {
      await expect(restore()).rejects.toThrow(
        outcome === "cleanup incomplete"
          ? /cleanup is incomplete/
          : outcome === "caller" || outcome === "request"
            ? "restore authority retired"
            : `restore ${outcome}`,
      );
    }
    expect(changes).not.toHaveBeenCalled();
  },
);
