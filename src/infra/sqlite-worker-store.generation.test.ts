import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  captureRuntimeWorkerSource,
  withRuntimeWorkerGeneration,
} from "./runtime-worker-generation.js";
import { openSqliteWorkerStore, type SqliteWorkerStore } from "./sqlite-worker-store.js";
import type { FixtureOperations } from "./sqlite-worker-store.test-support.js";
import { getTrackedWorkerCpuSources } from "./worker-cpu.js";

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  availableParallelism: () => 32,
}));

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
  return path.join(tempDirs.make("openclaw-sqlite-worker-generation-"), "store.sqlite");
}

async function open(file: string) {
  const store = await openSqliteWorkerStore<FixtureOperations>({
    moduleUrl: new URL("./sqlite-worker-store.test-support.ts", import.meta.url),
    databasePath: file,
    input: undefined,
  });
  stores.add(store);
  return store;
}

function append(store: SqliteWorkerStore<FixtureOperations>, value: string) {
  return store.execute({ type: "append", input: { value } });
}

function read(store: SqliteWorkerStore<FixtureOperations>) {
  return store.execute({ type: "read", input: undefined });
}

const nodeIt = process.versions.bun ? it.skip : it;

nodeIt("borrows only one carrier at capacity and never crosses retained generations", async () => {
  const ordinary = await Promise.all(Array.from({ length: 4 }, () => open(databasePath())));
  const ordinaryThreads = new Set(
    await Promise.all(ordinary.map(async (store) => (await append(store, "ordinary")).threadId)),
  );
  expect(ordinaryThreads.size).toBe(4);
  const moduleUrl = new URL("./sqlite-worker-store.test-support.ts", import.meta.url);
  const directory = tempDirs.make("openclaw-retained-sqlite-generation-");
  const generation = async (name: string, run: () => Promise<void>) => {
    const retained = pathToFileURL(path.join(directory, `${name}.mts`));
    await writeFile(retained, `export * from ${JSON.stringify(moduleUrl.href)};\n`);
    return await withRuntimeWorkerGeneration(
      async (bind) => {
        bind((url) => (url.href === moduleUrl.href ? retained : url));
        await run();
      },
      async () => {},
    );
  };
  const openRetained = async () => {
    const source = captureRuntimeWorkerSource(moduleUrl);
    const store = await openSqliteWorkerStore<FixtureOperations>({
      ...source,
      databasePath: databasePath(),
      input: undefined,
    });
    stores.add(store);
    return store;
  };
  let retained: SqliteWorkerStore<FixtureOperations> | undefined;
  const before = getTrackedWorkerCpuSources().workers.length;
  await generation("first", async () => {
    retained = await openRetained();
    const first = await append(retained, "first");
    expect(ordinaryThreads.has(first.threadId)).toBe(false);
    expect(getTrackedWorkerCpuSources().workers).toHaveLength(before + 1);
    const sibling = await openRetained();
    expect((await append(sibling, "same generation")).threadId).toBe(first.threadId);
    await generation("second", async () => {
      await expect(openRetained()).rejects.toMatchObject({ code: "overloaded" });
      expect(getTrackedWorkerCpuSources().workers).toHaveLength(before + 1);
    });
    await Promise.all([append(retained, "second"), append(retained, "third")]);
    expect(await read(retained)).toEqual(["first", "second", "third"]);
  });
  expect(getTrackedWorkerCpuSources().workers).toHaveLength(before);
  await expect(read(retained!)).rejects.toMatchObject({ code: "closed" });
  for (const store of ordinary) {
    await expect(append(store, "preserved")).resolves.toMatchObject({ writes: 2 });
  }
});

nodeIt("keeps identical backend actors within their ordinary or retained generation", async () => {
  const moduleUrl = new URL("./sqlite-worker-store.test-support.ts", import.meta.url);
  const directory = tempDirs.make("openclaw-shared-retained-generation-");
  const retained = pathToFileURL(path.join(directory, "backend.mts"));
  await writeFile(retained, `export * from ${JSON.stringify(moduleUrl.href)};\n`);
  const file = databasePath();
  const generation = (run: () => Promise<void>) =>
    withRuntimeWorkerGeneration(
      async (bind) => {
        bind((url) => (url.href === moduleUrl.href ? retained : url));
        await run();
      },
      async () => {},
    );
  const openShared = async (retainedScope: boolean) => {
    const source = retainedScope ? captureRuntimeWorkerSource(moduleUrl) : { moduleUrl: retained };
    const store = await openSqliteWorkerStore<FixtureOperations>({
      ...source,
      databasePath: file,
      input: undefined,
    });
    stores.add(store);
    return store;
  };
  const ordinary = await openShared(false);
  await append(ordinary, "ordinary");
  await generation(async () => {
    await expect(openShared(true)).rejects.toThrow("runtime generation changed");
  });
  expect(await read(ordinary)).toEqual(["ordinary"]);
  await ordinary.close();

  let owner: SqliteWorkerStore<FixtureOperations> | undefined;
  await generation(async () => {
    owner = await openShared(true);
    const first = await append(owner, "first");
    const peer = await openShared(true);
    expect(await append(peer, "peer")).toMatchObject({
      actor: first.actor,
      threadId: first.threadId,
    });
    await generation(async () => {
      await expect(openShared(true)).rejects.toThrow("runtime generation changed");
    });
    await expect(openShared(false)).rejects.toThrow("runtime generation changed");
    await append(owner, "still-owned");
    expect(await read(peer)).toEqual(["ordinary", "first", "peer", "still-owned"]);
  });
  await expect(read(owner!)).rejects.toMatchObject({ code: "closed" });
  await generation(async () => {
    expect(await read(await openShared(true))).toEqual([
      "ordinary",
      "first",
      "peer",
      "still-owned",
    ]);
  });
});
