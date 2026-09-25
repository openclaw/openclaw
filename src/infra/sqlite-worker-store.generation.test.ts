import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import {
  captureRuntimeWorkerSource,
  withRuntimeWorkerGeneration,
} from "./runtime-worker-generation.js";
import {
  useSqliteWorkerStoreFixture,
  appendWorkerRow as append,
  readWorkerRows as read,
} from "./sqlite-worker-fixture.test-support.js";
import { openSqliteWorkerStore, type SqliteWorkerStore } from "./sqlite-worker-store.js";
import type { FixtureOperations } from "./sqlite-worker-store.test-support.js";
import { getTrackedWorkerCpuSources } from "./worker-cpu.js";

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  availableParallelism: () => 32,
}));

const { stores, tempDirs, databasePath, open } = useSqliteWorkerStoreFixture(
  "openclaw-sqlite-worker-generation-",
);

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
