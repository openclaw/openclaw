// Covers markdown table config normalization and channel overrides.
import { describe, expect, it, vi } from "vitest";

const listChannelPluginsMock = vi.hoisted(() =>
  vi.fn(() => [
    { id: "mattermost", messaging: { defaultMarkdownTableMode: "off" as const } },
    { id: "signal", messaging: { defaultMarkdownTableMode: "block" as const } },
  ]),
);

vi.mock("../channels/plugins/registry.js", async () => {
  const actual = await vi.importActual<typeof import("../channels/plugins/registry.js")>(
    "../channels/plugins/registry.js",
  );
  return {
    ...actual,
    getLoadedChannelPlugin: (id: string) =>
      listChannelPluginsMock().find((plugin) => plugin.id === id),
    normalizeChannelId: (raw?: string | null) => (raw === "zalo" ? null : (raw ?? null)),
  };
});

import { resolveMarkdownTableMode } from "./markdown-tables.js";

describe("resolveMarkdownTableMode", () => {
  it("mattermost mode is off", () => {
    expect(resolveMarkdownTableMode({ channel: "mattermost" })).toBe("off");
  });

  it("defaults to code for slack", () => {
    expect(resolveMarkdownTableMode({ channel: "slack" })).toBe("code");
  });

  it("keeps block mode behind renderer capability", () => {
    expect(resolveMarkdownTableMode({ channel: "signal" })).toBe("code");
    expect(resolveMarkdownTableMode({ channel: "signal", supportsBlockTables: true })).toBe(
      "block",
    );
    const cfg = { channels: { signal: { markdown: { tables: "code" as const } } } };
    expect(resolveMarkdownTableMode({ cfg, channel: "signal", supportsBlockTables: true })).toBe(
      "code",
    );
  });

  it("keeps block capability checks without a loaded channel", () => {
    const cfg = { channels: { zalo: { markdown: { tables: "block" as const } } } };
    expect(resolveMarkdownTableMode({ cfg, channel: "zalo" })).toBe("code");
    expect(resolveMarkdownTableMode({ cfg, channel: "zalo", supportsBlockTables: true })).toBe(
      "block",
    );
  });
});
