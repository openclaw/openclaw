import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { retirePluginCache, withPluginCache } from "./plugin-cache.js";
import { captureResources } from "./plugin-generation-capture.test-support.js";
import { createPluginGenerationNativeRoots } from "./plugin-generation-native-roots.js";
import {
  adoptPluginNativeAdmissions,
  nativeAdmissionStateFor,
} from "./plugin-native-admission-state.js";
import type { PluginSourceAdmissionPublication } from "./plugin-source-admission.types.js";
import { withPluginSourceCaptureStorage } from "./plugin-source-capture-context.js";

afterEach(() => vi.restoreAllMocks());

it.each([
  ["fresh", "accepted"],
  ["reused", "accepted"],
  ["fresh", "declined"],
  ["reused", "declined"],
  ["fresh", "failed"],
  ["reused", "failed"],
] as const)(
  "holds %s native bytes until a %s publication settles after preparation closes",
  (mode, outcome) =>
    withOpenClawTestState({ label: "native-publication-custody" }, async (state) => {
      await using resources = captureResources();
      const cache = resources.cache();
      const storage = { stateDir: state.stateDir, placement: "temporary" as const };
      const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
      await withPluginCache(cache, () =>
        withPluginSourceCaptureStorage(storage, async () => {
          const admission = nativeAdmissionStateFor();
          const original = createPluginGenerationNativeRoots(storage);
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
              publications: [],
              roots: [original.retain(reference.id)],
            });
            await original.close();
          }
          const preparing =
            mode === "fresh" ? original : createPluginGenerationNativeRoots(storage);
          const gate = createDeferredCore<boolean>();
          adoptPluginNativeAdmissions(
            admission,
            {
              receipts: new Map([[publication.key, publication.receipt]]),
              roots: mode === "fresh" ? [original.retain(reference.id)] : [],
              publications: [publication],
            },
            () => gate.promise,
          );
          await preparing.close();
          let retired = false;
          const retiring = retirePluginCache(cache).then(() => {
            retired = true;
          });
          try {
            await Promise.resolve();
            expect(retired).toBe(false);
            expect(fs.readFileSync(filename, "utf8")).toBe("native bytes");
            if (outcome === "failed") {
              gate.reject(new Error("receipt write failed"));
            } else {
              gate.resolve(outcome === "accepted");
            }
          } finally {
            gate.resolve(false);
            await retiring;
          }
          expect(fs.existsSync(filename)).toBe(outcome === "accepted");
          expect(warning.mock.calls.length > 0).toBe(outcome === "failed");
        }),
      );
    }),
);
