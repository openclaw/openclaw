import { describe, expect, it } from "vitest";
import type { ChannelConfigEdit } from "../../lib/channels/index.ts";
import {
  applyChannelConfigEdits,
  buildChannelConfigPatch,
  channelConfigEditBase,
  dropConflictingChannelConfigEdits,
  findChannelConfigConflicts,
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

describe("channel config draft against a file that changed elsewhere", () => {
  const groupsSchema = {
    type: "object",
    properties: {
      channels: {
        type: "object",
        properties: {
          telegram: {
            type: "object",
            properties: {
              dmPolicy: { type: "string" },
              textChunkLimit: { type: "number" },
              allowFrom: { type: "array", items: { type: "string" } },
              groups: {
                type: "object",
                additionalProperties: {
                  type: "object",
                  properties: { requireMention: { type: "boolean" } },
                },
              },
            },
          },
        },
      },
    },
  };
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

  it("would have dropped the other client's values, which is why Save now stops", () => {
    // The patch the PR head sent: whole lists, missing keys as deletions.
    expect(
      buildChannelConfigPatch({
        base: elsewhere.channels.telegram,
        channelId: "telegram",
        edits: draft,
        schema: groupsSchema,
      }),
    ).toEqual({
      patch: {
        channels: {
          telegram: {
            allowFrom: ["111"],
            dmPolicy: "pairing",
            groups: { "-1002": { requireMention: true }, "-1003": null },
          },
        },
      },
      replacePaths: ["channels.telegram.allowFrom"],
    });
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

  it("saves an edit next to a change it doesn't touch, keeping that change", () => {
    const edits: ChannelConfigEdit[] = [
      { path: path("dmPolicy"), value: "pairing" },
      { path: path("groups", "-1001", "requireMention"), value: false },
    ];
    const meanwhile = saved({
      allowFrom: ["111", "222", "333"],
      dmPolicy: "allowlist",
      textChunkLimit: 2000,
      groups: { "-1001": { requireMention: true }, "-1003": { requireMention: true } },
    });
    const editBases = edits.map((edit) => channelConfigEditBase(before, edit.path));
    expect(findChannelConfigConflicts(editBases, meanwhile)).toEqual([]);
    expect(
      buildChannelConfigPatch({
        base: meanwhile.channels.telegram,
        channelId: "telegram",
        edits,
        schema: groupsSchema,
      }),
    ).toEqual({
      patch: {
        channels: {
          telegram: { dmPolicy: "pairing", groups: { "-1001": { requireMention: false } } },
        },
      },
      replacePaths: [],
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
