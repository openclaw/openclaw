import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadBundledPluginPublicArtifactModuleSyncMock } = vi.hoisted(() => ({
  loadBundledPluginPublicArtifactModuleSyncMock: vi.fn(
    ({ artifactBasename, dirName }: { artifactBasename: string; dirName: string }) => {
      if (dirName === "matrix" && artifactBasename === "thread-binding-api.js") {
        return {
          defaultTopLevelPlacement: "child",
          resolveInboundConversation: () => ({
            conversationId: " $thread ",
            parentConversationId: " !room:example ",
          }),
        };
      }
      if (dirName === "telegram" && artifactBasename === "thread-binding-api.js") {
        return {
          defaultTopLevelPlacement: "current",
          supportsAutomaticThreadBindingSpawn: { subagent: true, acp: false },
        };
      }
      if (dirName === "child-disabled" && artifactBasename === "thread-binding-api.js") {
        return {
          defaultTopLevelPlacement: "child",
          supportsAutomaticThreadBindingSpawn: false,
        };
      }
      if (dirName === "invalid" && artifactBasename === "thread-binding-api.js") {
        return {
          defaultTopLevelPlacement: "floating",
          supportsAutomaticThreadBindingSpawn: "yes",
        };
      }
      if (dirName === "empty" && artifactBasename === "thread-binding-api.js") {
        return {};
      }
      if (dirName === "broken" && artifactBasename === "thread-binding-api.js") {
        throw new Error("broken thread binding artifact");
      }
      throw new Error(
        `Unable to resolve bundled plugin public surface ${dirName}/${artifactBasename}`,
      );
    },
  ),
}));

vi.mock("../../plugins/public-surface-loader.js", () => ({
  loadBundledPluginPublicArtifactModuleSync: loadBundledPluginPublicArtifactModuleSyncMock,
}));

import {
  resolveBundledChannelThreadBindingAutomaticSpawnSupport,
  resolveBundledChannelThreadBindingDefaultPlacement,
  resolveBundledChannelThreadBindingInboundConversation,
} from "./thread-binding-api.js";

describe("bundled channel thread binding fast path", () => {
  beforeEach(() => {
    loadBundledPluginPublicArtifactModuleSyncMock.mockClear();
  });

  it("loads default placement from the narrow thread binding artifact", () => {
    expect(resolveBundledChannelThreadBindingDefaultPlacement("matrix")).toBe("child");
    expect(loadBundledPluginPublicArtifactModuleSyncMock).toHaveBeenCalledWith({
      dirName: "matrix",
      artifactBasename: "thread-binding-api.js",
    });
  });

  it("loads explicit automatic spawn support from the narrow thread binding artifact", () => {
    expect(resolveBundledChannelThreadBindingDefaultPlacement("telegram")).toBe("current");
    expect(resolveBundledChannelThreadBindingAutomaticSpawnSupport("telegram")).toBe(true);
    expect(resolveBundledChannelThreadBindingAutomaticSpawnSupport("telegram", "subagent")).toBe(
      true,
    );
    expect(resolveBundledChannelThreadBindingAutomaticSpawnSupport("telegram", "acp")).toBe(false);
    expect(resolveBundledChannelThreadBindingAutomaticSpawnSupport("child-disabled")).toBe(false);
  });

  it("loads inbound conversation resolution from the narrow artifact", () => {
    expect(
      resolveBundledChannelThreadBindingInboundConversation({
        channelId: "matrix",
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
    expect(resolveBundledChannelThreadBindingDefaultPlacement("discord")).toBeUndefined();
    expect(
      resolveBundledChannelThreadBindingInboundConversation({
        channelId: "discord",
        to: "channel:general",
        isGroup: true,
      }),
    ).toBeUndefined();
  });

  it("ignores invalid placement and automatic spawn support values", () => {
    expect(resolveBundledChannelThreadBindingDefaultPlacement("invalid")).toBeUndefined();
    expect(resolveBundledChannelThreadBindingAutomaticSpawnSupport("invalid")).toBeUndefined();
  });

  it("distinguishes a present artifact without an inbound resolver from a missing artifact", () => {
    expect(
      resolveBundledChannelThreadBindingInboundConversation({
        channelId: "empty",
        to: "channel:general",
        isGroup: true,
      }),
    ).toBeUndefined();
  });

  it("surfaces errors from present thread binding artifacts", () => {
    expect(() => resolveBundledChannelThreadBindingDefaultPlacement("broken")).toThrow(
      "broken thread binding artifact",
    );
  });
});
