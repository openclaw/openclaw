import fs from "node:fs";
import { expect, it, onTestFinished, vi } from "vitest";
import { writeHostFile } from "../../agents/host-file-write.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import {
  bindCommandOwnerAuthority,
  captureCommandOwnerAssertion,
} from "../../auto-reply/command-owner-authority.js";
import * as databaseIdentity from "../../infra/sqlite-worker-identity.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as nativeEntries from "./session-accessor.sqlite-entry-read.js";
import { patchSessionEntryCore, replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { prepareSessionGenerationFacts } from "./session-delivery-generation.js";
import {
  composeSessionSourceAssertion,
  prepareSessionSourceEffect,
} from "./session-source-authority.js";
import * as storeCandidates from "./session-store-read-candidates.js";
import * as workerResources from "./session-transcript-worker-resources.js";

const original = {
  sessionId: "e1234567-1234-1234-1234-123456789abc",
  lifecycleRevision: "original-lifecycle",
  updatedAt: 1,
};
const settings = { permissionMode: "full" as const, toolOverrides: { webSearch: true } };
it.aroundEach((run) => withOpenClawTestState({ scenario: "minimal" }, () => run()));
async function fixture(initialSettings?: typeof settings) {
  const database = openOpenClawAgentDatabase({ agentId: "main" });
  const scope = {
    agentId: "main",
    storePath: database.path,
    sessionKey: "agent:main:native-generation",
  };
  const entry = { ...original, ...initialSettings };
  replaceSessionEntrySync(scope, entry);
  const generation = await prepareSessionGenerationFacts({ ...scope, ...entry });
  onTestFinished(() => generation.release());
  return { database, scope, generation };
}
const generationError = (code = "UNAVAILABLE") =>
  expect.objectContaining({ code: `SESSION_DELIVERY_GENERATION_${code}` });

it("writes under prepared generation and command-owner authority without synchronous probes or SQL", async () => {
  const { database, scope, generation } = await fixture(settings);
  const source = composeSessionSourceAssertion([generation.assertCurrent], (assertSources) => {
    assertSources();
    expect(generation.readSessionSettings()).toMatchObject(settings);
  });
  const warm = await prepareSessionSourceEffect(source);
  warm.assertCurrent();
  await warm.release?.();
  const context = {};
  bindCommandOwnerAuthority(context, {
    sourceAssertion: source,
    isCurrent() {
      source();
      return true;
    },
  });
  const receiptAuthority = captureCommandOwnerAssertion(context);
  expect(receiptAuthority).toBeDefined();
  const file = `${database.path}.effect.txt`;
  await fs.promises.writeFile(file, "original");
  database.db
    .prepare("UPDATE session_nodes SET updated_at = updated_at WHERE session_key = ?")
    .run(scope.sessionKey);
  const delay =
    <Args extends unknown[], Value>(fn: (...args: Args) => Value) =>
    (...args: Args) => {
      const until = performance.now() + 25;
      while (performance.now() < until) {
        // A main-thread probe would reproduce its injected storage latency.
      }
      return fn(...args);
    };
  const assertIdentity = databaseIdentity.assertDatabasePathIdentity;
  const checkCandidate = storeCandidates.isSessionStoreReadCandidateCurrent;
  const readGeneration = nativeEntries.readSessionEntryGenerationInDatabase;
  const identity = vi
    .spyOn(databaseIdentity, "assertDatabasePathIdentity")
    .mockImplementation(delay(assertIdentity));
  const candidates = vi
    .spyOn(storeCandidates, "isSessionStoreReadCandidateCurrent")
    .mockImplementation(delay(checkCandidate));
  const sql = vi.spyOn(database.db, "prepare");
  const nativeReads = vi
    .spyOn(nativeEntries, "readSessionEntryGenerationInDatabase")
    .mockImplementation(delay(readGeneration));
  onTestFinished(() => {
    vi.restoreAllMocks();
  });
  await withGatewayToolCallerIdentity(
    { agentId: scope.agentId, sessionKey: scope.sessionKey, receiptAuthority },
    () => writeHostFile(file, "replacement"),
  );
  expect(await fs.promises.readFile(file, "utf8")).toBe("replacement");
  expect({
    identity: identity.mock.calls.length,
    candidates: candidates.mock.calls.length,
    nativeReads: nativeReads.mock.calls.length,
    sqlPrepare: sql.mock.calls.length,
  }).toEqual({ identity: 0, candidates: 0, nativeReads: 0, sqlPrepare: 0 });
});

it.each([
  { field: "lifecycleRevision", value: "effect-successor", code: "REVOKED" },
  { field: "permissionMode", value: "read-only", code: "UNAVAILABLE" },
  { field: "current_session_id", value: "effect-successor", code: "UNAVAILABLE" },
])(
  "refuses a committed raw $field change during effect preparation",
  async ({ field, value, code }) => {
    const { database, scope, generation } = await fixture(settings);
    const write = database.db.prepare(
      "UPDATE session_nodes SET current_session_id = ?, entry_json = ? WHERE session_key = ?",
    );
    write.run(
      field === "current_session_id" ? value : original.sessionId,
      JSON.stringify(
        field === "current_session_id"
          ? { ...original, ...settings }
          : { ...original, ...settings, [field]: value },
      ),
      scope.sessionKey,
    );
    await expect(prepareSessionSourceEffect(generation.assertCurrent)).rejects.toThrow(
      generationError(code),
    );
    write.run(original.sessionId, JSON.stringify({ ...original, ...settings }), scope.sessionKey);
    expect(generation.assertCurrent).toThrow(generationError(code));
  },
);

it.each(["revision", "release"] as const)(
  "refuses %s changes while the effect identity check is awaited",
  async (change) => {
    const { database, scope, generation } = await fixture();
    const write = database.db.prepare(
      "UPDATE session_nodes SET updated_at = updated_at WHERE session_key = ?",
    );
    const prepare = workerResources.prepareSessionStoreCandidatesInWorker;
    vi.spyOn(workerResources, "prepareSessionStoreCandidatesInWorker").mockImplementation(
      async (request) => {
        const result = await prepare(request);
        if (change === "release") {
          generation.release();
        } else {
          write.run(scope.sessionKey);
        }
        return result;
      },
    );
    onTestFinished(() => {
      vi.restoreAllMocks();
    });
    await expect(prepareSessionSourceEffect(generation.assertCurrent)).rejects.toThrow(
      generationError(),
    );
  },
);

it.each(["runtime", "automation"])(
  "retains generation facts across metadata but invalidates broad %s changes",
  async (scope) => {
    const { generation } = await fixture();
    sessionChanges.emit({ all: true, scope: "profiles" });
    expect(generation.assertCurrent).not.toThrow();
    sessionChanges.emit({ all: true, scope });
    expect(generation.assertCurrent).toThrow(generationError());
  },
);

it.each([
  { field: "lifecycleRevision", value: "raw-successor", code: "REVOKED" },
  { field: "permissionMode", value: "read-only", code: "UNAVAILABLE" },
  { field: "toolOverrides", value: { webSearch: false }, code: "UNAVAILABLE" },
  { field: "current_session_id", value: "raw-successor", code: "UNAVAILABLE" },
] as const)(
  "retires a prepared generation after observing a raw $field mutation on its native handle",
  async ({ field, value, code }) => {
    const { database, scope, generation } = await fixture(settings);
    const metadata = { ...original, ...settings, label: "native metadata" };
    replaceSessionEntrySync(scope, metadata);
    generation.assertCurrent();
    expect(generation.readSessionSettings()).toMatchObject(settings);

    const write = database.db.prepare(
      "UPDATE session_nodes SET current_session_id = ?, entry_json = ? WHERE session_key = ?",
    );
    write.run(
      field === "current_session_id" ? value : original.sessionId,
      JSON.stringify(field === "current_session_id" ? metadata : { ...metadata, [field]: value }),
      scope.sessionKey,
    );
    expect(generation.assertCurrent).toThrow(generationError(code));

    write.run(original.sessionId, JSON.stringify(metadata), scope.sessionKey);
    expect(generation.assertCurrent).toThrow(generationError(code));
  },
);

it("retains unchanged generation authority inside a native transaction and after rollback", async () => {
  const { scope, generation } = await fixture();
  const rollback = new Error("Synthetic transaction rollback");
  expect(() =>
    runOpenClawAgentWriteTransaction(
      ({ db }) => {
        db.prepare("UPDATE session_nodes SET updated_at = updated_at WHERE session_key = ?").run(
          scope.sessionKey,
        );
        generation.assertCurrent();
        db.prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?").run(
          JSON.stringify({ ...original, lifecycleRevision: "tentative-lifecycle" }),
          scope.sessionKey,
        );
        expect(generation.assertCurrent).toThrow(generationError());
        throw rollback;
      },
      { agentId: scope.agentId, path: scope.storePath },
    ),
  ).toThrow(rollback);
  generation.assertCurrent();
});

it("refuses reentrant delivery during raw execution and unfinished RETURNING cursors", async () => {
  const { database, scope, generation } = await fixture();
  requireNativeSqliteDatabase(database.db).function("assert_delivery_fenced", () => {
    expect(generation.assertCurrent).toThrow(generationError());
    return 1;
  });
  // A SELECT can call arbitrary native callbacks without changing a mutation revision.
  database.db.exec("SELECT assert_delivery_fenced()");
  for (const method of ["run", "get", "all"] as const) {
    database.db.prepare("SELECT assert_delivery_fenced()")[method]();
  }
  const read = database.db.prepare("SELECT assert_delivery_fenced()").iterate();
  expect(read.next().done).toBe(false);
  expect(generation.assertCurrent).toThrow(generationError());
  read.return?.();
  generation.assertCurrent();

  const write = database.db.prepare(
    "UPDATE session_nodes SET updated_at = updated_at WHERE session_key = ? RETURNING session_key",
  );
  const rows = write.iterate(scope.sessionKey);
  expect(rows.next().value).toEqual({ session_key: scope.sessionKey });
  expect(generation.assertCurrent).toThrow(generationError());
  rows.return?.();
  generation.assertCurrent();
});

// Windows does not permit replacing the open database files used by this proof.
it.skipIf(process.platform === "win32").each(["before preparation", "during preparation"] as const)(
  "refuses the next guarded write after its database file is replaced %s",
  async (phase) => {
    const { database, scope, generation } = await fixture();
    const foreignPath = `${database.path}.foreign.sqlite`;
    const originalPath = `${database.path}.original`;
    const foreign = openOpenClawAgentDatabase({ agentId: "main", path: foreignPath });
    replaceSessionEntrySync(
      { ...scope, storePath: foreignPath },
      { ...original, label: "foreign owner" },
    );
    const readLabel = (db: typeof database) =>
      db.db
        .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
        .get(scope.sessionKey)?.entry_json;
    expect(String(readLabel(foreign))).toContain("foreign owner");
    generation.assertCurrent();
    const replaceFile = () => {
      fs.renameSync(database.path, originalPath);
      fs.renameSync(foreignPath, database.path);
    };
    let replaced = false;
    try {
      if (phase === "before preparation") {
        replaceFile();
        replaced = true;
      }
      await expect(
        patchSessionEntryCore(
          scope,
          async () => {
            if (!replaced) {
              replaceFile();
              replaced = true;
            }
            await Promise.resolve();
            return { label: "must not persist" };
          },
          { workerGuard: { source: generation.assertCurrent }, skipMaintenance: true },
        ),
      ).rejects.toThrow(/identity|target changed|generation/i);
      expect(replaced).toBe(true);
      expect(String(readLabel(database))).not.toContain("must not persist");
      expect(String(readLabel(foreign))).toContain("foreign owner");
    } finally {
      if (replaced) {
        fs.renameSync(database.path, foreignPath);
        fs.renameSync(originalPath, database.path);
      }
    }
  },
);
