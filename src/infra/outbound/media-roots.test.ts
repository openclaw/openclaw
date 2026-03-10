import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resolvePreferredOpenClawTmpDir } from "../tmp-openclaw-dir.js";
import { resolveDeliveryMediaLocalRoots } from "./media-roots.js";

describe("resolveDeliveryMediaLocalRoots", () => {
  it("keeps default outbound roots for non-imessage channels", () => {
    const roots = resolveDeliveryMediaLocalRoots({
      cfg: {},
      channel: "telegram",
      payloads: [{ mediaUrl: "/Users/test/Library/Messages/Attachments/a/b/file.heic" }],
    });

    expect(roots).toContain(resolvePreferredOpenClawTmpDir());
    expect(roots).not.toContain("/Users/test/Library/Messages/Attachments");
  });

  it("adds the concrete iMessage attachment root for local attachment paths", () => {
    const roots = resolveDeliveryMediaLocalRoots({
      cfg: {},
      channel: "imessage",
      payloads: [{ mediaUrl: "/Users/test/Library/Messages/Attachments/a/b/file.heic" }],
    });

    expect(roots).toContain(resolvePreferredOpenClawTmpDir());
    expect(roots).toContain("/Users/test/Library/Messages/Attachments");
  });

  it("supports file URLs for iMessage attachment paths", () => {
    const roots = resolveDeliveryMediaLocalRoots({
      cfg: {},
      channel: "imessage",
      payloads: [{ mediaUrl: "file:///Users/test/Library/Messages/Attachments/a/b/file.heic" }],
    });

    expect(roots).toContain("/Users/test/Library/Messages/Attachments");
  });

  it("deduplicates concrete roots derived from mediaUrls arrays", () => {
    const roots = resolveDeliveryMediaLocalRoots({
      cfg: {},
      channel: "imessage",
      payloads: [
        {
          mediaUrls: [
            "/Users/test/Library/Messages/Attachments/a/b/file-1.heic",
            "/Users/test/Library/Messages/Attachments/c/d/file-2.heic",
          ],
        },
      ],
    });

    expect(
      roots.filter((root) => root === "/Users/test/Library/Messages/Attachments"),
    ).toHaveLength(1);
  });

  it("respects custom account attachment roots", () => {
    const cfg: OpenClawConfig = {
      channels: {
        imessage: {
          accounts: {
            work: {
              attachmentRoots: ["/Volumes/Messages/*/Attachments"],
            },
          },
        },
      },
    };

    const roots = resolveDeliveryMediaLocalRoots({
      cfg,
      channel: "imessage",
      accountId: "work",
      payloads: [{ mediaUrl: "/Volumes/Messages/local/Attachments/a/b/file.heic" }],
    });

    expect(roots).toContain(path.resolve("/Volumes/Messages/local/Attachments"));
  });
});
