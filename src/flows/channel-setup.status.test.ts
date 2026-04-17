import { beforeEach, describe, expect, it, vi } from "vitest";

type MockChannelSetupEntry = {
  id: string;
  pluginId?: string;
  meta: {
    id: string;
    label: string;
    selectionLabel?: string;
    docsPath?: string;
    docsLabel?: string;
    blurb?: string;
    selectionDocsPrefix?: string;
    selectionExtras?: readonly string[];
    exposure?: { setup?: boolean };
    showInSetup?: boolean;
    quickstartAllowFrom?: boolean;
  };
};

type MockChannelSetupEntries = {
  entries: MockChannelSetupEntry[];
  installedCatalogEntries: MockChannelSetupEntry[];
  installableCatalogEntries: MockChannelSetupEntry[];
  installedCatalogById: Map<unknown, unknown>;
  installableCatalogById: Map<unknown, unknown>;
};

const listChatChannels = vi.hoisted(() =>
  vi.fn(() => [
    { id: "discord", label: "Discord" },
    { id: "bluebubbles", label: "BlueBubbles" },
  ]),
);
const resolveChannelSetupEntries = vi.hoisted(() =>
  vi.fn(
    (_params?: unknown): MockChannelSetupEntries => ({
      entries: [],
      installedCatalogEntries: [],
      installableCatalogEntries: [],
      installedCatalogById: new Map(),
      installableCatalogById: new Map(),
    }),
  ),
);
const formatChannelPrimerLine = vi.hoisted(() =>
  vi.fn((meta: unknown) => {
    const channel = meta as { label: string; blurb: string };
    return `${channel.label}: ${channel.blurb}`;
  }),
);
const formatChannelSelectionLine = vi.hoisted(() =>
  vi.fn((meta: unknown, _docsLink?: unknown) => {
    const channel = meta as { label: string; blurb: string };
    return `${channel.label} — ${channel.blurb}`;
  }),
);
const isChannelConfigured = vi.hoisted(() => vi.fn((_cfg?: unknown, _channelId?: string) => false));

vi.mock("../channels/chat-meta.js", () => ({
  listChatChannels: () => listChatChannels(),
}));

vi.mock("../channels/registry.js", () => ({
  formatChannelPrimerLine: (meta: unknown) => formatChannelPrimerLine(meta),
  formatChannelSelectionLine: (meta: unknown, docsLink: unknown) =>
    formatChannelSelectionLine(meta, docsLink),
}));

vi.mock("../commands/channel-setup/discovery.js", () => ({
  resolveChannelSetupEntries: (params: unknown) => resolveChannelSetupEntries(params),
  shouldShowChannelInSetup: (meta: { exposure?: { setup?: boolean }; showInSetup?: boolean }) =>
    meta.showInSetup !== false && meta.exposure?.setup !== false,
}));

vi.mock("../config/channel-configured.js", () => ({
  isChannelConfigured: (cfg: unknown, channelId: string) => isChannelConfigured(cfg, channelId),
}));

import {
  collectChannelStatus,
  noteChannelPrimer,
  resolveChannelSelectionNoteLines,
  resolveChannelSetupSelectionContributions,
} from "./channel-setup.status.js";

describe("resolveChannelSetupSelectionContributions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listChatChannels.mockReturnValue([
      { id: "discord", label: "Discord" },
      { id: "bluebubbles", label: "BlueBubbles" },
    ]);
    resolveChannelSetupEntries.mockReturnValue({
      entries: [],
      installedCatalogEntries: [],
      installableCatalogEntries: [],
      installedCatalogById: new Map(),
      installableCatalogById: new Map(),
    });
    formatChannelPrimerLine.mockImplementation((meta: unknown) => {
      const channel = meta as { label: string; blurb: string };
      return `${channel.label}: ${channel.blurb}`;
    });
    formatChannelSelectionLine.mockImplementation((meta: unknown) => {
      const channel = meta as { label: string; blurb: string };
      return `${channel.label} — ${channel.blurb}`;
    });
    isChannelConfigured.mockReturnValue(false);
  });

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

  it("sanitizes picker labels and hints before terminal rendering", () => {
    const contributions = resolveChannelSetupSelectionContributions({
      entries: [
        {
          id: "zalo",
          meta: {
            id: "zalo",
            label: "Zalo\u001B[31m\nBot\u0007",
          },
        },
      ] as never,
      statusByChannel: new Map([["zalo", { selectionHint: "configured\u001B[2K\nnow" }]]),
      resolveDisabledHint: () => "disabled\u0007",
    });

    expect(contributions[0]?.option).toEqual({
      value: "zalo",
      label: "Zalo\\nBot",
      hint: "configured\\nnow · disabled",
    });
  });

  it("sanitizes the picker fallback label when metadata sanitizes to empty", () => {
    const contributions = resolveChannelSetupSelectionContributions({
      entries: [
        {
          id: "bad\u001B[31m\nid",
          meta: {
            id: "bad\u001B[31m\nid",
            label: "\u001B[31m\u0007",
          },
        },
      ] as never,
      statusByChannel: new Map(),
      resolveDisabledHint: () => undefined,
    });

    expect(contributions[0]?.option).toEqual({
      value: "bad\u001B[31m\nid",
      label: "bad\\nid",
    });
  });

  it("sanitizes channel labels in status note lines", async () => {
    listChatChannels.mockReturnValue([{ id: "discord", label: "Discord\u001B[31m\nCore\u0007" }]);
    resolveChannelSetupEntries.mockReturnValue({
      entries: [],
      installedCatalogEntries: [
        {
          id: "matrix",
          pluginId: "matrix",
          meta: { id: "matrix", label: "Matrix\u001B[2K\nPlugin\u0007" },
        },
      ],
      installableCatalogEntries: [
        {
          id: "zalo",
          pluginId: "zalo",
          meta: { id: "zalo", label: "Zalo\u001B[2K\nPlugin\u0007" },
        },
      ],
      installedCatalogById: new Map(),
      installableCatalogById: new Map(),
    });

    const summary = await collectChannelStatus({
      cfg: {} as never,
      accountOverrides: {},
      installedPlugins: [],
    });

    expect(summary.statusLines).toEqual([
      "Discord\\nCore: not configured",
      "Matrix\\nPlugin: installed",
      "Zalo\\nPlugin: install plugin to enable",
    ]);
  });

  it("sanitizes channel metadata before primer notes", async () => {
    const note = vi.fn(async () => undefined);

    await noteChannelPrimer(
      { note } as never,
      [
        {
          id: "bad\u001B[31m\nid",
          label: "\u001B[31m\u0007",
          blurb: "Blurb\u001B[2K\nline\u0007",
        },
      ] as never,
    );

    expect(formatChannelPrimerLine).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "bad\\nid",
        label: "bad\\nid",
        selectionLabel: "bad\\nid",
        blurb: "Blurb\\nline",
      }),
    );
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("bad\\nid: Blurb\\nline"),
      "How channels work",
    );
  });

  it("sanitizes channel metadata before selection notes", () => {
    resolveChannelSetupEntries.mockReturnValue({
      entries: [
        {
          id: "zalo",
          meta: {
            id: "zalo",
            label: "Zalo\u001B[31m\nBot\u0007",
            selectionLabel: "Zalo",
            docsPath: "/channels/zalo",
            docsLabel: "Docs\u001B[2K\nLabel",
            blurb: "Setup\u001B[2K\nhelp\u0007",
            selectionDocsPrefix: "Docs\u001B[2K\nPrefix",
            selectionExtras: ["Extra\u001B[2K\nOne", "\u001B[31m\u0007"],
          },
        },
      ],
      installedCatalogEntries: [],
      installableCatalogEntries: [],
      installedCatalogById: new Map(),
      installableCatalogById: new Map(),
    });

    const lines = resolveChannelSelectionNoteLines({
      cfg: {} as never,
      installedPlugins: [],
      selection: ["zalo"],
    });

    expect(formatChannelSelectionLine).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "Zalo\\nBot",
        blurb: "Setup\\nhelp",
        docsLabel: "Docs\\nLabel",
        selectionDocsPrefix: "Docs\\nPrefix",
        selectionExtras: ["Extra\\nOne"],
      }),
      expect.any(Function),
    );
    expect(lines).toEqual(["Zalo\\nBot — Setup\\nhelp"]);
  });
});
