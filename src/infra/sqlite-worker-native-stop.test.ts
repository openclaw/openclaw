import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { SqliteWorkerBroker } from "./sqlite-worker-broker.js";
import type { SqliteWorkerStore } from "./sqlite-worker-contract.js";
import type { FixtureOperations } from "./sqlite-worker-store.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

it.skipIf(Boolean(process.versions.bun))(
  "acknowledges an actor's native close while its pooled sibling remains usable",
  async () => {
    const root = dirs.make("sqlite-native-stop-");
    const broker = new SqliteWorkerBroker();
    const opened: SqliteWorkerStore<FixtureOperations>[] = [];
    let nativeStopped = false;
    try {
      for (let index = 0; index < 5; index++) {
        const store = await broker.open<FixtureOperations>(
          {
            moduleUrl: new URL("./sqlite-worker-store.test-support.ts", import.meta.url),
            databasePath: path.join(root, `${index}.sqlite`),
            input: undefined,
          },
          undefined,
          undefined,
          index === 0
            ? {
                onNativeStopped(stopped) {
                  void stopped.then(() => {
                    nativeStopped = true;
                  });
                },
              }
            : undefined,
        );
        if (!store) {
          throw new Error("Expected the creating fixture store");
        }
        opened.push(store);
      }
      const first = opened[0];
      const sibling = opened[4];
      if (!first || !sibling) {
        throw new Error("Expected both pooled fixture stores");
      }
      const firstReceipt = await first.execute({ type: "append", input: { value: "first" } });
      const siblingReceipt = await sibling.execute({
        type: "append",
        input: { value: "sibling" },
      });
      expect(siblingReceipt.threadId).toBe(firstReceipt.threadId);
      expect(nativeStopped).toBe(false);
      await first.close();
      expect(nativeStopped).toBe(true);
      expect(await sibling.execute({ type: "append", input: { value: "after close" } })).toEqual({
        ...siblingReceipt,
        writes: 2,
      });
    } finally {
      await broker.close();
    }
  },
);
