import assert from "node:assert/strict";
import { copyFileSync, renameSync, unlinkSync } from "node:fs";
import { link, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import type { SqliteWorkerRequest } from "./sqlite-worker-contract.js";
import {
  useSqliteWorkerStoreFixture,
  appendWorkerRow as append,
  readWorkerRows as read,
} from "./sqlite-worker-fixture.test-support.js";
import { openSqliteWorkerStore } from "./sqlite-worker-store.js";
import type { FixtureOpenInput, FixtureOperations } from "./sqlite-worker-store.test-support.js";

const { stores, databasePath } = useSqliteWorkerStoreFixture("openclaw-sqlite-worker-existing-");
async function open(
  file: string,
  existingOnly = false,
  input?: FixtureOpenInput,
  moduleUrl = new URL("./sqlite-worker-store.test-support.ts", import.meta.url),
) {
  const store = await openSqliteWorkerStore<FixtureOperations>({
    moduleUrl,
    databasePath: file,
    input,
    existingOnly,
  });
  if (store) {
    stores.add(store);
  }
  return store;
}
async function required(file: string, existingOnly = true) {
  const store = await open(file, existingOnly);
  assert.ok(store);
  return store;
}
async function seed(file: string, value: string) {
  const store = await required(file, false);
  await append(store, value);
  await store.close();
}
const sibling = (file: string, name: string) => path.join(path.dirname(file), name);
const missing = (file: string) => expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });

it("returns missing without dispatch, filesystem creation, or retained capacity", async () => {
  const file = databasePath();
  const requests = vi.spyOn(Worker.prototype, "postMessage");
  try {
    for (let index = 0; index < 80; index++) {
      expect(await open(file, true)).toBeUndefined();
    }
    expect(requests).not.toHaveBeenCalled();
    expect(await readdir(path.dirname(file))).toEqual([]);
  } finally {
    requests.mockRestore();
  }
  await seed(file, "ordinary creation remains available");
});

it.each(["unsupported", "identity changed"] as const)(
  "refuses %s before invoking the existing factory",
  async (kind) => {
    const file = databasePath();
    const displaced = sibling(file, "displaced.sqlite");
    const marker = sibling(file, "factory-called");
    const modulePath = sibling(file, "entry.mjs");
    if (kind === "unsupported") {
      await writeFile(file, "");
    } else {
      await seed(file, "original");
    }
    await writeFile(
      modulePath,
      kind === "unsupported"
        ? 'export function createSqliteWorkerBackend() { throw new Error("ordinary factory ran"); }\n'
        : `
      import { renameSync, writeFileSync } from "node:fs";
      renameSync(${JSON.stringify(file)}, ${JSON.stringify(displaced)});
      writeFileSync(${JSON.stringify(file)}, "");
      export function openExistingSqliteWorkerBackend() {
        writeFileSync(${JSON.stringify(marker)}, "factory called");
        throw new Error("existing factory ran");
      }
    `,
    );
    await expect(open(file, true, undefined, pathToFileURL(modulePath))).rejects.toThrow(
      kind === "unsupported" ? "must export openExistingSqliteWorkerBackend" : "identity changed",
    );
    await missing(marker);
    expect(await readFile(file)).toEqual(Buffer.alloc(0));
    if (kind === "identity changed") {
      expect(await read(await required(displaced))).toEqual(["original"]);
    }
  },
);

it.each([
  { stage: "parent", replace: false },
  { stage: "parent", replace: true },
  { stage: "factory", replace: false },
  { stage: "factory", replace: true },
] as const)(
  "rejects replacement=$replace at $stage admission without creating or migrating files",
  async ({ stage, replace }) => {
    const file = databasePath();
    const replacement = sibling(file, "replacement.sqlite");
    const backupPath = sibling(file, "displaced.sqlite");
    const markerPath = sibling(file, "factory-called");
    await seed(file, "original");
    await seed(replacement, "replacement");
    const replacementBytes = await readFile(replacement);
    const messages =
      stage === "parent"
        ? vi.spyOn(Worker.prototype, "postMessage").mockImplementationOnce(function (
            this: Worker,
            request: SqliteWorkerRequest,
            transferList,
          ) {
            messages?.mockRestore();
            expect(request).toMatchObject({ type: "open", databasePath: file });
            expect("existingIdentity" in request && request.existingIdentity).toMatch(/^file:/);
            if (replace) {
              renameSync(file, backupPath);
              copyFileSync(replacement, file);
            } else {
              unlinkSync(file);
            }
            return this.postMessage(request, transferList);
          })
        : undefined;
    try {
      await expect(
        open(
          file,
          true,
          stage === "parent"
            ? { type: "observe", markerPath }
            : { type: "replace", backupPath, ...(replace ? { replacementPath: replacement } : {}) },
        ),
      ).rejects.toThrow();
    } finally {
      messages?.mockRestore();
    }
    if (stage === "parent") {
      await missing(markerPath);
    }
    if (replace) {
      expect(await readFile(file)).toEqual(replacementBytes);
    } else {
      await missing(file);
    }
    expect(await read(await required(stage === "parent" ? replacement : backupPath))).toEqual([
      stage === "parent" ? "replacement" : "original",
    ]);
  },
);

it.skipIf(process.platform === "win32")(
  "retains a vanished alias until its admitted client closes",
  async () => {
    const file = databasePath();
    await seed(file, "original");
    const original = await required(file);
    const alias = sibling(file, "alias.sqlite");
    await link(file, alias);
    const aliasClient = await required(alias);
    unlinkSync(alias);
    await expect(open(alias, true)).rejects.toThrow("pathname changed");
    await aliasClient.close();
    expect(await open(alias, true)).toBeUndefined();
    expect(await read(original)).toEqual(["original"]);
  },
);
