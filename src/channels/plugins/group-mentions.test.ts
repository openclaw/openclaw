import { describe, expect, it } from "vitest";
import {
  resolveBlueBubblesGroupRequireMention,
  resolveBlueBubblesGroupToolPolicy,
  resolveLineGroupRequireMention,
  resolveLineGroupToolPolicy,
} from "./group-mentions.js";

describe("group mentions (bluebubbles)", () => {
  it("uses generic channel group policy helpers", () => {
    const blueBubblesCfg = {
      channels: {
        bluebubbles: {
          groups: {
            "chat:primary": {
              requireMention: false,
              tools: { deny: ["exec"] },
            },
            "*": {
              requireMention: true,
              tools: { allow: ["message.send"] },
            },
          },
        },
      },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;

    expect(
      resolveBlueBubblesGroupRequireMention({ cfg: blueBubblesCfg, groupId: "chat:primary" }),
    ).toBe(false);
    expect(
      resolveBlueBubblesGroupRequireMention({ cfg: blueBubblesCfg, groupId: "chat:other" }),
    ).toBe(true);
    expect(
      resolveBlueBubblesGroupToolPolicy({ cfg: blueBubblesCfg, groupId: "chat:primary" }),
    ).toEqual({ deny: ["exec"] });
    expect(
      resolveBlueBubblesGroupToolPolicy({ cfg: blueBubblesCfg, groupId: "chat:other" }),
    ).toEqual({
      allow: ["message.send"],
    });
  });
});

describe("group mentions (line)", () => {
  it("matches raw and prefixed LINE group keys for requireMention and tools", () => {
    const lineCfg = {
      channels: {
        line: {
          groups: {
            "room:r123": {
              requireMention: false,
              tools: { allow: ["message.send"] },
            },
            "group:g123": {
              requireMention: false,
              tools: { deny: ["exec"] },
            },
            "*": {
              requireMention: true,
            },
          },
        },
      },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;

    expect(resolveLineGroupRequireMention({ cfg: lineCfg, groupId: "r123" })).toBe(false);
    expect(resolveLineGroupRequireMention({ cfg: lineCfg, groupId: "room:r123" })).toBe(false);
    expect(resolveLineGroupRequireMention({ cfg: lineCfg, groupId: "g123" })).toBe(false);
    expect(resolveLineGroupRequireMention({ cfg: lineCfg, groupId: "group:g123" })).toBe(false);
    expect(resolveLineGroupRequireMention({ cfg: lineCfg, groupId: "other" })).toBe(true);
    expect(resolveLineGroupToolPolicy({ cfg: lineCfg, groupId: "r123" })).toEqual({
      allow: ["message.send"],
    });
    expect(resolveLineGroupToolPolicy({ cfg: lineCfg, groupId: "g123" })).toEqual({
      deny: ["exec"],
    });
  });

  it("uses account-scoped prefixed LINE group config for requireMention", () => {
    const lineCfg = {
      channels: {
        line: {
          groups: {
            "*": {
              requireMention: true,
            },
          },
          accounts: {
            work: {
              groups: {
                "group:g123": {
                  requireMention: false,
                },
              },
            },
          },
        },
      },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;

    expect(
      resolveLineGroupRequireMention({ cfg: lineCfg, groupId: "g123", accountId: "work" }),
    ).toBe(false);
  });
});
