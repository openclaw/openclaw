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
  function expectInboundRootPatternCase(pattern: string, expected: boolean) {
    expect(isValidInboundPathRootPattern(pattern)).toBe(expected);
  }

  function expectInboundPathAllowedCase(filePath: string, expected: boolean) {
    expect(
      isInboundPathAllowed({ filePath, roots: ["/Users/*/Library/Messages/Attachments"] }),
    ).toBe(expected);
  }

  function expectResolvedIMessageRootsCase(resolve: () => string[], expected: readonly string[]) {
    expect(resolve()).toEqual(expected);
  }

  function expectMergedInboundPathRootsCase(params: {
    defaults: string[];
    additions: string[];
    expected: readonly string[];
  }) {
    expect(mergeInboundPathRoots(params.defaults, params.additions)).toEqual(params.expected);
  }

  it.each([
    { pattern: "/Users/*/Library/Messages/Attachments", expected: true },
    { pattern: "/Volumes/relay/attachments", expected: true },
    { pattern: "./attachments", expected: false },
    { pattern: "/Users/**/Attachments", expected: false },
  ] as const)("validates absolute root pattern %s", ({ pattern, expected }) => {
    expectInboundRootPatternCase(pattern, expected);
  });

  it.each([
    {
      filePath: "/Users/alice/Library/Messages/Attachments/12/34/ABCDEF/IMG_0001.jpeg",
      expected: true,
    },
    {
      filePath: "/etc/passwd",
      expected: false,
    },
  ] as const)("matches wildcard roots for %s => $expected", ({ filePath, expected }) => {
    expectInboundPathAllowedCase(filePath, expected);
  });

  const accountOverrideCfg = {
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

  it.each([
    {
      name: "normalizes and de-duplicates merged roots",
      run: () =>
        expectMergedInboundPathRootsCase({
          defaults: [
            "/Users/*/Library/Messages/Attachments/",
            "/Users/*/Library/Messages/Attachments",
          ],
          additions: ["/Volumes/relay/attachments"],
          expected: ["/Users/*/Library/Messages/Attachments", "/Volumes/relay/attachments"],
        }),
    },
    {
      name: "resolves configured attachment roots with account overrides",
      run: () =>
        expectResolvedIMessageRootsCase(
          () => resolveIMessageAttachmentRoots({ cfg: accountOverrideCfg, accountId: "work" }),
          ["/Users/work/Library/Messages/Attachments", "/Users/*/Library/Messages/Attachments"],
        ),
    },
    {
      name: "resolves configured remote attachment roots with account overrides",
      run: () =>
        expectResolvedIMessageRootsCase(
          () =>
            resolveIMessageRemoteAttachmentRoots({ cfg: accountOverrideCfg, accountId: "work" }),
          [
            "/srv/work/attachments",
            "/Volumes/shared/imessage",
            "/Users/work/Library/Messages/Attachments",
            "/Users/*/Library/Messages/Attachments",
          ],
        ),
    },
  ] as const)("$name", ({ run }) => {
    run();
  });

  it.each([
    {
      name: "matches iMessage account ids case-insensitively for attachment roots",
      resolve: () => {
        const cfg = {
          channels: {
            imessage: {
              accounts: {
                Work: {
                  attachmentRoots: ["/Users/work/Library/Messages/Attachments"],
                },
              },
            },
          },
        } as OpenClawConfig;

        return resolveIMessageAttachmentRoots({ cfg, accountId: "work" });
      },
      expected: ["/Users/work/Library/Messages/Attachments", ...DEFAULT_IMESSAGE_ATTACHMENT_ROOTS],
    },
    {
      name: "falls back to default iMessage attachment roots",
      resolve: () => resolveIMessageAttachmentRoots({ cfg: {} as OpenClawConfig }),
      expected: [...DEFAULT_IMESSAGE_ATTACHMENT_ROOTS],
    },
    {
      name: "falls back to default iMessage remote attachment roots",
      resolve: () => resolveIMessageRemoteAttachmentRoots({ cfg: {} as OpenClawConfig }),
      expected: [...DEFAULT_IMESSAGE_ATTACHMENT_ROOTS],
    },
  ] as const)("$name", ({ resolve, expected }) => {
    expectResolvedIMessageRootsCase(resolve, expected);
  });
});
