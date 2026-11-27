import fs from "node:fs";
import { expect, it, vi } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { writePersistedInstalledPluginIndex } from "./installed-plugin-index-store-write.js";
import { createFixture } from "./plugin-generation-artifact.admission.test-support.js";
import { captureResources, createSdkHost } from "./plugin-generation-capture.test-support.js";
import {
  nativeAdmissionStateFor,
  preparePluginNativeAdmissions,
  settlePluginNativeAdmissions,
} from "./plugin-native-admission-state.js";

it.each(["pending", "settled", "different prototype"] as const)(
  "attaches the native generation's host with a %s receipt",
  async (kind) => {
    await withOpenClawTestState({ label: "native-publication-attach" }, async (state) => {
      await using resources = captureResources();
      const fixture = createFixture(state.path("installed"), true);
      const host = createSdkHost(state.path("host"), "original");
      await writePersistedInstalledPluginIndex(fixture.index, { stateDir: state.stateDir });
      const cache = resources.cache();
      preparePluginNativeAdmissions(fixture.index, cache);
      const artifact = resources.capture(cache, fixture.root);
      const admission = nativeAdmissionStateFor(cache);
      const [key, published] = [...admission.receipts][0]!;
      expect(admission.publications.get(key)?.data.receipt).toBe(published);
      const namespaceId = published.nativeArtifacts[fixture.filename]!.namespace;
      const live = admission.namespaces.get(namespaceId)!;
      expect(published.nativeNamespaces[namespaceId]!.members).not.toBe(live.members);

      if (kind === "settled") {
        await settlePluginNativeAdmissions(cache);
      } else if (kind === "different prototype") {
        // structuredClone normalizes this dictionary before comparing it with the published receipt.
        live.members = { ...live.members };
        Object.setPrototypeOf(live.members, null);
      }
      const clone = vi.spyOn(globalThis, "structuredClone");
      const receiptClones = () =>
        clone.mock.calls.filter(
          ([value]) => value && typeof value === "object" && "nativeNamespaces" in value,
        );
      try {
        artifact.linkHost(host);
        expect(receiptClones()).toHaveLength(kind === "pending" ? 0 : 1);
        expect(admission.receipts.get(key)).toBe(published);
        expect(fs.readFileSync(artifact.resolve(fixture.filename)).equals(fixture.bytes)).toBe(
          true,
        );
      } finally {
        clone.mockRestore();
      }
      await settlePluginNativeAdmissions(cache);
      expect(admission.publications.has(key)).toBe(false);
    });
  },
);
