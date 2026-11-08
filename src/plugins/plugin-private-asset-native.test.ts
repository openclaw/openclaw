import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  assertUpdateCandidatePluginAsset,
  captureUpdateCandidatePluginAsset,
  sealUpdateCandidatePluginAssets,
} from "../infra/update-candidate-plugin-assets.js";
import { captureUpdateCandidatePluginCodeLink } from "../infra/update-candidate-plugin-code-links.js";
import { createFixture } from "./plugin-generation-artifact.admission.test-support.js";
import { captureResources } from "./plugin-generation-capture.test-support.js";
import {
  nativeAdmissionStateFor,
  preparePluginNativeAdmissions,
} from "./plugin-native-admission-state.js";
import { withPluginSourceCaptureStorage } from "./plugin-source-capture-context.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

it.each([
  { name: "a-alias.so", nested: false },
  { name: "z-alias.so", nested: false },
  { name: "config.txt", nested: true },
])(
  "keeps physical asset targets copy-only in real managed state admission ($name)",
  async ({ name, nested }) => {
    const state = fs.realpathSync(dirs.make("private-native-managed-"));
    fs.chmodSync(state, 0o700);
    const fixture = createFixture(path.join(state, "extensions"), true);
    const alias = path.join(fixture.root, name);
    const nativeDirectory = nested ? path.join(fixture.root, "native") : fixture.root;
    if (nested) {
      fs.mkdirSync(nativeDirectory);
      fs.renameSync(fixture.filename, path.join(nativeDirectory, "fixture.bin"));
      fixture.filename = path.join(nativeDirectory, "fixture.bin");
    }
    fs.symlinkSync(path.relative(fixture.root, fixture.filename), alias);
    const ordinary = path.join(nativeDirectory, "ordinary.bin");
    fs.writeFileSync(ordinary, Buffer.alloc(128, "B"));
    const edge = captureUpdateCandidatePluginAsset(
      captureUpdateCandidatePluginCodeLink(
        alias,
        fs.lstatSync(alias, { bigint: true }),
        fs.readlinkSync(alias),
      ),
      state,
    );
    const receipt = await sealUpdateCandidatePluginAssets(state, [edge]);
    await using resources = captureResources();
    const cache = resources.cache();
    await withPluginSourceCaptureStorage(
      { stateDir: state, placement: "state", privateAssetReceipt: receipt },
      async () => {
        preparePluginNativeAdmissions(fixture.index, cache);
        expect(nativeAdmissionStateFor(cache).managedRoots.size).toBe(1);
        expect(fs.statSync(fixture.filename).dev).toBe(fs.statSync(state).dev);
        const artifact = resources.capture(cache, fixture.root);
        expect(fs.statSync(fixture.filename).nlink).toBe(1);
        expect(() => assertUpdateCandidatePluginAsset(edge)).not.toThrow();
        expect(fs.readFileSync(artifact.resolve(alias))).toEqual(fixture.bytes);
        // This control proves the managed same-device hardlink branch really ran.
        expect(fs.statSync(ordinary).nlink).toBeGreaterThan(1);
        const recovery = resources.keep(artifact.captureRecoverySource());
        expect(fs.readFileSync(recovery.resolve(alias))).toEqual(fixture.bytes);
        expect(() => assertUpdateCandidatePluginAsset(edge)).not.toThrow();
      },
    );
  },
);
