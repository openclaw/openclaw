// Cold conversation resolution uses narrow artifacts before full plugin loading.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";

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

vi.mock("../plugins/public-surface-loader.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/public-surface-loader.js")>()),
  loadBundledPluginPublicArtifactModuleFromCandidatesSync:
    loadBundledPluginPublicArtifactModuleFromCandidatesSyncMock,
}));

import {
  resolveChannelDefaultBindingPlacement,
  resolveInboundConversationResolution,
} from "./conversation-resolution.js";

describe("bundled channel thread binding fast path", () => {
  beforeEach(() => {
    setActivePluginRegistry(createTestRegistry());
    loadBundledPluginPublicArtifactModuleFromCandidatesSyncMock.mockClear();
  });
  afterEach(() => setActivePluginRegistry(createTestRegistry()));

  it("loads default placement from the narrow thread binding artifact", () => {
    expect(resolveChannelDefaultBindingPlacement(" matrix ")).toBe("child");
    expect(loadBundledPluginPublicArtifactModuleFromCandidatesSyncMock).toHaveBeenCalledWith({
      dirName: "matrix",
      artifactCandidates: ["thread-binding-api.js"],
    });
  });

  it("loads inbound conversation resolution from the narrow artifact", () => {
    expect(
      resolveInboundConversationResolution({
        cfg: {},
        channel: " matrix ",
        to: "room:!room:example",
        threadId: "$thread",
      }),
    ).toEqual({
      channel: "matrix",
      accountId: "default",
      conversationId: "$thread",
      parentConversationId: "!room:example",
      threadId: "$thread",
    });
  });

  it("treats missing artifacts as absent hints", () => {
    // "absent" is a synthetic channel; real bundled artifacts are covered by
    // the thread-binding artifact parity contract test.
    expect(resolveChannelDefaultBindingPlacement("absent")).toBeUndefined();
    expect(
      resolveInboundConversationResolution({
        cfg: {},
        channel: "absent",
        to: "channel:general",
      }),
    ).toEqual({ channel: "absent", accountId: "default", conversationId: "general" });
  });
});
