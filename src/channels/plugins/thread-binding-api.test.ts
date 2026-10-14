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
          resolveInboundConversation: () => ({
            conversationId: " $thread ",
            parentConversationId: " !room:example ",
          }),
        };
      }
      return null;
    },
  ),
}));

vi.mock("../../plugins/public-surface-loader.js", () => ({
  loadBundledPluginPublicArtifactModuleFromCandidatesSync:
    loadBundledPluginPublicArtifactModuleFromCandidatesSyncMock,
}));

import {
  resolveBundledChannelThreadBindingDefaultPlacement,
  resolveBundledChannelThreadBindingInboundConversation,
} from "./thread-binding-api.js";

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

  it("loads inbound conversation resolution from the narrow artifact", () => {
    expect(
      resolveBundledChannelThreadBindingInboundConversation({
        channelId: " matrix ",
        to: "room:!room:example",
        threadId: "$thread",
        isGroup: true,
      }),
    ).toEqual({
      conversationId: " $thread ",
      parentConversationId: " !room:example ",
    });
  });

  it("treats missing artifacts as absent hints", () => {
    // "absent" is a synthetic channel; real bundled artifacts are covered by
    // the thread-binding artifact parity contract test.
    expect(resolveBundledChannelThreadBindingDefaultPlacement("absent")).toBeUndefined();
    expect(
      resolveBundledChannelThreadBindingInboundConversation({
        channelId: "absent",
        to: "channel:general",
        isGroup: true,
      }),
    ).toBeUndefined();
  });
});
