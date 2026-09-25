import { describe, expect, it } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { writePersistedInstalledPluginIndexInstallRecordsWithLease } from "./installed-plugin-index-records.js";
import { readPersistedInstalledPluginIndex } from "./installed-plugin-index-store.js";
import { withPluginLifecycleLease } from "./plugin-lifecycle-lease.js";

describe("shared plugin lifecycle authority refusal", () => {
  it.each([new Error("one-shot caller refusal"), false, undefined])(
    "keeps the first nested caller refusal across outer effects (%s)",
    async (failure) => {
      await withOpenClawTestState({ label: "shared-plugin-refusal" }, async (state) => {
        let checks = 0;
        await withPluginLifecycleLease({ env: state.env }, async (outer) => {
          await expect(
            withPluginLifecycleLease(
              {
                assertCurrent: () => {
                  checks++;
                  if (checks === 2) {
                    // oxlint-disable-next-line typescript/only-throw-error -- Preserve actual JavaScript refusal values, including undefined.
                    throw failure;
                  }
                },
              },
              async () => {},
            ),
          ).rejects.toBe(failure);
          expect(() => outer.assertOwned()).toThrow();
          await expect(
            writePersistedInstalledPluginIndexInstallRecordsWithLease(
              { demo: { source: "npm", spec: "demo@2.0.0" } },
              { env: state.env, candidates: [], lease: outer },
            ),
          ).rejects.toBe(failure);
          expect(checks).toBe(2);
          expect(await readPersistedInstalledPluginIndex({ env: state.env })).toBeNull();
        });
        await withPluginLifecycleLease({ env: state.env }, async (fresh) => {
          fresh.assertOwned();
          await writePersistedInstalledPluginIndexInstallRecordsWithLease(
            { demo: { source: "npm", spec: "demo@3.0.0" } },
            { env: state.env, candidates: [], lease: fresh },
          );
        });
        expect(
          (await readPersistedInstalledPluginIndex({ env: state.env }))?.installRecords.demo?.spec,
        ).toBe("demo@3.0.0");
      });
    },
  );

  it("does not turn an ordinary nested operation error into authority refusal", async () => {
    await withOpenClawTestState({ label: "plugin-operation-error" }, async (state) => {
      const failure = new Error("download failed");
      await withPluginLifecycleLease({ env: state.env }, async (outer) => {
        await expect(
          withPluginLifecycleLease({}, async () => {
            throw failure;
          }),
        ).rejects.toBe(failure);
        outer.assertOwned();
        await withPluginLifecycleLease({}, async (inner) => {
          expect(inner).toBe(outer);
          inner.assertOwned();
        });
      });
    });
  });
});
