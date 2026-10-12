import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "./plugin-cache.js";
import { nativeAdmissionStateFor } from "./plugin-native-admission-state.js";
import { createPluginNativeAdmission } from "./plugin-native-admission.js";

it("bounds native source reads across capture misses and preserves canonical companion paths", async () => {
  await withOpenClawTestState({ label: "native-source-index" }, async (state) => {
    const root = state.path("plugin");
    const capture = state.path("capture");
    fs.mkdirSync(root);
    fs.mkdirSync(capture);
    fs.writeFileSync(path.join(root, "package.json"), '{"name":"native-source-index"}');
    const native = path.join(root, "addon.so");
    const companion = path.join(root, "companion.txt");
    fs.writeFileSync(native, "native fixture");
    fs.writeFileSync(companion, "companion fixture");
    fs.symlinkSync(companion, path.join(root, "a-companion.txt"));
    const cache = createPluginCache();
    try {
      const admission = withPluginCache(cache, () => {
        const value = createPluginNativeAdmission(root, capture);
        value.materialize(
          native,
          root,
          path.join(capture, "addon.so"),
          fs.statSync(native, { bigint: true }),
        );
        return value;
      });
      const namespace = withPluginCache(
        cache,
        () => [...nativeAdmissionStateFor().namespaces.values()][0]!,
      );
      expect(admission.resolvePreparedSource(companion)?.path).toBe(
        path.join(namespace.capturedRoot, "content", "companion.txt"),
      );

      let sourceReads = 0;
      const members = Object.values(namespace.members);
      for (const member of members) {
        const source = member.source;
        Object.defineProperty(member, "source", {
          get() {
            sourceReads++;
            return source;
          },
        });
      }
      for (let index = 0; index < 3; index++) {
        expect(admission.resolvePreparedSource(state.path(`other-${index}.js`))).toBeUndefined();
      }
      expect(sourceReads).toBeLessThanOrEqual(members.length);
      expect(admission.resolvePreparedSource(companion)?.path).toBe(
        path.join(namespace.capturedRoot, "content", "companion.txt"),
      );
    } finally {
      await retirePluginCache(cache);
    }
  });
});
