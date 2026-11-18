import { StatementSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createPluginBlobKernelStore } from "./plugin-blob-store.test-helpers.js";

afterEach(() => vi.restoreAllMocks());

it.each(["reject-new", "evict-oldest"] as const)(
  "registers a new blob with two data statements under %s",
  async (overflowPolicy) => {
    await withOpenClawTestState({ label: "blob-registration-budget" }, async (state) => {
      const store = createPluginBlobKernelStore("synthetic-blob", {
        namespace: "registration",
        maxEntries: 2,
        maxBytesPerEntry: 16,
        maxBytesPerNamespace: 32,
        overflowPolicy,
        env: state.env,
      });
      openOpenClawStateDatabase({ env: state.env });
      let statements = 0;
      for (const method of ["all", "get", "run"] as const) {
        const original = StatementSync.prototype[method];
        vi.spyOn(StatementSync.prototype, method).mockImplementation(
          new Proxy(original, {
            apply(target, receiver: StatementSync, args) {
              if (/plugin_blob_entries/iu.test(receiver.sourceSQL)) {
                statements++;
              }
              return Reflect.apply(target, receiver, args);
            },
          }),
        );
      }
      const receipt = await store.registerIfAbsentWithReceipt("new", new Uint8Array([1, 2]), {
        version: 1,
      });
      vi.restoreAllMocks();
      expect(receipt).toEqual({ createdAt: expect.any(Number) });
      await expect(store.lookup("new")).resolves.toMatchObject({
        bytes: new Uint8Array([1, 2]),
        metadata: { version: 1 },
      });
      expect(statements).toBeLessThanOrEqual(2);
    });
  },
);
