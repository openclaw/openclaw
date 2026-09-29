import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolvePluginInstallRoots, withPluginInstallRoots } from "./install-root-context.js";
import { writePersistedInstalledPluginIndex } from "./installed-plugin-index-store-write.js";
import { readPersistedInstalledPluginIndex } from "./installed-plugin-index-store.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "./plugin-cache.js";
import { createFixture } from "./plugin-generation-artifact.admission.test-support.js";
import { capturePluginGenerationArtifact } from "./plugin-generation-artifact.js";
import {
  preparePluginNativeAdmissions,
  settlePluginNativeAdmissions,
} from "./plugin-native-admission-state.js";
import { withPluginSourceCaptureStorage } from "./plugin-source-capture-context.js";

it.each(["state root", "temporary placement", "publication root"] as const)(
  "keeps native admission in its selected %s within one cache",
  async (change) => {
    await withOpenClawTestState({ label: "native-admission-storage" }, async (state) => {
      const runtimeTemp = state.path("capture-temp");
      fs.mkdirSync(runtimeTemp);
      await withEnvAsync({ TMPDIR: runtimeTemp, TMP: runtimeTemp, TEMP: runtimeTemp }, async () => {
        const fixture = createFixture(state.path("installed"), false);
        const otherState = state.path("other-state");
        const firstRoots = resolvePluginInstallRoots(state.env);
        const secondRoots =
          change === "publication root" ? { ...firstRoots, stateDir: otherState } : firstRoots;
        const scopes = [
          { storage: { stateDir: state.stateDir, placement: "state" as const }, roots: firstRoots },
          {
            storage: {
              stateDir: change === "state root" ? otherState : state.stateDir,
              placement:
                change === "temporary placement" ? ("temporary" as const) : ("state" as const),
            },
            roots: secondRoots,
          },
        ];
        const publicationRoots = [...new Set(scopes.map(({ roots }) => roots.stateDir))];
        const cache = createPluginCache();
        const artifacts: ReturnType<typeof capturePluginGenerationArtifact>[] = [];
        const capturedPaths: string[] = [];
        try {
          for (const stateDir of publicationRoots) {
            await writePersistedInstalledPluginIndex(fixture.index, { stateDir });
          }
          for (const { storage, roots } of scopes) {
            const artifact = withPluginCache(cache, () =>
              withPluginInstallRoots(roots, () =>
                withPluginSourceCaptureStorage(storage, () => {
                  preparePluginNativeAdmissions(fixture.index, cache);
                  return capturePluginGenerationArtifact(fixture.root);
                }),
              ),
            );
            artifacts.push(artifact);
            const captured = fs.realpathSync(artifact.resolve(fixture.filename));
            capturedPaths.push(captured);
            const managed =
              path.join(fs.realpathSync(storage.stateDir), "tmp", "plugin-captures") + path.sep;
            expect(captured.startsWith(managed)).toBe(storage.placement === "state");
            if (storage.placement === "temporary") {
              expect(captured.startsWith(fs.realpathSync(runtimeTemp) + path.sep)).toBe(true);
            }
            expect(fs.readFileSync(captured).equals(fixture.bytes)).toBe(true);
            artifact.assertSourceCurrent();
          }
          expect(capturedPaths[0] === capturedPaths[1]).toBe(false);
          await settlePluginNativeAdmissions(cache);
          for (const [index, { roots }] of scopes.entries()) {
            const persisted = await readPersistedInstalledPluginIndex({ stateDir: roots.stateDir });
            const receipt = Object.values(persisted?.plugins[0]?.sourceAdmissions ?? {})[0];
            const expected =
              change === "publication root" ? capturedPaths[index] : capturedPaths[1];
            expect(receipt?.nativeArtifacts[fixture.filename]?.capturedPath).toBe(expected);
          }
          expect(fs.readFileSync(capturedPaths[0]!).equals(fixture.bytes)).toBe(true);
        } finally {
          for (const artifact of artifacts) {
            await artifact.disposeAsync();
          }
          await retirePluginCache(cache);
          for (const stateDir of publicationRoots) {
            await closeOpenClawStateDatabaseByPathAsync(
              resolveOpenClawStateSqlitePath({
                ...state.env,
                OPENCLAW_STATE_DIR: stateDir,
              }),
            );
          }
        }
      });
    });
  },
);
