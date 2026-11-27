import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "./plugin-cache.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import {
  nativeAdmissionStateFor,
  overlayPluginNativeAdmissions,
} from "./plugin-native-admission-state.js";
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

it("joins native receipts to exact roots in one pass per overlay", async () => {
  const cache = createPluginCache();
  try {
    const root = path.resolve("plugin");
    const { index } = createPluginMetadataSnapshotFixture({
      plugins: [
        { id: "one", rootDir: root },
        { id: "alias", rootDir: `${root}${path.sep}.` },
        { id: "other", rootDir: `${root}-extra` },
      ],
    });
    const overlay = () => overlayPluginNativeAdmissions(index, cache);
    expect(overlay()).toBe(index);
    const { receipts } = nativeAdmissionStateFor(cache);
    expect(overlay()).toBe(index);
    const receipt = {
      signature: "published",
      sourceDigest: "a".repeat(64),
      nativeArtifacts: {},
      nativeNamespaces: {},
    };
    const current = { ...receipt, signature: "current" };
    const pinned = `${root}\0first\0nested`;
    const empty = `${root}\0`;
    const record = index.plugins[0]!;
    record.sourceAdmissions = { [pinned]: receipt };
    receipts.set(`${root}-unknown\0suffix`, current);
    receipts.set(`${root}x`, current);
    const unmatched = overlay();
    expect(unmatched).not.toBe(index);
    expect(unmatched.plugins).not.toBe(index.plugins);
    expect(unmatched.plugins[0]).toBe(record);
    receipts.set(empty, receipt);
    receipts.set(pinned, current);
    const scans = vi.spyOn(receipts, Symbol.iterator);
    const [first, alias, other] = overlay().plugins;
    expect(scans).toHaveBeenCalledTimes(1);
    expect(Object.keys(first!.sourceAdmissions!)).toEqual([pinned, empty]);
    expect(Object.keys(alias!.sourceAdmissions!)).toEqual([empty, pinned]);
    expect(first!.sourceAdmissions![pinned]).toBe(current);
    expect(alias!.sourceAdmissions![empty]).toBe(receipt);
    expect(first!.sourceAdmissions).not.toBe(alias!.sourceAdmissions);
    expect(record.sourceAdmissions[pinned]).toBe(receipt);
    expect(other).toBe(index.plugins[2]);
    receipts.delete(pinned);
    expect(overlay().plugins[0]!.sourceAdmissions![pinned]).toBe(receipt);
    record.rootDir = `${root}-moved`;
    expect(overlay().plugins[0]).toBe(record);
  } finally {
    await retirePluginCache(cache);
  }
});
