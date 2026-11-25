import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { expect, it } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { createDeferredCore } from "../shared/deferred.js";
import { forceFullGc } from "../test-utils/retention.js";
import { initializeSqliteRuntimeCapabilities } from "./bun-sqlite-library.js";
import { SqliteWorkerBroker } from "./sqlite-worker-broker.js";
import type { SqliteWorkerCloseReceipt } from "./sqlite-worker-contract.js";
import { useSqliteWorkerStoreFixture } from "./sqlite-worker-fixture.test-support.js";
import { createSqliteWorkerOperationAdmission } from "./sqlite-worker-operation-admission.js";
import type { FixtureOperations } from "./sqlite-worker-store.test-support.js";

const { databasePath, open } = useSqliteWorkerStoreFixture("sqlite-open-retention-");
const { explicitSqliteCloseReleasesNativeResources } = await initializeSqliteRuntimeCapabilities();

// Like the native-stop sibling, receipt publication requires in-process native close support.
it.skipIf(!explicitSqliteCloseReleasesNativeResources)(
  "releases opening context while retained retirement readers observe the eventual native close",
  async ({ signal }) => {
    const file = databasePath();
    const root = path.dirname(file);
    // Creation uses the maintained fixture; this case owns only reopening callback lifetime.
    await (await open(file)).close();
    const broker = new SqliteWorkerBroker();
    const terminal = createDeferredCore<{
      stopped: Promise<void>;
      readCloseReceipt: () => SqliteWorkerCloseReceipt | undefined;
      readOpenRefused: () => boolean;
    }>();
    let openingChecks = 0;
    async function openCaptured() {
      const payload = { marker: "synthetic opening authority" };
      const reference = new WeakRef(payload);
      const store = await broker.open<FixtureOperations>(
        {
          moduleUrl: new URL("./sqlite-worker-store.test-support.ts", import.meta.url),
          databasePath: file,
          existingOnly: true,
          input: { type: "retirement" },
        },
        { environment: { OPENCLAW_STATE_DIR: root } },
        () => {
          openingChecks++;
          expect(payload.marker).toBe("synthetic opening authority");
        },
        {
          createAdmission: () => ({
            nativeLocations: [file],
            admission: createSqliteWorkerOperationAdmission((_request, grant) => {
              grant();
            }),
          }),
          onNativeStopped(stopped, readCloseReceipt, readOpenRefused) {
            terminal.resolve({ stopped, readCloseReceipt, readOpenRefused });
          },
        },
      );
      if (!store) {
        throw new Error("Expected the reopened native fixture store");
      }
      return { store, reference };
    }
    try {
      const { store, reference } = await openCaptured();
      const readers = await withinTest(terminal.promise, signal);
      expect(openingChecks).toBeGreaterThan(0);
      expect(readers.readCloseReceipt()).toBeUndefined();
      expect(readers.readOpenRefused()).toBe(false);
      const written = await store.execute({ type: "append", input: { value: "before close" } });
      const control = new WeakRef({});
      for (let pass = 0; pass < 4; pass++) {
        await nextTurn();
        forceFullGc();
      }
      expect(control.deref()).toBeUndefined();
      expect(reference.deref()).toBeUndefined();
      expect(await store.execute({ type: "read", input: undefined })).toEqual(["before close"]);
      expect(readers.readCloseReceipt()).toBeUndefined();
      await store.close();
      await withinTest(readers.stopped, signal);
      // Fixture terminal data proves live transport; agent suites verify authoritative identities.
      expect(readers.readCloseReceipt()).toEqual({
        identity: { key: "fixture", canonicalPath: file },
        incarnation: written.actor,
      });
      expect(readers.readOpenRefused()).toBe(false);
    } finally {
      await broker.close();
    }
  },
);
