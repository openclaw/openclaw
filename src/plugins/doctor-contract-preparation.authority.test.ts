import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeDefaultRetainedNativeWorkerSource } from "../infra/worker-native-lifecycle.js";
import { preparePluginDoctorContractModules } from "./doctor-contract-preparation.js";
import { createDoctorGenerationFixture } from "./doctor-generation.test-support.js";
import {
  adoptProcessPluginCache,
  createPluginCache,
  getProcessPluginCache,
  invalidatePluginCacheMetadata,
  retirePluginCache,
  runOutsidePluginCache,
} from "./plugin-cache.js";
import { withPluginGenerationSourceCustody } from "./plugin-generation-source-lookup.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  await closeDefaultRetainedNativeWorkerSource();
});

it.each(["replacement", "metadata"] as const)(
  "rejects inventory %s between selected Doctor records",
  async (mode) => {
    const previous = getProcessPluginCache();
    const selected = createPluginCache();
    const replacement = createPluginCache();
    const records = ["first", "second"].flatMap((id) => {
      const rootDir = dirs.make(`doctor-authority-${id}-`);
      fs.writeFileSync(path.join(rootDir, "package.json"), '{"type":"module"}');
      fs.writeFileSync(
        path.join(rootDir, "doctor-contract-api.mjs"),
        "export const stateMigrations = [];",
      );
      return createDoctorGenerationFixture(rootDir, id).inventory({ stateMigrations: [] }).records;
    });
    let changed = false;
    adoptProcessPluginCache(selected);
    try {
      await runOutsidePluginCache(() =>
        withPluginGenerationSourceCustody(async () => {
          await expect(
            preparePluginDoctorContractModules({
              surfaces: ["stateMigrations"],
              inventory: {
                records,
                knownPluginIds: ["first", "second"],
                sessionStoreOwnerPluginIds: [],
                descriptors: [],
                unresolvedPluginIds: [],
              },
              assertCurrent() {
                // Publication changes after the first record binds, before the next starts.
                if (!changed && selected.setupModules.size === 1) {
                  changed = true;
                  if (mode === "replacement") {
                    adoptProcessPluginCache(replacement);
                  } else {
                    invalidatePluginCacheMetadata(selected);
                  }
                }
              },
            }),
          ).rejects.toThrow("Plugin setup inventory has retired");
          expect(changed).toBe(true);
          expect(selected.setupModules.size).toBe(1);
          expect(replacement.setupModules.size).toBe(0);
          expect(replacement.instances.size).toBe(0);
        }),
      );
    } finally {
      adoptProcessPluginCache(previous);
      await retirePluginCache(selected);
      await retirePluginCache(replacement);
    }
  },
);
