// Verifies canonical group scope precedence and sender policy resolution.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "./config.js";
import {
  resolveChannelGroupRequireMention,
  resolveChannelGroupToolsPolicy,
  resolveToolsBySender,
} from "./group-policy.js";
import {
  resolveScopeKeyCaseInsensitive,
  resolveScopeIntroHint,
  resolveScopeRequireMention,
  resolveScopeToolsPolicy,
  type ScopeTree,
} from "./group-scope-tree.js";

describe("resolveScopeKeyCaseInsensitive", () => {
  it("preserves exact scope identity before case-insensitive fallback", () => {
    const tree: ScopeTree = {
      scopes: {
        "Room:Mixed": { requireMention: true },
        "room:mixed": { requireMention: false },
      },
    };

    expect(resolveScopeKeyCaseInsensitive(tree, "Room:Mixed")).toBe("Room:Mixed");
    expect(resolveScopeKeyCaseInsensitive(tree, "ROOM:MIXED")).toBe("Room:Mixed");
    expect(resolveScopeKeyCaseInsensitive(tree, " room:mixed ")).toBe("Room:Mixed");
    expect(resolveScopeKeyCaseInsensitive(tree, "unknown")).toBeUndefined();
    expect(resolveScopeKeyCaseInsensitive(tree, undefined)).toBeUndefined();
    expect(resolveScopeKeyCaseInsensitive(tree, null)).toBeUndefined();
  });
});

describe("resolveScopeRequireMention", () => {
  it.each([
    {
      name: "before-config override",
      expected: true,
      configured: false,
      override: true,
      overrideOrder: "before-config" as const,
    },
    {
      name: "after-config fallback override",
      expected: false,
      configured: undefined,
      override: false,
      overrideOrder: "after-config" as const,
    },
  ])(
    "matches flat group-policy behavior: $name",
    ({ configured, override, overrideOrder, expected }) => {
      const node = typeof configured === "boolean" ? { requireMention: configured } : {};
      const tree: ScopeTree = { scopes: { room: node } };
      const cfg = {
        channels: { whatsapp: { groups: { room: node } } },
      } as OpenClawConfig;

      expect(
        resolveScopeRequireMention({
          tree,
          path: ["room"],
          requireMentionOverride: override,
          overrideOrder,
        }),
      ).toBe(expected);
      expect(
        resolveChannelGroupRequireMention({
          cfg,
          channel: "whatsapp",
          groupId: "room",
          requireMentionOverride: override,
          overrideOrder,
        }),
      ).toBe(expected);
    },
  );
});

describe("resolveScopeToolsPolicy", () => {
  it.each([
    {
      name: "username",
      sender: { senderUsername: "@Alice" },
      expected: { allow: ["username"] },
    },
  ])("matches resolveToolsBySender for typed $name keys", ({ sender, expected }) => {
    const toolsBySender = {
      "id:user:alice": { allow: ["id"] },
      "username:alice": { allow: ["username"] },
      "channel:discord:user:alice": { allow: ["channel"] },
      "*": { deny: ["fallback"] },
    };
    const tree: ScopeTree = { scopes: { room: { toolsBySender } } };

    const directPolicy = resolveToolsBySender({ toolsBySender, ...sender });
    expect(resolveScopeToolsPolicy({ tree, path: ["room"], ...sender })).toEqual(directPolicy);
    expect(directPolicy).toEqual(expected);
  });

  it("keeps a narrower plain policy ahead of a broader sender match", () => {
    const tree: ScopeTree = {
      scopes: {
        team: { toolsBySender: { "id:alice": { allow: ["team-sender"] } } },
        channel: { tools: { deny: ["channel"] } },
      },
    };

    expect(
      resolveScopeToolsPolicy({
        tree,
        path: ["team", "channel"],
        senderId: "alice",
      }),
    ).toEqual({ deny: ["channel"] });
  });

  it("skips sender overlays while preserving the base scope policy", () => {
    const tree: ScopeTree = {
      scopes: {
        room: {
          tools: { allow: ["write"] },
          toolsBySender: { "*": { deny: ["write"] } },
        },
      },
    };

    expect(resolveScopeToolsPolicy({ tree, path: ["room"] })).toEqual({ deny: ["write"] });
    expect(resolveScopeToolsPolicy({ tree, path: ["room"], senderPolicyMode: "never" })).toEqual({
      allow: ["write"],
    });
  });
});

describe("resolveScopeIntroHint", () => {
  it("uses the first defined hint from narrowest scope through defaults", () => {
    const tree: ScopeTree = {
      defaults: { introHint: "default" },
      scopes: {
        team: { introHint: "team" },
        channel: {},
        thread: { introHint: "thread" },
      },
    };

    expect(resolveScopeIntroHint({ tree, path: ["team", "channel", "thread"] })).toBe("thread");
    expect(resolveScopeIntroHint({ tree, path: ["missing"] })).toBe("default");
  });
});

describe("flat group policy adapters", () => {
  it.each([
    { groupId: " ROOM ", expected: false },
    { groupId: "missing", expected: true },
  ])("preserves configured-group identity for $groupId", ({ groupId, expected }) => {
    const cfg = {
      channels: { signal: { groups: { "*": {}, Room: {} } } },
    } satisfies OpenClawConfig;
    expect(
      resolveChannelGroupRequireMention({
        cfg,
        channel: "signal",
        groupId,
        groupIdCaseInsensitive: true,
        configuredGroupDefaultsToNoMention: true,
      }),
    ).toBe(expected);
  });

  it.each([{ groupId: " ROOM ", expected: "fallback" }])(
    "selects one group before resolving tools for $groupId",
    ({ groupId, expected }) => {
      const cfg = {
        channels: {
          signal: {
            groups: {
              room: {},
              later: { tools: { allow: ["later"] } },
              "*": { tools: { allow: ["fallback"] } },
            },
          },
        },
      } satisfies OpenClawConfig;
      expect(
        resolveChannelGroupToolsPolicy({
          cfg,
          channel: "signal",
          groupId,
          groupIdCandidates: ["later"],
          groupIdCaseInsensitive: true,
        }),
      ).toEqual({ allow: [expected] });
    },
  );

  it.each([{ messageProvider: "", expected: "id" }])(
    "preserves provider defaulting for $messageProvider",
    ({ messageProvider, expected }) => {
      const cfg = {
        channels: {
          signal: {
            groups: {
              room: {
                toolsBySender: {
                  "channel:signal:alice": { allow: ["channel"] },
                  "id:alice": { allow: ["id"] },
                },
              },
            },
          },
        },
      } satisfies OpenClawConfig;
      expect(
        resolveChannelGroupToolsPolicy({
          cfg,
          channel: "signal",
          groupId: "room",
          senderId: "alice",
          messageProvider,
        }),
      ).toEqual({ allow: [expected] });
    },
  );
});
