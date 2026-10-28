import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import * as publicSurfaceLoader from "../../plugins/public-surface-loader.js";
import { resolveRelativeBundledPluginPublicModuleId } from "../../test-utils/bundled-plugin-public-surface.js";

/** Keep genuine provider policy artifacts in the test runner's SDK module graph. */
export function useBundledProviderPolicyArtifactsForTest(pluginIds: readonly string[]): void {
  const artifacts = new Map<string, object>();
  const loadArtifact = publicSurfaceLoader.loadBundledPluginPublicArtifactModuleFromCandidatesSync;
  let restoreLoader = () => {};
  const installLoader = () => {
    restoreLoader();
    const loader = vi
      .spyOn(publicSurfaceLoader, "loadBundledPluginPublicArtifactModuleFromCandidatesSync")
      .mockImplementation((params) => {
        const artifact = artifacts.get(params.dirName);
        if (
          artifact &&
          !params.owner &&
          !params.env &&
          params.artifactCandidates.length === 1 &&
          params.artifactCandidates[0] === "provider-policy-api.js"
        ) {
          return artifact;
        }
        return loadArtifact(params);
      });
    restoreLoader = () => loader.mockRestore();
  };
  beforeAll(async () => {
    for (const pluginId of pluginIds) {
      const moduleId = resolveRelativeBundledPluginPublicModuleId({
        fromModuleUrl: import.meta.url,
        pluginId,
        artifactBasename: "provider-policy-api.js",
      });
      const artifact: object = await import(moduleId);
      artifacts.set(pluginId, artifact);
    }
    installLoader();
  });
  beforeEach(installLoader);
  afterEach(() => restoreLoader());
  afterAll(() => {
    restoreLoader();
    artifacts.clear();
  });
}
