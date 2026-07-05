// Message tool API tests cover channel message tool descriptors and runtime calls.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadBundledPluginPublicArtifactModuleSyncMock } = vi.hoisted(() => ({
  loadBundledPluginPublicArtifactModuleSyncMock: vi.fn(
    ({ artifactBasename, dirName }: { artifactBasename: string; dirName: string }) => {
      if (dirName === "slack" && artifactBasename === "message-tool-api.js") {
        return {
          describeMessageTool: () => ({
            actions: ["send", "upload-file"],
            capabilities: ["presentation"],
            schema: null,
          }),
        };
      }
      if (dirName === "empty" && artifactBasename === "message-tool-api.js") {
        return {};
      }
      if (dirName === "broken" && artifactBasename === "message-tool-api.js") {
        throw new Error("broken message tool artifact");
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

<<<<<<< HEAD
import { resolveBundledChannelMessageToolDiscoveryAdapter } from "./message-tool-api.js";
=======
import {
  describeBundledChannelMessageTool,
  resolveBundledChannelMessageToolDiscoveryAdapter,
} from "./message-tool-api.js";
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

describe("bundled channel message tool fast path", () => {
  beforeEach(() => {
    loadBundledPluginPublicArtifactModuleSyncMock.mockClear();
  });

  it("loads message tool discovery from the narrow artifact", () => {
    const adapter = resolveBundledChannelMessageToolDiscoveryAdapter("slack");
    expect(adapter?.describeMessageTool?.({ cfg: {} })).toStrictEqual({
      actions: ["send", "upload-file"],
      capabilities: ["presentation"],
      schema: null,
    });
    expect(loadBundledPluginPublicArtifactModuleSyncMock).toHaveBeenCalledWith({
      dirName: "slack",
      artifactBasename: "message-tool-api.js",
    });
  });

<<<<<<< HEAD
  it("treats missing artifacts as absent discovery", () => {
    expect(resolveBundledChannelMessageToolDiscoveryAdapter("discord")).toBeUndefined();
=======
  it("describes message tools through the same artifact", () => {
    expect(
      describeBundledChannelMessageTool({
        channelId: "slack",
        context: { cfg: {} },
      }),
    ).toStrictEqual({
      actions: ["send", "upload-file"],
      capabilities: ["presentation"],
      schema: null,
    });
  });

  it("treats missing artifacts as absent discovery", () => {
    expect(resolveBundledChannelMessageToolDiscoveryAdapter("discord")).toBeUndefined();
    expect(
      describeBundledChannelMessageTool({
        channelId: "discord",
        context: { cfg: {} },
      }),
    ).toBeUndefined();
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  });

  it("ignores present artifacts without discovery", () => {
    expect(resolveBundledChannelMessageToolDiscoveryAdapter("empty")).toBeUndefined();
  });

  it("surfaces errors from present message tool artifacts", () => {
    expect(() => resolveBundledChannelMessageToolDiscoveryAdapter("broken")).toThrow(
      "broken message tool artifact",
    );
  });
});
