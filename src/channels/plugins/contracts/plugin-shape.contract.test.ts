import { sanitizeAssistantVisibleText } from "openclaw/plugin-sdk/text-chunking";
import { beforeAll, describe, expect, it } from "vitest";
import { listBundledPackageChannelMetadata } from "../../../plugins/bundled-package-channel-metadata.js";
import {
  getBundledChannelPluginAsync,
  listBundledChannelPluginIds,
} from "./test-helpers/bundled-channel-plugin-loader.js";

const bundledChannelPluginIds = listBundledChannelPluginIds();
const packageMetadataById = new Map(
  listBundledPackageChannelMetadata().map((channel) => [channel.id, channel]),
);
const SHARED_SANITIZER_CHANNEL_IDS = [
  "nextcloud-talk",
  "zalo",
  "irc",
  "feishu",
  "signal",
  "twitch",
  "matrix",
  "slack",
] as const;

describe("bundled channel plugin shape coherence", () => {
  const plugins = new Map<string, Awaited<ReturnType<typeof getBundledChannelPluginAsync>>>();

  beforeAll(async () => {
    for (const id of bundledChannelPluginIds) {
      plugins.set(id, await getBundledChannelPluginAsync(id));
    }
  });

  it.each(SHARED_SANITIZER_CHANNEL_IDS)(
    "%s applies shared sanitizer semantics to outbound text",
    (id) => {
      const sanitizeText = plugins.get(id)?.outbound?.sanitizeText;
      if (!sanitizeText) {
        throw new Error(`Missing outbound sanitizeText hook for ${id}`);
      }
      const visible = `Visible answer: ${id}`;
      const text = [
        '<invoke name="read">payload</invoke></minimax:tool_call>',
        '<tool_result>{"output":"hidden"}</tool_result>',
        "[Tool Call: read (ID: toolu_1)]",
        'Arguments: {"path":"/tmp/x"}',
        "<think>secret</think>",
        visible,
      ].join("\n");
      const expected = sanitizeAssistantVisibleText(text);

      expect(expected).toBe(visible);
      expect(sanitizeText({ text, payload: { text } })).toBe(expected);
    },
  );

  describe.each(bundledChannelPluginIds)("%s", (id) => {
    it("keeps runtime and lazy setup metadata on the same channel-owned contract", () => {
      const plugin = plugins.get(id);
      const packageSetup = packageMetadataById.get(id)?.setup;
      if (!plugin?.setup && !plugin?.setupContract && !packageSetup) {
        return;
      }
      expect(plugin?.setupContract, `${id} must expose setupContract`).toBeDefined();
      expect(
        plugin?.setup,
        `${id} must not duplicate the released legacy setup adapter`,
      ).toBeUndefined();
      expect(packageSetup, `${id} must expose package setup metadata`).toBeDefined();
      expect(plugin?.setupContract?.metadata).toEqual(packageSetup);
    });
  });
});
