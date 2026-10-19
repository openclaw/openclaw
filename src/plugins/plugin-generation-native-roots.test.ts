import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "./plugin-cache.js";
import { createPluginGenerationNativeRoots } from "./plugin-generation-native-roots.js";
import {
  adoptPluginNativeAdmissions,
  nativeAdmissionStateFor,
} from "./plugin-native-admission-state.js";
import type { PluginSourceAdmissionPublication } from "./plugin-source-admission.types.js";
import { withPluginSourceCaptureStorage } from "./plugin-source-capture-context.js";

it.each(["fresh", "reused"] as const)(
  "holds %s native bytes until publication settles after preparation closes",
  async (mode) => {
    await withOpenClawTestState({ label: "native-publication-custody" }, async (state) => {
      const cache = createPluginCache();
      const storage = { stateDir: state.stateDir, placement: "temporary" as const };
      try {
        await withPluginCache(cache, () =>
          withPluginSourceCaptureStorage(storage, async () => {
            const admission = nativeAdmissionStateFor();
            const original = createPluginGenerationNativeRoots(storage, admission);
            const reference = original.allocate();
            const filename = path.join(reference.directory, "addon.node");
            fs.writeFileSync(filename, "native bytes");
            const publication: PluginSourceAdmissionPublication = {
              pluginId: "fixture",
              rootDir: state.path("installed"),
              key: "fixture",
              receipt: {
                signature: "fixture",
                sourceDigest: "a".repeat(64),
                nativeArtifacts: {},
                nativeNamespaces: {
                  [reference.directory]: {
                    sourceDirectory: state.path("installed"),
                    capturedRoot: reference.directory,
                    managed: false,
                    members: {},
                  },
                },
              },
            };
            if (mode === "reused") {
              adoptPluginNativeAdmissions(admission, {
                receipts: new Map(),
                roots: [original.retain(reference.id)],
              });
              await original.close();
            }
            const preparing =
              mode === "fresh" ? original : createPluginGenerationNativeRoots(storage, admission);
            const gate = createDeferredCore<boolean>();
            const publishing = preparing.publish(publication, () => gate.promise);
            try {
              await preparing.close();
              await retirePluginCache(cache);
              expect(fs.readFileSync(filename, "utf8")).toBe("native bytes");
            } finally {
              gate.resolve(true);
              await publishing;
            }
            await expect(publishing).resolves.toBe(true);
            expect(fs.readFileSync(filename, "utf8")).toBe("native bytes");
            await expect(preparing.publish(publication, async () => true)).resolves.toBe(false);
          }),
        );
      } finally {
        await retirePluginCache(cache);
      }
    });
  },
);

it.each(["declined", "failed"] as const)(
  "releases unpublished bytes when a pending write is %s after preparation exits",
  async (outcome) => {
    await withOpenClawTestState({ label: "native-publication-failure" }, async (state) => {
      const cache = createPluginCache();
      const storage = { stateDir: state.stateDir, placement: "temporary" as const };
      try {
        await withPluginCache(cache, () =>
          withPluginSourceCaptureStorage(storage, async () => {
            const roots = createPluginGenerationNativeRoots(storage, nativeAdmissionStateFor());
            const reference = roots.allocate();
            const gate = createDeferredCore<boolean>();
            const publishing = roots.publish(
              {
                pluginId: "fixture",
                rootDir: state.path("installed"),
                key: "fixture",
                receipt: {
                  signature: "fixture",
                  sourceDigest: "a".repeat(64),
                  nativeArtifacts: {},
                  nativeNamespaces: {
                    [reference.directory]: {
                      sourceDirectory: state.path("installed"),
                      capturedRoot: reference.directory,
                      managed: false,
                      members: {},
                    },
                  },
                },
              },
              () => gate.promise,
            );
            void publishing.catch(() => {});
            try {
              await roots.close();
              expect(fs.existsSync(reference.directory)).toBe(true);
              if (outcome === "failed") {
                gate.reject(new Error("receipt write failed"));
                await expect(publishing).rejects.toThrow("receipt write failed");
              } else {
                gate.resolve(false);
                await expect(publishing).resolves.toBe(false);
              }
            } finally {
              gate.resolve(false);
              await publishing.catch(() => {});
            }
            expect(fs.existsSync(reference.directory)).toBe(false);
          }),
        );
      } finally {
        await retirePluginCache(cache);
      }
    });
  },
);
