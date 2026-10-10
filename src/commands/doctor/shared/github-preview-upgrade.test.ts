import { afterEach, expect, it, vi } from "vitest";
import { normalizePluginsConfig } from "../../../plugins/config-state.js";
import { collectGitHubUpgradeWarnings } from "./github-preview-upgrade.js";

const { load } = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("../../../plugins/public-surface-loader.js", () => ({
  loadBundledPluginPublicArtifactModuleFromCandidatesSync: load,
}));
afterEach(() => vi.resetAllMocks());

it.each(["absent", "available", "corrupt"])(
  "handles an %s GitHub diagnostics artifact",
  (artifact) => {
    const policy = normalizePluginsConfig({ allow: ["telegram"] });
    const before = structuredClone(policy);
    const failure = new Error("Artifact failed to load");
    const diagnose = vi.fn(() => ["Opt in explicitly"]);
    load.mockImplementation(() => {
      if (artifact === "corrupt") {
        throw failure;
      }
      return artifact === "available" ? { collectGitHubUpgradeWarnings: diagnose } : null;
    });
    if (artifact === "corrupt") {
      expect(() => collectGitHubUpgradeWarnings(policy)).toThrow(failure);
    } else {
      expect(collectGitHubUpgradeWarnings(policy)).toEqual(
        artifact === "available" ? ["Opt in explicitly"] : [],
      );
      expect(load).toHaveBeenCalledWith({
        dirName: "github",
        artifactCandidates: ["upgrade-api.js"],
      });
      if (artifact === "available") {
        expect(diagnose).toHaveBeenCalledWith(policy);
      }
      expect(policy).toEqual(before);
    }
  },
);
