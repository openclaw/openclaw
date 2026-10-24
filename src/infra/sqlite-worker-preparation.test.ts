import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { waitForFixtureFile } from "../../test/helpers/process-wait.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { SqliteWorkerBroker } from "./sqlite-worker-broker.js";
import {
  useSqliteWorkerStoreFixture,
  appendWorkerRow as append,
  readWorkerRows as read,
} from "./sqlite-worker-fixture.test-support.js";
import { runSqliteWorkerStoreWrite } from "./sqlite-worker-store.js";

const { tempDirs: dirs, open } = useSqliteWorkerStoreFixture("sqlite-worker-preparation-");
function preparationPaths() {
  const root = dirs.make("sqlite-worker-preparation-");
  return {
    databasePath: path.join(root, "store.sqlite"),
    markerPath: path.join(root, "preparing"),
    gatePath: path.join(root, "release"),
  };
}
async function waitForPreparation(marker: string, operation: Promise<unknown>) {
  await Promise.race([
    waitForFixtureFile(marker, operation),
    operation.then(() => {
      throw new Error("Command executed before its code preparation");
    }),
  ]);
}

it.each([
  { mib: 40, owner: "client" },
  { mib: 0, owner: "host" },
] as const)(
  "retains captured FIFO, cancellation, and $owner close while preparing a $mib MiB command",
  async ({ mib, owner }) => {
    const { databasePath, markerPath, gatePath } = preparationPaths();
    const store = await open(databasePath, { type: "prepare", markerPath, gatePath });
    const activeCancel = new AbortController();
    const queuedCancel = new AbortController();
    const value = mib ? "x".repeat(mib * 1024 * 1024) : "first";
    let settled = false;
    const active = append(store, value, activeCancel.signal).then((receipt) => {
      settled = true;
      return receipt;
    });
    let canceled: Promise<unknown> | undefined;
    let following: Promise<unknown> | undefined;
    let closing: Promise<void> | undefined;
    try {
      await waitForPreparation(markerPath, active);
      expect(settled).toBe(false);
      canceled = append(store, "canceled", queuedCancel.signal);
      const reason = new Error("Cancel the queued command");
      queuedCancel.abort(reason);
      await expect(canceled).rejects.toBe(reason);
      const next = { type: "append" as const, input: { value: "second" } };
      following = store.execute(next);
      next.input.value = "mutated after enqueue";
      activeCancel.abort(new Error("Dispatched preparation remains owned"));
      let closed = false;
      closing = (
        owner === "client" ? store.close() : drainGlobalSingletonLifecycleState("restart")
      ).then(() => {
        closed = true;
      });
      await expect(read(store)).rejects.toMatchObject({ code: "closed" });
      expect(closed).toBe(false);
      await writeFile(gatePath, "release preparation");
      const first = await active;
      expect(first).toMatchObject({
        writes: 1,
        readerOwnership: {
          execution: { operation: "append", ownerKind: "worker", actorId: expect.any(Number) },
        },
      });
      expect(first.readerOwnership?.preparation).toEqual([
        first.readerOwnership?.execution,
        first.readerOwnership?.execution,
      ]);
      expect(await following).toMatchObject({ writes: 2, readerOwnership: first.readerOwnership });
      await closing;
      expect(closed).toBe(true);
      const reopened = await open(databasePath);
      const digest = (text: string) => createHash("sha256").update(text).digest("hex");
      expect((await read(reopened)).map(digest)).toEqual([value, "second"].map(digest));
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
    const { databasePath, markerPath, gatePath } = preparationPaths();
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
      await waitForPreparation(markerPath, operation);
      current = false;
      await writeFile(gatePath, "release preparation");
      const [result] = await outcome;
      expect(result).toMatchObject({
        status: "rejected",
        reason: {
          message: failure === "revoked" ? refused.message : "Fixture code preparation failed",
        },
      });
      expect(await read(store)).toEqual([]);
      await store.close();
      const reopened = await open(databasePath);
      expect(await read(reopened)).toEqual([]);
      expect(await append(reopened, "after refusal")).toMatchObject({ writes: 1 });
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
    const opening = broker.open<PreparedFixture>(options, undefined, undefined, { preparation });
    preparation.key = "changed-after-admission";
    const clients = [
      await opening,
      await broker.open<PreparedFixture>(options),
      await broker.open<PreparedFixture>(options, undefined, undefined, {
        preparation: { key: "must-not-reinitialize" },
      }),
    ];
    expect(await readFile(databasePath, "utf8")).toBe("captured");
    for (const store of clients) {
      assert.ok(store);
      expect(await store.execute({ type: "read", input: undefined })).toEqual({
        preparation: { key: "captured" },
        input: undefined,
      });
    }
    await Promise.all(
      clients.map((store) => {
        assert.ok(store);
        return store.close();
      }),
    );
  } finally {
    await broker.close();
  }
});
