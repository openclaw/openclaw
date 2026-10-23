import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { enablePluginWithCapabilityConsent } from "./enable.js";
import * as records from "./installed-plugin-index-records.js";
import { withPluginLifecycleLease } from "./plugin-lifecycle-lease.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
});

describe("automatic capability acceptance authority", () => {
  it.each([false, true])(
    "rechecks the caller after pending storage reads (revoked: %s)",
    async (revoked) => {
      await withOpenClawTestState(
        {
          label: "auto-capability-authority",
          env: {
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
            OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS: "1",
          },
        },
        async (state) => {
          const installPath = state.statePath("extensions", "codex");
          await state.writeJson("extensions/codex/package.json", {
            name: "@openclaw/codex",
            version: "1.0.0",
            openclaw: { extensions: ["./index.js"] },
          });
          await state.writeText("extensions/codex/index.js", "export {};");
          await state.writeJson("extensions/codex/openclaw.plugin.json", {
            id: "codex",
            configSchema: { type: "object" },
            contracts: { tools: ["fixture.tool"] },
          });
          const config = { plugins: { entries: { codex: { enabled: false } } } };
          await state.writeConfig(config);
          await withPluginLifecycleLease({}, async (lease) => {
            await records.writePersistedInstalledPluginIndexInstallRecordsWithLease(
              {
                codex: {
                  source: "npm",
                  spec: "@openclaw/codex@1.0.0",
                  resolvedName: "@openclaw/codex",
                  integrity: "sha512-fixture",
                  installPath,
                },
              },
              { config, lease },
            );
          });
          const entered = createDeferred();
          const release = createDeferred();
          let checked = false;
          let held = false;
          let current = true;
          const readRecords = records.loadInstalledPluginIndexInstallRecords;
          // Pause a real storage read after the early check; leave persistence and its guard real.
          vi.spyOn(records, "loadInstalledPluginIndexInstallRecords").mockImplementation(
            async (options) => {
              const loaded = await readRecords(options);
              if (checked && !held) {
                held = true;
                entered.resolve();
                await release.promise;
              }
              return loaded;
            },
          );
          const enabling = enablePluginWithCapabilityConsent(config, "codex", {
            recordOfficialCapabilities: true,
            onCapabilityConsent: async (review) => ({ reviewToken: review.reviewToken }),
            beforePersistentEffect: () => {
              checked = true;
            },
            beforePersistentApply: () => {
              if (!current) {
                throw new Error("Requester authority revoked");
              }
            },
          });
          try {
            await awaitGateBeforeSettlement(
              entered.promise,
              enabling,
              "capability storage did not reach the pending read",
            );
            current = !revoked;
            release.resolve();
            if (revoked) {
              await expect(enabling).rejects.toThrow("Requester authority revoked");
            } else {
              expect(await enabling).toMatchObject({ enabled: true });
            }
            const persisted = (await readRecords()).codex;
            if (revoked) {
              expect(persisted).not.toHaveProperty("acceptedSurface");
              expect(persisted).not.toHaveProperty("acceptedSurfaceAt");
            } else {
              expect(persisted).toMatchObject({ acceptedSurface: { tools: ["fixture.tool"] } });
            }
          } finally {
            release.resolve();
            await enabling.catch(() => undefined);
          }
        },
      );
    },
  );
});
