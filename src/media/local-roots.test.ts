import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { __testing, getChannelScopedMediaLocalRoots } from "./local-roots.js";

describe("local media roots", () => {
  it("materializes a single home-relative wildcard segment", () => {
    expect(
      __testing.materializeRootPatternForHome(
        "/Users/*/Library/Messages/Attachments",
        "/Users/alice",
      ),
    ).toBe("/Users/alice/Library/Messages/Attachments");
  });

  it("ignores wildcard patterns that do not match home prefix", () => {
    expect(
      __testing.materializeRootPatternForHome(
        "/Users/*/Library/Messages/Attachments",
        "/home/alice",
      ),
    ).toBeUndefined();
  });

  it("includes configured iMessage attachment roots for iMessage sessions", () => {
    const cfg = {
      channels: {
        imessage: {
          attachmentRoots: ["/tmp/imessage-attachments"],
        },
      },
    } as OpenClawConfig;
    expect(
      getChannelScopedMediaLocalRoots({
        cfg,
        channel: "imessage",
        accountId: "default",
      }),
    ).toContain("/tmp/imessage-attachments");
  });

  it("returns no channel-scoped roots for non-iMessage channels", () => {
    const cfg = {
      channels: {
        imessage: {
          attachmentRoots: ["/tmp/imessage-attachments"],
        },
      },
    } as OpenClawConfig;
    expect(
      getChannelScopedMediaLocalRoots({
        cfg,
        channel: "telegram",
        accountId: "default",
      }),
    ).toEqual([]);
  });
});
