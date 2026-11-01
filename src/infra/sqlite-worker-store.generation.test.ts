import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assert, expect, it } from "vitest";
import { initializeSqliteRuntimeCapabilities } from "./bun-sqlite-library.js";
import {
  captureRuntimeWorkerSource,
  withRuntimeWorkerGeneration,
} from "./runtime-worker-generation.js";
import {
  useSqliteWorkerStoreFixture,
  appendWorkerRow as append,
  readWorkerRows as read,
} from "./sqlite-worker-fixture.test-support.js";
import {
  openSharedStateSqliteWorkerStore,
  openSqliteWorkerStore,
  type SqliteWorkerStore,
} from "./sqlite-worker-store.js";
import type { FixtureOperations } from "./sqlite-worker-store.test-support.js";
import { getTrackedWorkerCpuSources } from "./worker-cpu.js";
import { resolveSqliteBrokerWorkerCount } from "./worker-pool-sizing.js";

const { stores, tempDirs, databasePath, open } = useSqliteWorkerStoreFixture(
  "openclaw-sqlite-worker-generation-",
);

const { explicitSqliteCloseReleasesNativeResources } = await initializeSqliteRuntimeCapabilities();
const poolIt = explicitSqliteCloseReleasesNativeResources ? it : it.skip;

poolIt(
  "borrows one carrier per pool at capacity and never crosses retained generations",
  async () => {
    const capacity = resolveSqliteBrokerWorkerCount();
    const ordinary = await Promise.all(
      Array.from({ length: capacity }, () => open(databasePath())),
    );
    const ordinaryThreads = new Set(
      await Promise.all(ordinary.map(async (store) => (await append(store, "ordinary")).threadId)),
    );
    expect(ordinaryThreads.size).toBe(capacity);
    const moduleUrl = new URL("./sqlite-worker-store.test-support.ts", import.meta.url);
    const directory = tempDirs.make("openclaw-retained-sqlite-generation-");
    const openGeneration = async (shared = false) => {
      const source = { ...captureRuntimeWorkerSource(moduleUrl), databasePath: databasePath() };
      const store = shared
        ? await openSharedStateSqliteWorkerStore<FixtureOperations>(source, {
            environment: { OPENCLAW_STATE_DIR: directory },
          })
        : await openSqliteWorkerStore<FixtureOperations>({ ...source, input: undefined });
      assert(store);
      stores.add(store);
      return store;
    };
    const ordinaryShared = await openGeneration(true);
    const sharedThread = (await append(ordinaryShared, "ordinary shared")).threadId;
    expect(ordinaryThreads.has(sharedThread)).toBe(false);
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
    let retained: SqliteWorkerStore<FixtureOperations> | undefined;
    const before = getTrackedWorkerCpuSources().workers.length;
    await generation("first", async () => {
      retained = await openGeneration();
      const first = await append(retained, "first");
      expect(ordinaryThreads.has(first.threadId)).toBe(false);
      expect(getTrackedWorkerCpuSources().workers).toHaveLength(before + 1);
      const sibling = await openGeneration();
      expect((await append(sibling, "same generation")).threadId).toBe(first.threadId);
      const retainedShared = await openGeneration(true);
      const shared = await append(retainedShared, "retained shared");
      expect([...ordinaryThreads, sharedThread, first.threadId]).not.toContain(shared.threadId);
      expect(getTrackedWorkerCpuSources().workers).toHaveLength(before + 2);
      await generation("second", async () => {
        await expect(openGeneration()).rejects.toMatchObject({ code: "overloaded" });
        await expect(openGeneration(true)).rejects.toMatchObject({ code: "overloaded" });
        expect(getTrackedWorkerCpuSources().workers).toHaveLength(before + 2);
      });
      await Promise.all([append(retained, "second"), append(retained, "third")]);
      expect(await read(retained)).toEqual(["first", "second", "third"]);
    });
    expect(getTrackedWorkerCpuSources().workers).toHaveLength(before);
    await expect(read(retained!)).rejects.toMatchObject({ code: "closed" });
    for (const store of ordinary) {
      await expect(append(store, "preserved")).resolves.toMatchObject({ writes: 2 });
    }
    await expect(append(ordinaryShared, "preserved shared")).resolves.toMatchObject({ writes: 2 });
  },
);
