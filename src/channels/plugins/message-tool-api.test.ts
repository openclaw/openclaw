// Message tool API tests cover channel message tool descriptors and runtime calls.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createConfiguredMessageToolDiscoveryAdapter } from "./outbound-message-tool-discovery.js";

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
      return null;
    },
  ),
}));

vi.mock("../../plugins/public-surface-loader.js", () => ({
  loadBundledPluginPublicArtifactModuleFromCandidatesSync:
    loadBundledPluginPublicArtifactModuleFromCandidatesSyncMock,
}));

import { createChannelTestPluginBase } from "../../test-utils/channel-plugins.js";
import { resolveBundledChannelMessageToolDiscoveryAdapter } from "./message-tool-api.js";
import type { AnyChannelPlugin } from "./types.plugin.js";

describe("bundled channel message tool fast path", () => {
  beforeEach(() => {
    loadBundledPluginPublicArtifactModuleFromCandidatesSyncMock.mockClear();
  });

  it("loads message tool discovery from the narrow artifact", () => {
    const adapter = resolveBundledChannelMessageToolDiscoveryAdapter(" slack ");
    expect(adapter?.describeMessageTool?.({ cfg: {} })).toStrictEqual({
      actions: ["send", "upload-file"],
      capabilities: ["presentation"],
      schema: null,
    });
    expect(loadBundledPluginPublicArtifactModuleFromCandidatesSyncMock).toHaveBeenCalledWith({
      dirName: "slack",
      artifactCandidates: ["message-tool-api.js"],
    });
  });

  it("treats missing artifacts as absent discovery", () => {
    expect(resolveBundledChannelMessageToolDiscoveryAdapter("discord")).toBeUndefined();
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

describe("configured outbound discovery", () => {
  it.each(["legacy", "modern"] as const)(
    "uses %s send adapters and config facts without a live connection",
    async (kind) => {
      const operational = vi.fn(async () => {
        throw new Error("Operational account preparation must not run");
      });
      let enabled = true;
      let configured = true;
      const plugin: AnyChannelPlugin = {
        ...createChannelTestPluginBase({
          id: "fixture",
          config: {
            resolveAccount: () => ({ enabled, configured }),
            resolveAccountAsync: operational,
            isConfigured: (account) => account.configured,
          },
        }),
        ...(kind === "legacy"
          ? {
              outbound: {
                deliveryMode: "direct" as const,
                sendText: async () => ({ channel: "fixture", messageId: "synthetic-receipt" }),
              },
            }
          : {
              message: {
                send: {
                  text: async () => ({ receipt: { platformMessageIds: [], parts: [], sentAt: 1 } }),
                },
              },
            }),
      };
      const adapter = createConfiguredMessageToolDiscoveryAdapter(plugin)!;
      const context = { cfg: {} };
      expect(adapter.describeMessageTool(context)?.actions).toEqual(["send"]);
      expect((await adapter.describeMessageToolAsync?.(context))?.actions).toEqual(["send"]);
      configured = false;
      expect(adapter.describeMessageTool(context)).toBeNull();
      expect(await adapter.describeMessageToolAsync?.(context)).toBeNull();
      configured = true;
      enabled = false;
      expect(adapter.describeMessageTool(context)).toBeNull();
      expect(await adapter.describeMessageToolAsync?.(context)).toBeNull();
      expect(operational).not.toHaveBeenCalled();
    },
  );

  it("does not mistake a foreign source account for the channel configuration", async () => {
    const adapter = createConfiguredMessageToolDiscoveryAdapter({
      ...createChannelTestPluginBase({
        id: "fixture",
        config: {
          resolveAccount: (_cfg, id) => ({ configured: id === "default" }),
          isConfigured: (account) => account.configured,
        },
      }),
      outbound: {
        deliveryMode: "direct",
        sendText: async () => ({ channel: "fixture", messageId: "unused" }),
      },
    })!;
    const context = { cfg: {}, accountId: "foreign-source-account" };
    expect(adapter.describeMessageTool(context)?.actions).toEqual(["send"]);
    expect((await adapter.describeMessageToolAsync?.(context))?.actions).toEqual(["send"]);
  });

  it.each([{ enabled: true, configured: false }, { enabled: false }])(
    "honors read-only owner inspection: %o",
    async (inspection) => {
      const resolveAccount = vi.fn(() => {
        throw new Error("Inspection is authoritative");
      });
      const adapter = createConfiguredMessageToolDiscoveryAdapter({
        ...createChannelTestPluginBase({
          id: "fixture",
          config: {
            inspectAccount: () => inspection,
            resolveAccount,
          },
        }),
        outbound: {
          deliveryMode: "direct",
          sendText: async () => ({ channel: "fixture", messageId: "unused" }),
        },
      })!;
      expect(adapter.describeMessageTool({ cfg: {} })).toBeNull();
      expect(await adapter.describeMessageToolAsync?.({ cfg: {} })).toBeNull();
      expect(resolveAccount).not.toHaveBeenCalled();
    },
  );
});
