import { beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withEnv, withEnvAsync } from "../test-utils/env.js";
import {
  makeCatalogEntry,
  makeChannelSetupEntries,
  makeMeta,
} from "./channel-setup.test-helpers.js";

type ListChatChannels = typeof import("../channels/chat-meta.js").listChatChannels;
type ResolveChannelSetupEntries =
  typeof import("../commands/channel-setup/discovery.js").resolveChannelSetupEntries;
type FormatChannelPrimerLine = typeof import("../channels/registry.js").formatChannelPrimerLine;
type FormatChannelSelectionLine =
  typeof import("../channels/registry.js").formatChannelSelectionLine;
type IsChannelConfigured = typeof import("../config/channel-configured.js").isChannelConfigured;
type ChannelSetupPlugin = import("../channels/plugins/setup-wizard-types.js").ChannelSetupPlugin;

const listChatChannels = vi.hoisted(() => vi.fn<ListChatChannels>(() => []));
const resolveChannelSetupEntries = vi.hoisted(() => vi.fn<ResolveChannelSetupEntries>());
const formatChannelPrimerLine = vi.hoisted(() =>
  vi.fn<FormatChannelPrimerLine>((meta) => `${meta.label}: ${meta.blurb}`),
);
const formatChannelSelectionLine = vi.hoisted(() =>
  vi.fn<FormatChannelSelectionLine>((meta) => `${meta.label} — ${meta.blurb}`),
);
const isChannelConfigured = vi.hoisted(() => vi.fn<IsChannelConfigured>(() => false));

// mock-isolation: Status fixtures provide their own channel inventory.
vi.mock("../channels/chat-meta.js", () => ({ listChatChannels }));

// mock-isolation: Status formatting is driven by the synthetic channel registry.
vi.mock("../channels/registry.js", () => ({
  formatChannelPrimerLine,
  formatChannelSelectionLine,
  normalizeAnyChannelId: (channelId?: string) => channelId?.trim().toLowerCase() ?? null,
}));

// mock-isolation: Status proofs control discovered channels without real plugin discovery.
vi.mock("../commands/channel-setup/discovery.js", () => ({
  resolveChannelSetupEntries,
  shouldShowChannelInSetup: (meta: { exposure?: { setup?: boolean } }) =>
    meta.exposure?.setup !== false,
}));

// mock-isolation: Each status scenario explicitly chooses whether its channel is configured.
vi.mock("../config/channel-configured.js", () => ({ isChannelConfigured }));

// Keep installable-catalog fixtures independent of the bundled extensions tree.
vi.mock("../plugins/bundled-sources.js", () => ({
  resolveBundledPluginSources: () => new Map(),
  findBundledPluginSourceInMap: () => undefined,
}));

import {
  collectChannelStatus,
  noteChannelPrimer,
  resolveChannelSelectionNoteLines,
  resolveChannelSetupSelectionOptions,
} from "./channel-setup.status.js";

function statusPlugin(id: string, label: string): ChannelSetupPlugin {
  return {
    id,
    meta: makeMeta(id, label),
    capabilities: { chatTypes: [] },
    config: {} as ChannelSetupPlugin["config"],
  };
}

function statusSummary(overrides: Partial<Parameters<typeof collectChannelStatus>[0]> = {}) {
  return collectChannelStatus({
    cfg: {},
    accountOverrides: {},
    installedPlugins: [],
    resolveAdapter: () => undefined,
    ...overrides,
  });
}

function selectionNotes(
  overrides: Pick<Parameters<typeof resolveChannelSelectionNoteLines>[0], "selection"> &
    Partial<Parameters<typeof resolveChannelSelectionNoteLines>[0]>,
) {
  return resolveChannelSelectionNoteLines({ cfg: {}, installedPlugins: [], ...overrides });
}

function discoverSelection(id: string, label: string, overrides: Parameters<typeof makeMeta>[2]) {
  const entries = [{ id, meta: makeMeta(id, label, overrides) }];
  resolveChannelSetupEntries.mockReturnValue(makeChannelSetupEntries({ entries }));
}

beforeEach(() => {
  vi.clearAllMocks();
  listChatChannels.mockReturnValue([]);
  resolveChannelSetupEntries.mockReturnValue(makeChannelSetupEntries());
  isChannelConfigured.mockReturnValue(false);
});

it.each<{ label: string; cfg: OpenClawConfig; workspaceDir?: string; expected: string }>([
  {
    label: "caller-selected explicit fleet",
    cfg: { agents: { ownership: "explicit", entries: { alpha: {}, beta: {} } } },
    workspaceDir: "/tmp/beta-workspace",
    expected: "/tmp/beta-workspace",
  },
  {
    label: "configured system agent",
    cfg: {
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "main" } },
        entries: {
          main: { workspace: "/tmp/openclaw-main-workspace" },
          helper: { workspace: "/tmp/openclaw-helper-workspace" },
        },
      },
    },
    workspaceDir: undefined,
    expected: "/tmp/openclaw-main-workspace",
  },
])("uses $label workspace", async ({ cfg, workspaceDir, expected }) => {
  await statusSummary({ cfg, workspaceDir });
  selectionNotes({ cfg, workspaceDir, selection: [] });
  expect(resolveChannelSetupEntries).toHaveBeenCalledTimes(2);
  expect(resolveChannelSetupEntries.mock.calls.map(([request]) => request.workspaceDir)).toEqual([
    expected,
    expected,
  ]);
});

it("sorts channels alphabetically by picker label", () => {
  const options = resolveChannelSetupSelectionOptions({
    entries: (
      [
        ["zalo", "Zalo", "Zalo (Bot API)"],
        ["discord", "Discord", "Discord (Bot API)"],
        ["imessage", "iMessage", "iMessage (macOS app)"],
      ] as const
    ).map(([id, label, selectionLabel]) => ({
      id,
      meta: makeMeta(id, label, { selectionLabel }),
    })),
    statusByChannel: new Map(),
    resolveDisabledHint: () => undefined,
  });

  expect(options.map((option) => option.label)).toEqual([
    "Discord (Bot API)",
    "iMessage (macOS app)",
    "Zalo (Bot API)",
  ]);
});

it("sanitizes picker labels and hints before terminal rendering", () => {
  const options = resolveChannelSetupSelectionOptions({
    entries: [
      {
        id: "zalo",
        meta: {
          id: "zalo",
          label: "Zalo\u001B[31m\nBot\u0007",
        },
      },
    ],
    statusByChannel: new Map([["zalo", { selectionHint: "configured\u001B[2K\nnow" }]]),
    resolveDisabledHint: () => "disabled\u0007",
  });

  expect(options[0]).toEqual({
    value: "zalo",
    label: "Zalo\\nBot",
    hint: "configured\\nnow · disabled",
  });
});

it.each(["rejected status check", "adapter resolution"] as const)(
  "keeps healthy channels selectable after a %s failure",
  async (failurePoint) => {
    const installedPlugins = [
      statusPlugin("matrix", "Matrix"),
      statusPlugin("telegram", "Telegram"),
    ] satisfies ChannelSetupPlugin[];
    listChatChannels.mockReturnValue([
      makeMeta("matrix", "Matrix"),
      makeMeta("telegram", "Telegram"),
    ]);
    isChannelConfigured.mockImplementation((_, channelId) => channelId === "matrix");

    const healthy = {
      channel: "telegram",
      configured: true,
      statusLines: ["Telegram: configured"],
      selectionHint: "configured",
      quickstartScore: 5,
    };
    const expectedHealthy = structuredClone(healthy);
    const failure = new Error("lazy Matrix setup module unavailable");
    const summary = await statusSummary({
      installedPlugins,
      resolveAdapter: (channel) => {
        if (channel === "matrix" && failurePoint === "adapter resolution") {
          throw failure;
        }
        return {
          channel,
          getStatus:
            channel === "matrix"
              ? async () => {
                  throw failure;
                }
              : async () => healthy,
        } as never;
      },
    });

    expect(summary.statusByChannel.get("matrix")).toEqual({
      channel: "matrix",
      configured: true,
      statusLines: ["Matrix: status unavailable (lazy Matrix setup module unavailable)"],
      selectionHint: "status unavailable",
    });
    expect(summary.statusByChannel.get("telegram")).toEqual(expectedHealthy);
    expect(summary.statusLines).toEqual([
      "Matrix: status unavailable (lazy Matrix setup module unavailable)",
      "Telegram: configured",
    ]);
  },
);

it("redacts credentials and terminal controls in failed channel status checks", async () => {
  const token = "sk-abcdefghijklmnopqrstuv";
  const summary = await statusSummary({
    installedPlugins: [statusPlugin("matrix", "Matrix")],
    resolveAdapter: (channel) =>
      ({
        channel,
        getStatus: async () => {
          throw new Error(`\u001B[31mloader failed\nAuthorization: Bearer ${token}`);
        },
      }) as never,
  });

  const statusLine = summary.statusLines[0];
  expect(statusLine).toContain("Matrix: status unavailable (loader failed\\nAuthorization: Bearer");
  expect(statusLine).not.toContain(token);
  expect(statusLine).not.toContain("\u001B");
  expect(statusLine).not.toContain("\n");
});

it.each([
  {
    locale: "en",
    sanitize: true,
    expected: [
      "Discord\\nCore: not configured",
      "Matrix\\nPlugin: installed",
      "Zalo\\nPlugin: install plugin to enable",
    ],
  },
  {
    locale: "zh-CN",
    sanitize: false,
    expected: [
      "Discord: 已配置（插件已禁用）",
      "Telegram: 未配置",
      "Matrix: 已安装",
      "Zalo: 安装插件后启用",
    ],
  },
] as const)(
  "renders sanitized/localized $locale status notes",
  async ({ locale, sanitize, expected }) => {
    const label = (name: string, suffix: string, ansi = "2K") =>
      sanitize ? `${name}\u001B[${ansi}\n${suffix}\u0007` : name;
    listChatChannels.mockReturnValue([
      makeMeta("discord", label("Discord", "Core", "31m")),
      ...(locale === "zh-CN" ? [makeMeta("telegram", "Telegram")] : []),
    ]);
    isChannelConfigured.mockImplementation((_, id) => locale === "zh-CN" && id === "discord");
    resolveChannelSetupEntries.mockReturnValue(
      makeChannelSetupEntries({
        installedCatalogEntries: [makeCatalogEntry("matrix", label("Matrix", "Plugin"))],
        installableCatalogEntries: [makeCatalogEntry("zalo", label("Zalo", "Plugin"))],
      }),
    );
    await withEnvAsync({ OPENCLAW_LOCALE: locale }, async () => {
      expect((await statusSummary()).statusLines).toEqual(expected);
    });
  },
);

it("sanitizes channel metadata before primer notes", async () => {
  const note = vi.fn(async () => undefined);

  await noteChannelPrimer({ note } as never, [
    {
      id: "bad\u001B[31m\nid",
      label: "\u001B[31m\u0007",
      blurb: "Blurb\u001B[2K\nline\u0007",
    },
  ]);

  expect(formatChannelPrimerLine).toHaveBeenCalledOnce();
  const primerMeta = formatChannelPrimerLine.mock.calls[0]?.[0];
  expect(primerMeta).toMatchObject({
    id: "bad\\nid",
    label: "bad\\nid",
    selectionLabel: "bad\\nid",
    blurb: "Blurb\\nline",
  });
  expect(note).toHaveBeenCalledWith(
    [
      "Inbound DM safety defaults to pairing: unknown senders get a pairing code first.",
      "Approve with: openclaw pairing approve <channel> <code>",
      'Open/public DMs require dmPolicy="open" plus allowFrom=["*"].',
      'For multi-user DMs, isolate sessions with: openclaw config set session.dmScope "per-channel-peer" (or "per-account-channel-peer" for multi-account channels).',
      "Docs: https://docs.openclaw.ai/channels/pairing",
      "",
      "bad\\nid: Blurb\\nline",
    ].join("\n"),
    "How channels work",
  );
});

it("sanitizes channel metadata before selection notes", () => {
  discoverSelection("zalo", "Zalo\u001B[31m\nBot\u0007", {
    selectionLabel: "Zalo",
    docsLabel: "Docs\u001B[2K\nLabel",
    blurb: "Setup\u001B[2K\nhelp\u0007",
    selectionDocsPrefix: "Docs\u001B[2K\nPrefix",
    selectionExtras: ["Extra\u001B[2K\nOne", "\u001B[31m\u0007"],
  });

  const lines = selectionNotes({ selection: ["zalo"] });

  expect(formatChannelSelectionLine).toHaveBeenCalledOnce();
  const [selectionMeta, docsLink] = formatChannelSelectionLine.mock.calls[0] ?? [];
  expect(selectionMeta).toMatchObject({
    label: "Zalo\\nBot",
    blurb: "Setup\\nhelp",
    docsLabel: "Docs\\nLabel",
    selectionDocsPrefix: "Docs\\nPrefix",
    selectionExtras: ["Extra\\nOne"],
  });
  expect(docsLink?.("/channels/zalo", "Docs")).toBe("https://docs.openclaw.ai/channels/zalo");
  expect(lines).toEqual(["Zalo\\nBot — Setup\\nhelp"]);
});

it("preserves an explicitly empty selection docs prefix", () => {
  discoverSelection("custom-chat", "Custom Chat", {
    blurb: "External channel.",
    selectionDocsPrefix: "",
  });

  selectionNotes({ selection: ["custom-chat"] });

  expect(formatChannelSelectionLine.mock.calls[0]?.[0].selectionDocsPrefix).toBe("");
});

it("localizes built-in channel blurbs before selection notes", () => {
  discoverSelection("feishu", "Feishu", {
    docsLabel: "feishu",
    blurb: "飞书/Lark enterprise messaging.",
  });

  withEnv({ OPENCLAW_LOCALE: "zh-CN" }, () => {
    const lines = selectionNotes({ selection: ["feishu"] });

    expect(formatChannelSelectionLine).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "Feishu",
        blurb: "飞书/Lark 企业消息。",
        selectionDocsPrefix: "文档：",
      }),
      expect.any(Function),
    );
    expect(lines).toEqual(["Feishu — 飞书/Lark 企业消息。"]);
  });
});
