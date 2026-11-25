import { describe, expect, it, vi } from "vitest";
import type { ChannelConfigBase, ChannelConfigEdit } from "../../lib/channels/index.ts";
import {
  applyChannelConfigEdits,
  buildChannelConfigPatch,
  dropConflictingChannelConfigEdits,
  editChannelField,
  findChannelConfigConflicts,
  keptChannelEdits,
  rebaseChannelConfigEdits,
} from "./channel-config-draft.ts";

const schema = {
  type: "object",
  properties: {
    channels: {
      type: "object",
      properties: {
        telegram: {
          type: "object",
          properties: {
            botToken: { type: "string" },
            timeoutSeconds: { type: "number" },
            allowFrom: { type: "array", items: { type: "string" } },
            proxy: { type: "object", properties: { url: { type: "string" } } },
          },
        },
      },
    },
  },
};

const path = (...rest: Array<string | number>) => ["channels", "telegram", ...rest];

describe("channel config draft", () => {
  it("shows edits over the saved values without changing them", () => {
    const base = { botToken: "__OPENCLAW_REDACTED__", allowFrom: ["a"] };
    const value = applyChannelConfigEdits(base, "telegram", [
      { path: path("botToken"), value: "123:partial" },
      { path: path("allowFrom", 1), value: "b" },
    ]);
    expect(value).toEqual({ botToken: "123:partial", allowFrom: ["a", "b"] });
    expect(base).toEqual({ botToken: "__OPENCLAW_REDACTED__", allowFrom: ["a"] });
  });

  it("sends only what changed, leaving untouched secrets off the wire", () => {
    const built = buildChannelConfigPatch({
      base: { botToken: "__OPENCLAW_REDACTED__", dmPolicy: "pairing" },
      channelId: "telegram",
      edits: [{ path: path("dmPolicy"), value: "open" }],
      schema,
    });
    expect(built).toEqual({
      patch: { channels: { telegram: { dmPolicy: "open" } } },
      replacePaths: [],
    });
  });

  it("coerces form strings by schema, as a full save would", () => {
    const built = buildChannelConfigPatch({
      base: {},
      channelId: "telegram",
      edits: [{ path: path("timeoutSeconds"), value: "30" }],
      schema,
    });
    expect(built?.patch).toEqual({ channels: { telegram: { timeoutSeconds: 30 } } });
  });

  it("deletes a cleared field and confirms replaced arrays", () => {
    const built = buildChannelConfigPatch({
      base: { botToken: "__OPENCLAW_REDACTED__", allowFrom: ["a", "b"], proxy: { url: "x" } },
      channelId: "telegram",
      edits: [
        { path: path("botToken"), value: undefined },
        { path: path("allowFrom"), value: ["a"] },
      ],
      schema,
    });
    expect(built).toEqual({
      patch: { channels: { telegram: { botToken: null, allowFrom: ["a"] } } },
      replacePaths: ["channels.telegram.allowFrom"],
    });
  });

  it("has nothing to send when the edits land back on the saved value", () => {
    expect(
      buildChannelConfigPatch({
        base: { dmPolicy: "pairing" },
        channelId: "telegram",
        edits: [
          { path: path("dmPolicy"), value: "open" },
          { path: path("dmPolicy"), value: "pairing" },
        ],
        schema,
      }),
    ).toBeNull();
  });
});

describe("channel edits over stored secrets", () => {
  const base = { botToken: "__OPENCLAW_REDACTED__", proxy: "http://x" };
  const root = { channels: { telegram: base } };
  const tokenPath = ["channels", "telegram", "botToken"];

  it.each(["", undefined])("keeps a stored secret when its field is emptied to %s", (value) => {
    expect(keptChannelEdits({}, "telegram", root, [{ path: tokenPath, value }])).toEqual([]);
  });

  it("leaves other fields and fields without a stored value as edits", () => {
    const edit = { path: ["channels", "telegram", "proxy"], value: "" };
    expect(keptChannelEdits({}, "telegram", root, [edit])).toEqual([edit]);
    const empty = { path: tokenPath, value: "" };
    expect(keptChannelEdits({}, "telegram", null, [empty])).toEqual([empty]);
  });
});

describe("channel edits over references", () => {
  const REDACTED = "__OPENCLAW_REDACTED__";
  const token = ["channels", "telegram", "botToken"];
  const secretRefId = ["channels", "telegram", "webhookSecret", "id"];
  const config = {
    channels: {
      telegram: {
        botToken: REDACTED,
        proxy: "http://x",
        webhookSecret: { source: "env", provider: "default", id: REDACTED },
      },
    },
  };
  const snapshot = (parsedToken: unknown, raw: string | null = "{}") => ({
    valid: true,
    raw,
    config,
    sourceConfig: config,
    parsed: {
      channels: { telegram: { ...config.channels.telegram, botToken: parsedToken } },
    },
  });

  it("allows plain-text edits but preserves references", () => {
    const edits = [
      { path: token, value: "new" },
      { path: ["channels", "telegram", "proxy"], value: "new-proxy" },
    ];
    expect(
      keptChannelEdits({ configSnapshot: snapshot(REDACTED) }, "telegram", config, edits),
    ).toEqual(edits);
    for (const [saved, editPath] of [
      [snapshot("${TELEGRAM_TOKEN}"), token],
      // A template is redacted like plaintext; the Gateway withholds the file's text.
      [snapshot(REDACTED, null), token],
      [snapshot({ $include: "./token.json5" }), token],
      [snapshot(REDACTED), secretRefId],
    ] as const) {
      expect(
        keptChannelEdits({ configSnapshot: saved }, "telegram", config, [
          { path: editPath, value: "new" },
        ]),
      ).toEqual([]);
    }
    const edit = { path: token, value: "new" };
    expect(keptChannelEdits({ configSnapshot: null }, "telegram", null, [edit])).toEqual([edit]);
  });
});

describe("channel edits of whole lists containing secrets", () => {
  const REDACTED = "__OPENCLAW_REDACTED__";
  const listPath = ["channels", "telegram", "accounts"];
  const base = {
    accounts: [
      { name: "a", token: REDACTED },
      { name: "b", token: REDACTED },
    ],
  };
  const root = { channels: { telegram: base } };
  const snapshot = (raw: string | null) => ({
    valid: true,
    raw,
    config: root,
    sourceConfig: root,
    parsed: root,
  });
  const state = { configSnapshot: snapshot("{}") };
  it("keeps a secret emptied inside a list row the form sends whole", () => {
    // Typing over row b's token and clearing it sends the list without that token.
    const emptied = [{ name: "a", token: REDACTED }, { name: "b" }];
    const unguarded = buildChannelConfigPatch({
      base,
      channelId: "telegram",
      edits: [{ path: listPath, value: emptied }],
      schema: null,
    });
    expect(unguarded?.patch).toEqual({ channels: { telegram: { accounts: emptied } } });

    const edit = { path: listPath, value: emptied };
    expect(keptChannelEdits(state, "telegram", root, [edit])).toEqual([]);
    const renamed = [
      { name: "a", token: REDACTED },
      { name: "B", token: "" },
    ];
    const preserved = [
      { name: "a", token: REDACTED },
      { name: "B", token: REDACTED },
    ];
    expect(keptChannelEdits(state, "telegram", root, [{ path: listPath, value: renamed }])).toEqual(
      [{ path: listPath, value: preserved }],
    );
    // Removing a row still removes it.
    const removed = { path: listPath, value: [{ name: "a", token: REDACTED }] };
    expect(keptChannelEdits(state, "telegram", root, [removed])).toEqual([removed]);
  });

  it("replaces plain text in a row, and never a reference", () => {
    const typed = [
      { name: "a", token: REDACTED },
      { name: "b", token: "new" },
    ];
    const edit = { path: listPath, value: typed };
    expect(keptChannelEdits(state, "telegram", root, [edit])).toEqual([edit]);
    // A template is redacted like plaintext; the Gateway then withholds the file's text.
    expect(keptChannelEdits({ configSnapshot: snapshot(null) }, "telegram", root, [edit])).toEqual(
      [],
    );
  });
});

describe("channel config draft against a file that changed elsewhere", () => {
  const saved = (telegram: Record<string, unknown>) => ({ channels: { telegram } });
  // What the draft was made against.
  const before = saved({
    allowFrom: ["111", "222"],
    dmPolicy: "allowlist",
    groups: { "-1001": { requireMention: true } },
  });
  // Another client, while the draft waited: adds "333", disables DMs, adds group -1003.
  const elsewhere = saved({
    allowFrom: ["111", "222", "333"],
    dmPolicy: "disabled",
    groups: { "-1001": { requireMention: true }, "-1003": { requireMention: true } },
  });
  // The draft: removes "222", sets pairing, adds group -1002.
  const draft: ChannelConfigEdit[] = [
    { path: path("allowFrom"), value: ["111"] },
    { path: path("dmPolicy"), value: "pairing" },
    {
      path: path("groups"),
      value: { "-1001": { requireMention: true }, "-1002": { requireMention: true } },
    },
  ];
  const bases: ChannelConfigBase[] = [
    { path: path("allowFrom"), value: ["111", "222"] },
    { path: path("dmPolicy"), value: "allowlist" },
    { path: path("groups"), value: { "-1001": { requireMention: true } } },
  ];

  it("identifies only edited fields changed elsewhere before Save", () => {
    expect(findChannelConfigConflicts(bases, elsewhere)).toEqual([
      path("allowFrom"),
      path("dmPolicy"),
      path("groups"),
    ]);
    expect(findChannelConfigConflicts(bases, before)).toEqual([]);
  });

  it("guards a whole list when an edit lands inside it", () => {
    const editConfig = vi.fn();
    for (const target of [
      path("allowFrom", 1),
      path("groups", "-1001", "requireMention"),
      path("proxy", "url"),
    ]) {
      editChannelField(
        { editConfig, restoreConfigField: vi.fn() },
        { configForm: before, configSnapshot: { sourceConfig: before } },
        "telegram",
        { path: target, value: "changed" },
      );
    }
    expect(editConfig.mock.calls.map((call) => call[2])).toEqual([
      { path: path("allowFrom"), value: ["111", "222"] },
      { path: path("groups", "-1001", "requireMention"), value: true },
      { path: path("proxy", "url"), value: undefined },
    ]);
  });

  it("keeps the edits on Overwrite and drops them on Reload", () => {
    const rebased = rebaseChannelConfigEdits(bases, elsewhere);
    expect(findChannelConfigConflicts(rebased, elsewhere)).toEqual([]);

    const extra: ChannelConfigEdit = { path: path("textChunkLimit"), value: 1000 };
    const kept = dropConflictingChannelConfigEdits(
      [...draft, extra],
      [...bases, { path: extra.path, value: undefined }],
      findChannelConfigConflicts(bases, elsewhere),
    );
    expect(kept).toEqual({
      edits: [extra],
      bases: [{ path: path("textChunkLimit"), value: undefined }],
    });
  });
});
