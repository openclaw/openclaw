import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizePluginsConfig } from "../../../plugins/config-state.js";
import { collectGitHubUpgradeWarnings } from "./github-preview-upgrade.js";
const { load } = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("../../../plugins/public-surface-loader.js", () => ({
  loadBundledPluginPublicArtifactModuleFromCandidatesSync: load,
}));
afterEach(() => vi.resetAllMocks());
describe("optional GitHub upgrade diagnostics", () => {
  it("does not prevent ordinary Doctor repairs when the bundled artifact is absent", () => {
    load.mockReturnValue(null);
    expect(collectGitHubUpgradeWarnings(normalizePluginsConfig())).toEqual([]);
    expect(load).toHaveBeenCalledWith({
      dirName: "github",
      artifactCandidates: ["upgrade-api.js"],
    });
  });
  it("passes prepared policy to the plugin without changing it", () => {
    const policy = normalizePluginsConfig({ allow: ["telegram"] });
    const before = structuredClone(policy);
    const diagnose = vi.fn(() => ["Opt in explicitly"]);
    load.mockReturnValue({ collectGitHubUpgradeWarnings: diagnose });
    expect(collectGitHubUpgradeWarnings(policy)).toEqual(["Opt in explicitly"]);
    expect(diagnose).toHaveBeenCalledWith(policy);
    expect(policy).toEqual(before);
  });
  it("does not hide a corrupt or failing artifact as an absent optional plugin", () => {
    const failure = new Error("Artifact failed to load");
    load.mockImplementation(() => {
      throw failure;
    });
    expect(() => collectGitHubUpgradeWarnings(normalizePluginsConfig())).toThrow(failure);
  });
});
