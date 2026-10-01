import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { waitForFixtureFile } from "../../test/helpers/process-wait.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { SqliteWorkerBroker } from "./sqlite-worker-broker.js";
import { useSqliteWorkerStoreFixture } from "./sqlite-worker-fixture.test-support.js";
import { runSqliteWorkerStoreWrite } from "./sqlite-worker-store.js";

const { tempDirs: dirs, open } = useSqliteWorkerStoreFixture("sqlite-worker-preparation-");

it.each([
  { mib: 0, owner: "client" },
  { mib: 40, owner: "client" },
  { mib: 0, owner: "host" },
] as const)(
  "retains FIFO, cancellation, and $owner close while preparing a $mib MiB command",
  async ({ mib, owner }) => {
    const root = dirs.make("sqlite-worker-preparation-");
    const databasePath = path.join(root, "store.sqlite");
    const markerPath = path.join(root, "preparing");
    const gatePath = path.join(root, "release");
    const store = await open(databasePath, { type: "prepare", markerPath, gatePath });
    const activeCancel = new AbortController();
    const queuedCancel = new AbortController();
    const value = mib ? "x".repeat(mib * 1024 * 1024) : "first";
    let settled = false;
    const active = store
      .execute({ type: "append", input: { value } }, { signal: activeCancel.signal })
      .then((receipt) => {
        settled = true;
        return receipt;
      });
    let canceled: Promise<unknown> | undefined;
    let following: Promise<unknown> | undefined;
    let closing: Promise<void> | undefined;
    try {
      await Promise.race([
        waitForFixtureFile(markerPath, active),
        active.then(() => {
          throw new Error("Command executed before its code preparation");
        }),
      ]);
      expect(settled).toBe(false);
      canceled = store.execute(
        { type: "append", input: { value: "canceled" } },
        { signal: queuedCancel.signal },
      );
      const reason = new Error("Cancel the queued command");
      queuedCancel.abort(reason);
      await expect(canceled).rejects.toBe(reason);
      following = store.execute({ type: "append", input: { value: "second" } });
      activeCancel.abort(new Error("Dispatched preparation remains owned"));
      let closed = false;
      closing = (
        owner === "client" ? store.close() : drainGlobalSingletonLifecycleState("restart")
      ).then(() => {
        closed = true;
      });
      await expect(store.execute({ type: "read", input: undefined })).rejects.toMatchObject({
        code: "closed",
      });
      expect(closed).toBe(false);
      await writeFile(gatePath, "release preparation");
      const first = await active;
      expect(first).toMatchObject({
        writes: 1,
        readerOwnership: {
          preparation: [undefined, undefined],
          execution: { operation: "append", ownerKind: "worker", actorId: expect.any(Number) },
        },
      });
      expect(await following).toMatchObject({ writes: 2, readerOwnership: first.readerOwnership });
      await closing;
      expect(closed).toBe(true);
      const reopened = await open(databasePath);
      const digest = (text: string) => createHash("sha256").update(text).digest("hex");
      expect((await reopened.execute({ type: "read", input: undefined })).map(digest)).toEqual(
        [value, "second"].map(digest),
      );
    } finally {
      queuedCancel.abort();
      await writeFile(gatePath, "release for cleanup");
      await Promise.allSettled([active, canceled, following, closing]);
    }
  },
);

it.each(["revoked", "rejected"] as const)(
  "preserves uncommitted state after %s preparation and permits the next command",
  async (failure) => {
    const root = dirs.make("sqlite-worker-preparation-authority-");
    const databasePath = path.join(root, "store.sqlite");
    const markerPath = path.join(root, "preparing");
    const gatePath = path.join(root, "release");
    const store = await open(databasePath, {
      type: "prepare",
      markerPath,
      gatePath,
      guarded: true,
      reject: failure === "rejected",
    });
    let current = true;
    const refused = new Error("Authority revoked during code preparation");
    const operation = runSqliteWorkerStoreWrite(
      store,
      (scope) => scope.execute({ type: "append", input: { value: "must not commit" } }),
      () => {
        if (!current) {
          throw refused;
        }
      },
      [databasePath],
    );
    const outcome = Promise.allSettled([operation]);
    try {
      await Promise.race([
        waitForFixtureFile(markerPath, operation),
        operation.then(() => {
          throw new Error("Command executed before its code preparation");
        }),
      ]);
      current = false;
      await writeFile(gatePath, "release preparation");
      const [result] = await outcome;
      expect(result).toMatchObject({
        status: "rejected",
        reason: {
          message: failure === "revoked" ? refused.message : "Fixture code preparation failed",
        },
      });
      expect(await store.execute({ type: "read", input: undefined })).toEqual([]);
      await store.close();
      const reopened = await open(databasePath);
      expect(await reopened.execute({ type: "read", input: undefined })).toEqual([]);
      expect(
        await reopened.execute({ type: "append", input: { value: "after refusal" } }),
      ).toMatchObject({ writes: 1 });
    } finally {
      await writeFile(gatePath, "release for cleanup");
      await outcome;
    }
  },
);

type PreparedFixture = {
  read: { input: undefined; output: { preparation?: { key: string }; input: unknown } };
};

it("captures preparation once without changing backend identity for ordinary reuse", async () => {
  const root = dirs.make("openclaw-worker-opening-preparation-");
  const databasePath = path.join(root, "fixture.sqlite");
  const modulePath = path.join(root, "backend.mjs");
  await writeFile(
    modulePath,
    `import { writeFileSync } from "node:fs";
export function createSqliteWorkerBackend(input, context) {
  const preparation = context.preparation;
  writeFileSync(context.databasePath, preparation?.key ?? "ordinary");
  return { execute: () => ({ preparation, input }), close() {} };
}
`,
  );
  const broker = new SqliteWorkerBroker();
  const options = { moduleUrl: pathToFileURL(modulePath), databasePath, input: undefined };
  const preparation = { key: "captured" };
  try {
    const opening = broker.open<PreparedFixture>(options, undefined, undefined, {
      preparation,
    });
    preparation.key = "changed-after-admission";
    const first = await opening;
    assert.ok(first);
    const ordinary = await broker.open<PreparedFixture>(options);
    assert.ok(ordinary);
    const anotherPreparation = await broker.open<PreparedFixture>(options, undefined, undefined, {
      preparation: { key: "must-not-reinitialize" },
    });
    assert.ok(anotherPreparation);

    expect(await readFile(databasePath, "utf8")).toBe("captured");
    for (const store of [first, ordinary, anotherPreparation]) {
      expect(await store.execute({ type: "read", input: undefined })).toEqual({
        preparation: { key: "captured" },
        input: undefined,
      });
    }
    await Promise.all([first.close(), ordinary.close(), anotherPreparation.close()]);
  } finally {
    await broker.close();
  }
});
