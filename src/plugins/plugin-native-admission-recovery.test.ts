import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "./plugin-cache.js";
import {
  nativeAdmissionStateFor,
  releaseReplacedNamespaces,
} from "./plugin-native-admission-state.js";
import { createPluginNativeAdmission } from "./plugin-native-admission.js";

it("puts a published namespace back in the shared map after a prune", async () => {
  await withOpenClawTestState({ label: "native-republish-prune" }, async (state) => {
    const root = state.path("plugin");
    const capture = state.path("capture");
    fs.mkdirSync(root);
    fs.mkdirSync(capture);
    fs.writeFileSync(path.join(root, "package.json"), '{"name":"native-republish-prune"}');
    const natives = ["addon.so", "second.so"].map((name) => path.join(root, name));
    for (const native of natives) {
      fs.writeFileSync(native, `native fixture ${path.basename(native)}`);
    }
    const cache = createPluginCache();
    try {
      withPluginCache(cache, () => {
        const admission = createPluginNativeAdmission(root, capture);
        const receipt = { signature: "republish", sourceDigest: "a".repeat(64) };
        for (const native of natives) {
          const materialized = admission.materialize(
            native,
            root,
            path.join(capture, path.basename(native)),
            fs.statSync(native, { bigint: true }),
          )!;
          const bytes = fs.readFileSync(native);
          materialized.record({
            contentHash: createHash("sha256").update(bytes).digest("hex"),
            sizeBytes: bytes.length,
          });
          if (native === natives[0]) {
            admission.finish(receipt);
            // A newer receipt for the same plugin prunes the shared map between the two publishes.
            nativeAdmissionStateFor().namespaces.clear();
          }
        }
        admission.finish({ ...receipt, signature: "republish-2" });
        const current = [...nativeAdmissionStateFor().receipts.values()].at(-1)!;
        for (const id of Object.keys(current.nativeNamespaces)) {
          expect(nativeAdmissionStateFor().namespaces.has(id)).toBe(true);
        }
      });
    } finally {
      await retirePluginCache(cache);
    }
  });
});

it("keeps a recovered namespace resolvable after a newer receipt prunes the shared map", async () => {
  await withOpenClawTestState({ label: "native-recovery-prune" }, async (state) => {
    const root = state.path("plugin");
    const capture = state.path("capture");
    fs.mkdirSync(root);
    fs.mkdirSync(capture);
    fs.writeFileSync(path.join(root, "package.json"), '{"name":"native-recovery-prune"}');
    const native = path.join(root, "addon.so");
    fs.writeFileSync(native, "native fixture");
    const cache = createPluginCache();
    try {
      withPluginCache(cache, () => {
        const first = createPluginNativeAdmission(root, capture);
        const target = path.join(capture, "addon.so");
        const materialized = first.materialize(
          native,
          root,
          target,
          fs.statSync(native, { bigint: true }),
        )!;
        const bytes = fs.readFileSync(native);
        materialized.record({
          contentHash: createHash("sha256").update(bytes).digest("hex"),
          sizeBytes: bytes.length,
        });
        const receipt = { signature: "first", sourceDigest: "a".repeat(64) };
        const recovery = first.captureRecovery(receipt, {});
        const recovered = createPluginNativeAdmission(root, capture, undefined, recovery);

        // A newer receipt for the same plugin replaces the recovered generation's receipt.
        releaseReplacedNamespaces(nativeAdmissionStateFor(), {
          ...receipt,
          nativeArtifacts: {},
          nativeNamespaces: Object.fromEntries(recovery.namespaces),
        });
        expect(nativeAdmissionStateFor().namespaces.size).toBe(0);

        expect(recovered.isRetainedReference(target)).toBe(true);
        const content = path.dirname(materialized.path);
        expect(
          recovered.materialize(
            materialized.path,
            content,
            path.join(capture, "again.so"),
            fs.statSync(materialized.path, { bigint: true }),
          )?.path,
        ).toBe(materialized.path);
      });
    } finally {
      await retirePluginCache(cache);
    }
  });
});
