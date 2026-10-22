import { expect, it, onTestFinished } from "vitest";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { prepareSessionGenerationFacts } from "./session-delivery-generation.js";

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
    expect(generation.readSessionSettings()).toEqual(settings);

    const version = database.db.prepare("PRAGMA data_version").get()?.data_version;
    const write = database.db.prepare(
      "UPDATE session_nodes SET current_session_id = ?, entry_json = ? WHERE session_key = ?",
    );
    write.run(
      field === "current_session_id" ? value : original.sessionId,
      JSON.stringify(field === "current_session_id" ? metadata : { ...metadata, [field]: value }),
      scope.sessionKey,
    );
    expect(database.db.prepare("PRAGMA data_version").get()?.data_version).toBe(version);
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
  let callbacks = 0;
  requireNativeSqliteDatabase(database.db).function("assert_delivery_fenced", () => {
    callbacks += 1;
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
  expect(callbacks).toBe(5);
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
