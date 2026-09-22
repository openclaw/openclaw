import assert from "node:assert/strict";
import { copyFileSync, existsSync, renameSync, unlinkSync } from "node:fs";
import { link, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { SqliteWorkerRequest } from "./sqlite-worker-contract.js";
import {
  openIsolatedSqliteWorkerStore,
  openSqliteWorkerStore,
  type SqliteWorkerStore,
} from "./sqlite-worker-store.js";
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

  it("keeps shared admission free while an isolated foreign existing-only open is wedged (#148750)", async () => {
    const foreign = path.resolve(databasePath());
    await writeFile(foreign, "");
    const factoryMarker = `${foreign}.factory-entered`;
    const hangModule = new URL("./sqlite-worker-store.hang-open.test-support.ts", import.meta.url);
    let foreignWorker: Worker | undefined;
    const postMessage = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
      this: Worker,
      request: unknown,
      transferList?: readonly import("node:worker_threads").TransferListItem[],
    ) {
      const body = request as { type?: string; databasePath?: string };
      if (body?.type === "open" && body.databasePath === foreign) {
        foreignWorker = this;
        postMessage.mockRestore();
      }
      return this.postMessage(request, transferList);
    });
    let hungSettled = false;
    try {
      // Do not await: models a wedged chat.db open that never settles.
      const hung = openIsolatedSqliteWorkerStore({
        moduleUrl: hangModule,
        databasePath: foreign,
        existingOnly: true,
        input: undefined,
      });
      void hung.then(
        () => {
          hungSettled = true;
        },
        () => {
          hungSettled = true;
        },
      );

      // Wait for the foreign factory to enter its blocking open before healthy admission.
      const entered = await Promise.race([
        (async () => {
          const deadline = Date.now() + 5_000;
          while (Date.now() < deadline) {
            if (existsSync(factoryMarker)) {
              return true;
            }
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          return false;
        })(),
        hung.then(() => false),
      ]);
      assert.ok(entered, "foreign hang factory never entered before healthy open");
      expect(hungSettled).toBe(false);
      assert.ok(foreignWorker, "expected the foreign open worker to be observed");

      const healthyPath = path.join(path.dirname(foreign), "shared-healthy.sqlite");
      const opened = open(healthyPath, false);
      const result = await Promise.race([
        opened.then((store) => {
          assert.ok(store);
          return store;
        }),
        new Promise<null>((resolve) => {
          setTimeout(() => resolve(null), 2_000);
        }),
      ]);
      assert.ok(result, "shared SQLite admission stalled behind wedged foreign open");
      expect(hungSettled).toBe(false);
      expect(await result.execute({ type: "append", input: { value: "alive" } })).toMatchObject({
        writes: 1,
      });
      expect(hungSettled).toBe(false);
    } finally {
      postMessage.mockRestore();
      if (foreignWorker) {
        await Promise.allSettled([foreignWorker.terminate()]);
      }
    }
  });

  it.skipIf(Boolean(process.versions.bun))(
    "keeps shared I/O moving on a saturated pool while a foreign factory is blocked",
    async () => {
      const root = path.dirname(databasePath());
      const sharedStores: SqliteWorkerStore<FixtureOperations>[] = [];
      for (let index = 0; index < 3; index += 1) {
        const store = await open(path.join(root, `shared-pool-${index}.sqlite`));
        assert.ok(store);
        sharedStores.push(store);
      }

      const foreign = path.resolve(path.join(root, "foreign-saturated.sqlite"));
      await writeFile(foreign, "");
      const factoryMarker = `${foreign}.factory-entered`;
      const hangModule = new URL(
        "./sqlite-worker-store.hang-open.test-support.ts",
        import.meta.url,
      );
      let foreignWorker: Worker | undefined;
      const postMessage = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
        this: Worker,
        request: unknown,
        transferList?: readonly import("node:worker_threads").TransferListItem[],
      ) {
        const body = request as { type?: string; databasePath?: string };
        if (body?.type === "open" && body.databasePath === foreign) {
          foreignWorker = this;
          postMessage.mockRestore();
        }
        return this.postMessage(request, transferList);
      });
      let hungSettled = false;
      try {
        const hung = openIsolatedSqliteWorkerStore({
          moduleUrl: hangModule,
          databasePath: foreign,
          existingOnly: true,
          input: undefined,
        });
        void hung.then(
          () => {
            hungSettled = true;
          },
          () => {
            hungSettled = true;
          },
        );

        const entered = await Promise.race([
          (async () => {
            const deadline = Date.now() + 5_000;
            while (Date.now() < deadline) {
              if (existsSync(factoryMarker)) {
                return true;
              }
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
            return false;
          })(),
          hung.then(() => false),
        ]);
        assert.ok(entered, "foreign hang factory never entered before saturated shared open");
        expect(hungSettled).toBe(false);
        assert.ok(foreignWorker, "expected the foreign open worker to be observed");

        // Pool is full (3 shared + 1 foreign). A further shared open must co-locate on a
        // shared-lane worker — never the foreign-wedged one — so admission still completes.
        const extraPath = path.join(root, "shared-pool-extra.sqlite");
        const extra = await Promise.race([
          open(extraPath).then((store) => {
            assert.ok(store);
            return store;
          }),
          new Promise<null>((resolve) => {
            setTimeout(() => resolve(null), 3_000);
          }),
        ]);
        assert.ok(extra, "shared open stalled behind foreign-wedged worker at full pool");
        expect(hungSettled).toBe(false);

        for (const store of sharedStores) {
          expect(await store.execute({ type: "append", input: { value: "alive" } })).toMatchObject({
            writes: 1,
          });
        }
        expect(await extra.execute({ type: "append", input: { value: "extra" } })).toMatchObject({
          writes: 1,
        });
        expect(hungSettled).toBe(false);
      } finally {
        postMessage.mockRestore();
        if (foreignWorker) {
          await Promise.allSettled([foreignWorker.terminate()]);
        }
      }
    },
  );

  it("shares one native actor across shared and isolated lanes for the same file", async () => {
    const file = databasePath();
    await seed(file, "seed");
    const shared = await open(file, true);
    assert.ok(shared);
    const isolated = await openIsolatedSqliteWorkerStore<FixtureOperations>({
      moduleUrl: new URL("./sqlite-worker-store.test-support.ts", import.meta.url),
      databasePath: file,
      existingOnly: true,
      input: undefined,
    });
    assert.ok(isolated);
    stores.add(isolated);
    const first = await shared.execute({ type: "append", input: { value: "shared" } });
    const second = await isolated.execute({ type: "append", input: { value: "isolated" } });
    expect(second).toEqual({ ...first, writes: 2 });
    expect(await shared.execute({ type: "read", input: undefined })).toEqual([
      "seed",
      "shared",
      "isolated",
    ]);
  });

  describe.skipIf(process.platform === "win32")("cross-lane physical ownership", () => {
    it("shares one native actor across a hardlink opened on the isolated lane", async () => {
      const file = databasePath();
      await seed(file, "seed");
      const alias = path.join(path.dirname(file), "alias.sqlite");
      await link(file, alias);
      const shared = await open(file, true);
      assert.ok(shared);
      const isolated = await openIsolatedSqliteWorkerStore<FixtureOperations>({
        moduleUrl: new URL("./sqlite-worker-store.test-support.ts", import.meta.url),
        databasePath: alias,
        existingOnly: true,
        input: undefined,
      });
      assert.ok(isolated);
      stores.add(isolated);
      const first = await shared.execute({ type: "append", input: { value: "shared" } });
      const second = await isolated.execute({ type: "append", input: { value: "alias" } });
      expect(second).toEqual({ ...first, writes: 2 });
    });

    it("rejects a backend mismatch when the isolated lane targets an owned path", async () => {
      const file = databasePath();
      await seed(file, "seed");
      const shared = await open(file, true);
      assert.ok(shared);
      const otherModule = path.join(path.dirname(file), "other-backend.mjs");
      await writeFile(
        otherModule,
        [
          "export function openExistingSqliteWorkerBackend() {",
          "  return {",
          "    execute() { return null; },",
          "    close() {},",
          "  };",
          "}",
          "",
        ].join("\\n"),
      );
      await expect(
        openIsolatedSqliteWorkerStore({
          moduleUrl: pathToFileURL(otherModule),
          databasePath: file,
          existingOnly: true,
          input: undefined,
        }),
      ).rejects.toThrow("already belongs to another worker backend");
      expect(await shared.execute({ type: "read", input: undefined })).toEqual(["seed"]);
    });

    it("reserves ownership across concurrent same-file opens during worker retirement", async () => {
      const file = databasePath();
      await seed(file, "seed");
      const root = path.dirname(file);
      const fillers: SqliteWorkerStore<FixtureOperations>[] = [];
      for (let index = 0; index < 4; index += 1) {
        const store = await open(path.join(root, `retire-fill-${index}.sqlite`));
        assert.ok(store);
        fillers.push(store);
      }
      const closing = Promise.all(fillers.map((store) => store.close()));
      const sharedOpen = open(file, true);
      const isolatedOpen = openIsolatedSqliteWorkerStore<FixtureOperations>({
        moduleUrl: new URL("./sqlite-worker-store.test-support.ts", import.meta.url),
        databasePath: file,
        existingOnly: true,
        input: undefined,
      });
      await closing;
      const [shared, isolated] = await Promise.all([sharedOpen, isolatedOpen]);
      assert.ok(shared);
      assert.ok(isolated);
      stores.add(isolated);
      const first = await shared.execute({ type: "append", input: { value: "shared" } });
      const second = await isolated.execute({ type: "append", input: { value: "isolated" } });
      expect(second).toEqual({ ...first, writes: 2 });
      expect(await shared.execute({ type: "read", input: undefined })).toEqual([
        "seed",
        "shared",
        "isolated",
      ]);
    });

    it("rejects a mismatched backend when concurrent cross-lane opens race during retirement", async () => {
      const file = databasePath();
      await seed(file, "seed");
      const root = path.dirname(file);
      const fillers: SqliteWorkerStore<FixtureOperations>[] = [];
      for (let index = 0; index < 4; index += 1) {
        const store = await open(path.join(root, `retire-mismatch-${index}.sqlite`));
        assert.ok(store);
        fillers.push(store);
      }
      const otherModule = path.join(root, "retire-other-backend.mjs");
      await writeFile(
        otherModule,
        [
          "export function openExistingSqliteWorkerBackend() {",
          "  return {",
          "    execute() { return null; },",
          "    close() {},",
          "  };",
          "}",
          "",
        ].join("\n"),
      );
      const closing = Promise.all(fillers.map((store) => store.close()));
      const sharedOpen = open(file, true);
      const isolatedOpen = openIsolatedSqliteWorkerStore({
        moduleUrl: pathToFileURL(otherModule),
        databasePath: file,
        existingOnly: true,
        input: undefined,
      });
      // Settle immediately so a fast backend-mismatch rejection is not unhandled
      // while filler workers are still retiring.
      const resultsPromise = Promise.allSettled([sharedOpen, isolatedOpen]);
      await closing;
      const results = await resultsPromise;
      const fulfilled = results.filter((result) => result.status === "fulfilled");
      const rejected = results.filter((result) => result.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      const rejection = rejected[0];
      assert.ok(rejection && rejection.status === "rejected");
      expect(String(rejection.reason)).toMatch(/already belongs to another worker backend/);
      const winner = fulfilled[0];
      assert.ok(winner && winner.status === "fulfilled");
      assert.ok(winner.value);
      stores.add(winner.value as SqliteWorkerStore<FixtureOperations>);
    });

    it("rejects a replaced pathname while the shared-lane owner is still active", async () => {
      const file = databasePath();
      await seed(file, "seed");
      const alias = path.join(path.dirname(file), "alias.sqlite");
      await link(file, alias);
      const shared = await open(file, true);
      assert.ok(shared);
      const isolatedAlias = await openIsolatedSqliteWorkerStore<FixtureOperations>({
        moduleUrl: new URL("./sqlite-worker-store.test-support.ts", import.meta.url),
        databasePath: alias,
        existingOnly: true,
        input: undefined,
      });
      assert.ok(isolatedAlias);
      stores.add(isolatedAlias);
      unlinkSync(alias);
      await writeFile(alias, "");
      await expect(
        openIsolatedSqliteWorkerStore({
          moduleUrl: new URL("./sqlite-worker-store.test-support.ts", import.meta.url),
          databasePath: alias,
          existingOnly: true,
          input: undefined,
        }),
      ).rejects.toThrow("pathname changed while its worker owner is active");
      await isolatedAlias.close();
      await shared.close();
    });
  });
});
