import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  DEFAULT_IMESSAGE_ATTACHMENT_ROOTS,
  isInboundPathAllowed,
  isValidInboundPathRootPattern,
  mergeInboundPathRoots,
  resolveIMessageAttachmentRoots,
  resolveIMessageRemoteAttachmentRoots,
} from "./inbound-path-policy.js";

describe("inbound-path-policy", () => {
  it("validates absolute root patterns", () => {
    expect(isValidInboundPathRootPattern("/Users/*/Library/Messages/Attachments")).toBe(true);
    expect(isValidInboundPathRootPattern("/Volumes/relay/attachments")).toBe(true);
    expect(isValidInboundPathRootPattern("./attachments")).toBe(false);
    expect(isValidInboundPathRootPattern("/Users/**/Attachments")).toBe(false);
  });

  it("matches wildcard roots for iMessage attachment paths", () => {
    const roots = ["/Users/*/Library/Messages/Attachments"];
    expect(
      isInboundPathAllowed({
        filePath: "/Users/alice/Library/Messages/Attachments/12/34/ABCDEF/IMG_0001.jpeg",
        roots,
      }),
    ).toBe(true);
    expect(
      isInboundPathAllowed({
        filePath: "/etc/passwd",
        roots,
      }),
    ).toBe(false);
  });

  it("normalizes and de-duplicates merged roots", () => {
    const roots = mergeInboundPathRoots(
      ["/Users/*/Library/Messages/Attachments/", "/Users/*/Library/Messages/Attachments"],
      ["/Volumes/relay/attachments"],
    );
    expect(roots).toEqual(["/Users/*/Library/Messages/Attachments", "/Volumes/relay/attachments"]);
  });

  it("resolves configured roots with account overrides", () => {
    const cfg = {
      channels: {
        imessage: {
          attachmentRoots: ["/Users/*/Library/Messages/Attachments"],
          remoteAttachmentRoots: ["/Volumes/shared/imessage"],
          accounts: {
            work: {
              attachmentRoots: ["/Users/work/Library/Messages/Attachments"],
              remoteAttachmentRoots: ["/srv/work/attachments"],
            },
          },
        },
      },
    } as OpenClawConfig;
    expect(resolveIMessageAttachmentRoots({ cfg, accountId: "work" })).toEqual([
      "/Users/work/Library/Messages/Attachments",
      "/Users/*/Library/Messages/Attachments",
    ]);
    expect(resolveIMessageRemoteAttachmentRoots({ cfg, accountId: "work" })).toEqual([
      "/srv/work/attachments",
      "/Volumes/shared/imessage",
      "/Users/work/Library/Messages/Attachments",
      "/Users/*/Library/Messages/Attachments",
    ]);
  });

  it("falls back to default iMessage roots", () => {
    const cfg = {} as OpenClawConfig;
    expect(resolveIMessageAttachmentRoots({ cfg })).toEqual([...DEFAULT_IMESSAGE_ATTACHMENT_ROOTS]);
    expect(resolveIMessageRemoteAttachmentRoots({ cfg })).toEqual([
      ...DEFAULT_IMESSAGE_ATTACHMENT_ROOTS,
    ]);
  });
});
