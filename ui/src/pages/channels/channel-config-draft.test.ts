import { describe, expect, it } from "vitest";
import type { ChannelConfigEdit } from "../../lib/channels/index.ts";
import {
  applyChannelConfigEdits,
  buildChannelConfigPatch,
  channelConfigEditBase,
  dropConflictingChannelConfigEdits,
  emptiesStoredSecret,
  findChannelConfigConflicts,
  keepStoredSecrets,
  rebaseChannelConfigEdits,
  writesOverReference,
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

describe("emptiesStoredSecret", () => {
  const base = { botToken: "__OPENCLAW_REDACTED__", proxy: "http://x" };
  const tokenPath = ["channels", "telegram", "botToken"];

  it("keeps a stored secret when its field is emptied", () => {
    expect(emptiesStoredSecret(base, "telegram", tokenPath, "")).toBe(true);
    expect(emptiesStoredSecret(base, "telegram", tokenPath, undefined)).toBe(true);
  });

  it("leaves typed values and other fields as edits", () => {
    expect(emptiesStoredSecret(base, "telegram", tokenPath, "new")).toBe(false);
    expect(emptiesStoredSecret(base, "telegram", ["channels", "telegram", "proxy"], "")).toBe(
      false,
    );
    expect(emptiesStoredSecret(null, "telegram", tokenPath, "")).toBe(false);
  });
});

describe("writesOverReference", () => {
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

  it("lets an edit replace plain text in the file", () => {
    expect(writesOverReference(snapshot(REDACTED), token)).toBe(false);
    expect(writesOverReference(snapshot(REDACTED), ["channels", "telegram", "proxy"])).toBe(false);
  });

  it("never lets an edit replace a reference", () => {
    expect(writesOverReference(snapshot("${TELEGRAM_TOKEN}"), token)).toBe(true);
    // A template is redacted like plaintext; the Gateway then withholds the file's text.
    expect(writesOverReference(snapshot(REDACTED, null), token)).toBe(true);
    expect(writesOverReference(snapshot({ $include: "./token.json5" }), token)).toBe(true);
    expect(writesOverReference(snapshot(REDACTED), secretRefId)).toBe(true);
    expect(writesOverReference(null, token)).toBe(false);
  });
});

describe("keepStoredSecrets", () => {
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
  const keep = (value: unknown, raw: string | null = "{}") =>
    keepStoredSecrets({
      base,
      snapshot: snapshot(raw),
      channelId: "telegram",
      path: listPath,
      value,
    });

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

    expect(keep(emptied)).toBeUndefined();
    expect(
      keep([
        { name: "a", token: REDACTED },
        { name: "B", token: "" },
      ]),
    ).toEqual({
      value: [
        { name: "a", token: REDACTED },
        { name: "B", token: REDACTED },
      ],
    });
    // Removing a row still removes it.
    expect(keep([{ name: "a", token: REDACTED }])).toEqual({
      value: [{ name: "a", token: REDACTED }],
    });
  });

  it("replaces plain text in a row, and never a reference", () => {
    const typed = [
      { name: "a", token: REDACTED },
      { name: "b", token: "new" },
    ];
    expect(keep(typed)).toEqual({ value: typed });
    // A template is redacted like plaintext; the Gateway then withholds the file's text.
    expect(keep(typed, null)).toBeUndefined();
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
  const bases = draft.map((edit) => channelConfigEditBase(before, edit.path));

  it("identifies edited fields changed elsewhere before Save", () => {
    expect(findChannelConfigConflicts(bases, elsewhere)).toEqual([
      path("allowFrom"),
      path("dmPolicy"),
      path("groups"),
    ]);
  });

  it("finds nothing when the file is still what the edits were made against", () => {
    expect(findChannelConfigConflicts(bases, before)).toEqual([]);
  });

  it("guards a whole list when an edit lands inside it", () => {
    expect(channelConfigEditBase(before, path("allowFrom", 1))).toEqual({
      path: path("allowFrom"),
      value: ["111", "222"],
    });
    expect(channelConfigEditBase(before, path("groups", "-1001", "requireMention"))).toEqual({
      path: path("groups", "-1001", "requireMention"),
      value: true,
    });
    expect(channelConfigEditBase(before, path("proxy", "url"))).toEqual({
      path: path("proxy", "url"),
      value: undefined,
    });
  });

  it("keeps the edits on Overwrite and drops them on Reload", () => {
    const rebased = rebaseChannelConfigEdits(bases, elsewhere);
    expect(findChannelConfigConflicts(rebased, elsewhere)).toEqual([]);

    const extra: ChannelConfigEdit = { path: path("textChunkLimit"), value: 1000 };
    const kept = dropConflictingChannelConfigEdits(
      [...draft, extra],
      [...bases, channelConfigEditBase(before, extra.path)],
      findChannelConfigConflicts(bases, elsewhere),
    );
    expect(kept).toEqual({
      edits: [extra],
      bases: [{ path: path("textChunkLimit"), value: undefined }],
    });
  });
});
