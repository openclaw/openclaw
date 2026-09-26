// Thread binding API tests cover channel plugin thread binding contracts and helpers.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadBundledPluginPublicArtifactModuleFromCandidatesSyncMock } = vi.hoisted(() => ({
  loadBundledPluginPublicArtifactModuleFromCandidatesSyncMock: vi.fn(
    ({
      artifactCandidates,
      dirName,
    }: {
      artifactCandidates: readonly string[];
      dirName: string;
    }) => {
      const artifactBasename = artifactCandidates[0];
      if (dirName === "matrix" && artifactBasename === "thread-binding-api.js") {
        return {
          defaultTopLevelPlacement: "child",
        };
      }
      if (dirName === "invalid" && artifactBasename === "thread-binding-api.js") {
        return {
          defaultTopLevelPlacement: "floating",
        };
      }
      if (dirName === "empty" && artifactBasename === "thread-binding-api.js") {
        return {};
      }
      if (dirName === "broken" && artifactBasename === "thread-binding-api.js") {
        throw new Error("broken thread binding artifact");
      }
      return null;
    },
  ),
}));

vi.mock("../../plugins/public-surface-loader.js", () => ({
  loadBundledPluginPublicArtifactModuleFromCandidatesSync:
    loadBundledPluginPublicArtifactModuleFromCandidatesSyncMock,
}));

import { resolveBundledChannelThreadBindingDefaultPlacement } from "./thread-binding-api.js";

describe("bundled channel thread binding fast path", () => {
  beforeEach(() => {
    loadBundledPluginPublicArtifactModuleFromCandidatesSyncMock.mockClear();
  });

  it("loads default placement from the narrow thread binding artifact", () => {
    expect(resolveBundledChannelThreadBindingDefaultPlacement(" matrix ")).toBe("child");
    expect(loadBundledPluginPublicArtifactModuleFromCandidatesSyncMock).toHaveBeenCalledWith({
      dirName: "matrix",
      artifactCandidates: ["thread-binding-api.js"],
    });
  });

  it("treats missing artifacts as absent hints", () => {
    expect(resolveBundledChannelThreadBindingDefaultPlacement("absent")).toBeUndefined();
  });

  it("ignores invalid placement values", () => {
    expect(resolveBundledChannelThreadBindingDefaultPlacement("invalid")).toBeUndefined();
  });

  it("surfaces errors from present thread binding artifacts", () => {
    expect(() => resolveBundledChannelThreadBindingDefaultPlacement("broken")).toThrow(
      "broken thread binding artifact",
    );
  });
});
