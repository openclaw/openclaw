import assert from "node:assert/strict";
import { copyFileSync, renameSync, unlinkSync } from "node:fs";
import { link, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { SqliteWorkerRequest } from "./sqlite-worker-contract.js";
import { openSqliteWorkerStore, type SqliteWorkerStore } from "./sqlite-worker-store.js";
import type { FixtureOpenInput, FixtureOperations } from "./sqlite-worker-store.test-support.js";

const stores = new Set<SqliteWorkerStore<FixtureOperations>>();
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    try {
      await Promise.all([...stores].map((store) => store.close()));
    } finally {
      stores.clear();
      cleanup();
    }
  }),
);

function databasePath(): string {
  return path.join(tempDirs.make("openclaw-sqlite-worker-existing-"), "store.sqlite");
}

async function open(file: string, existingOnly = false, input?: FixtureOpenInput) {
  const store = await openSqliteWorkerStore<FixtureOperations>({
    moduleUrl: new URL("./sqlite-worker-store.test-support.ts", import.meta.url),
    databasePath: file,
    input,
    existingOnly,
  });
  if (store) {
    stores.add(store);
  }
  return store;
}

async function seed(file: string, value: string): Promise<void> {
  const store = await open(file);
  assert.ok(store);
  await store.execute({ type: "append", input: { value } });
  await store.close();
}

describe("existing-only SQLite worker admission", () => {
  it("returns missing without worker dispatch, filesystem creation, or retained client capacity", async () => {
    const file = databasePath();
    const requests = vi.spyOn(Worker.prototype, "postMessage");
    try {
      for (let index = 0; index < 80; index += 1) {
        expect(await open(file, true)).toBeUndefined();
      }
      expect(requests).not.toHaveBeenCalled();
      expect(await readdir(path.dirname(file))).toEqual([]);
    } finally {
      requests.mockRestore();
    }
    await seed(file, "ordinary creation remains available");
  });

  it("does not initialize an existing empty file", async () => {
    const file = databasePath();
    await writeFile(file, "");
    const store = await open(file, true);
    assert.ok(store);
    await store.close();
    expect(await readFile(file)).toEqual(Buffer.alloc(0));
  });

  it("requires explicit backend support instead of invoking the ordinary factory", async () => {
    const file = databasePath();
    await writeFile(file, "");
    const modulePath = path.join(path.dirname(file), "ordinary-only.mjs");
    await writeFile(
      modulePath,
      'export function createSqliteWorkerBackend() { throw new Error("ordinary factory ran"); }\n',
    );
    await expect(
      openSqliteWorkerStore({
        moduleUrl: pathToFileURL(modulePath),
        databasePath: file,
        input: undefined,
        existingOnly: true,
      }),
    ).rejects.toThrow("must export openExistingSqliteWorkerBackend");
    expect(await readFile(file)).toEqual(Buffer.alloc(0));
  });

  it("shares ordinary write intent with an existing actor across aliases and drains accepted work", async () => {
    const file = databasePath();
    await seed(file, "seed");
    const existing = await open(file, true);
    assert.ok(existing);
    const alias = path.join(path.dirname(file), "alias.sqlite");
    await link(file, alias);
    const ordinary = await open(alias);
    assert.ok(ordinary);
    let settled = false;
    const pending = ordinary
      .execute({ type: "append", input: { value: "ordinary" } })
      .then((receipt) => {
        settled = true;
        return receipt;
      });
    await ordinary.close();
    expect(settled).toBe(true);
    const first = await pending;
    const second = await existing.execute({ type: "append", input: { value: "existing" } });
    expect(second).toEqual({ ...first, writes: 2 });
    expect(first.threadId).toBeGreaterThan(0);
    expect(await existing.execute({ type: "read", input: undefined })).toEqual([
      "seed",
      "ordinary",
      "existing",
    ]);
  });

  it.each(["deleted", "replaced"] as const)(
    "rejects a file %s after parent admission before dispatching its factory",
    async (kind) => {
      const file = databasePath();
      const replacement = path.join(path.dirname(file), "replacement.sqlite");
      const displaced = path.join(path.dirname(file), "displaced.sqlite");
      const markerPath = path.join(path.dirname(file), "factory-called");
      await seed(file, "original");
      await seed(replacement, "replacement");
      const replacementBytes = await readFile(replacement);
      const messages = vi.spyOn(Worker.prototype, "postMessage").mockImplementationOnce(function (
        this: Worker,
        request: SqliteWorkerRequest,
        transferList,
      ) {
        messages.mockRestore();
        expect(request).toMatchObject({ type: "open", databasePath: file });
        expect("existingIdentity" in request && request.existingIdentity).toMatch(/^file:/);
        if (kind === "deleted") {
          unlinkSync(file);
        } else {
          renameSync(file, displaced);
          copyFileSync(replacement, file);
        }
        return this.postMessage(request, transferList);
      });
      try {
        await expect(open(file, true, { type: "observe", markerPath })).rejects.toThrow();
      } finally {
        messages.mockRestore();
      }
      await expect(readFile(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
      if (kind === "deleted") {
        await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        expect(await readFile(file)).toEqual(replacementBytes);
      }
      const recovered = await open(replacement, true);
      assert.ok(recovered);
      expect(await recovered.execute({ type: "read", input: undefined })).toEqual(["replacement"]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "retains a vanished alias until its admitted client closes",
    async () => {
      const file = databasePath();
      await seed(file, "original");
      const original = await open(file, true);
      assert.ok(original);
      const alias = path.join(path.dirname(file), "alias.sqlite");
      await link(file, alias);
      const aliasClient = await open(alias, true);
      assert.ok(aliasClient);
      unlinkSync(alias);
      await expect(open(alias, true)).rejects.toThrow("pathname changed");
      await aliasClient.close();
      expect(await open(alias, true)).toBeUndefined();
      expect(await original.execute({ type: "read", input: undefined })).toEqual(["original"]);
    },
  );

  it("rechecks file identity after loading the existing backend module", async () => {
    const file = databasePath();
    const displaced = path.join(path.dirname(file), "displaced.sqlite");
    const marker = path.join(path.dirname(file), "factory-called");
    await seed(file, "original");
    const modulePath = path.join(path.dirname(file), "delayed-entry.mjs");
    await writeFile(
      modulePath,
      `
      import { renameSync, writeFileSync } from "node:fs";
      renameSync(${JSON.stringify(file)}, ${JSON.stringify(displaced)});
      writeFileSync(${JSON.stringify(file)}, "");
      export function openExistingSqliteWorkerBackend() {
        writeFileSync(${JSON.stringify(marker)}, "factory called");
        throw new Error("existing factory ran");
      }
    `,
    );
    await expect(
      openSqliteWorkerStore({
        moduleUrl: pathToFileURL(modulePath),
        databasePath: file,
        input: undefined,
        existingOnly: true,
      }),
    ).rejects.toThrow("identity changed");
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(file)).toEqual(Buffer.alloc(0));
    const original = await open(displaced, true);
    assert.ok(original);
    expect(await original.execute({ type: "read", input: undefined })).toEqual(["original"]);
  });

  it.each([false, true])(
    "preserves native no-create and no-migration after a factory race (replacement: %s)",
    async (replace) => {
      const file = databasePath();
      const backupPath = path.join(path.dirname(file), "backup.sqlite");
      const replacementPath = path.join(path.dirname(file), "replacement.sqlite");
      await seed(file, "original");
      await seed(replacementPath, "replacement");
      const replacementBytes = await readFile(replacementPath);
      await expect(
        open(file, true, {
          type: "replace",
          backupPath,
          ...(replace ? { replacementPath } : {}),
        }),
      ).rejects.toThrow();
      if (replace) {
        expect(await readFile(file)).toEqual(replacementBytes);
      } else {
        await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
      }
      const original = await open(backupPath, true);
      assert.ok(original);
      expect(await original.execute({ type: "read", input: undefined })).toEqual(["original"]);
    },
  );
});
