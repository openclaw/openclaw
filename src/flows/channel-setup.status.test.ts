import { describe, expect, it, vi } from "vitest";

const listChatChannels = vi.hoisted(() => vi.fn(() => [{ id: "discord" }, { id: "bluebubbles" }]));

vi.mock("../channels/chat-meta.js", () => ({
  listChatChannels: () => listChatChannels(),
}));

vi.mock("../channels/registry.js", () => ({
  formatChannelPrimerLine: vi.fn(() => ""),
  formatChannelSelectionLine: vi.fn(() => ""),
}));

vi.mock("../commands/channel-setup/discovery.js", () => ({
  resolveChannelSetupEntries: vi.fn(() => ({
    entries: [],
    installedCatalogEntries: [],
    installableCatalogEntries: [],
    installedCatalogById: new Map(),
    installableCatalogById: new Map(),
  })),
  shouldShowChannelInSetup: (meta: { exposure?: { setup?: boolean }; showInSetup?: boolean }) =>
    meta.showInSetup !== false && meta.exposure?.setup !== false,
}));

import { resolveChannelSetupSelectionContributions } from "./channel-setup.status.js";

describe("resolveChannelSetupSelectionContributions", () => {
  it("sorts channels alphabetically by picker label", () => {
    const contributions = resolveChannelSetupSelectionContributions({
      entries: [
        {
          id: "zalo",
          meta: {
            id: "zalo",
            label: "Zalo",
            selectionLabel: "Zalo (Bot API)",
          },
        },
        {
          id: "discord",
          meta: {
            id: "discord",
            label: "Discord",
            selectionLabel: "Discord (Bot API)",
          },
        },
        {
          id: "bluebubbles",
          meta: {
            id: "bluebubbles",
            label: "BlueBubbles",
            selectionLabel: "BlueBubbles (macOS app)",
          },
        },
      ] as never,
      statusByChannel: new Map(),
      resolveDisabledHint: () => undefined,
    });

    expect(contributions.map((contribution) => contribution.option.label)).toEqual([
      "BlueBubbles (macOS app)",
      "Discord (Bot API)",
      "Zalo (Bot API)",
    ]);
  });

  it("does not invent hints before status has been collected", () => {
    const contributions = resolveChannelSetupSelectionContributions({
      entries: [
        {
          id: "zalo",
          meta: {
            id: "zalo",
            label: "Zalo",
            selectionLabel: "Zalo (Bot API)",
            quickstartAllowFrom: true,
          },
        },
      ] as never,
      statusByChannel: new Map(),
      resolveDisabledHint: () => undefined,
    });

    expect(contributions.map((contribution) => contribution.option)).toEqual([
      {
        value: "zalo",
        label: "Zalo (Bot API)",
      },
    ]);
  });

  it("combines real status and disabled hints when available", () => {
    const contributions = resolveChannelSetupSelectionContributions({
      entries: [
        {
          id: "zalo",
          meta: {
            id: "zalo",
            label: "Zalo",
            selectionLabel: "Zalo (Bot API)",
            quickstartAllowFrom: true,
          },
        },
      ] as never,
      statusByChannel: new Map([["zalo", { selectionHint: "configured" }]]),
      resolveDisabledHint: () => "disabled",
    });

    expect(contributions[0]?.option).toEqual({
      value: "zalo",
      label: "Zalo (Bot API)",
      hint: "configured · disabled",
    });
  });
});
