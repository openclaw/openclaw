import { describe, expect, it } from "vitest";
import { resolveGeneratedMediaMaxBytes } from "../media/configured-max-bytes.js";
import {
  resolveChatAttachmentLimits,
  resolveChatAttachmentMaxBytes,
  resolveChatAttachmentPolicy,
} from "./chat-attachment-policy.js";

const MB = 1024 * 1024;
const FRAME_BUDGET = 19_464_192;

describe("chat attachment policy", () => {
  it("separates document admission and media processing budgets", () => {
    const cfg = {
      attachments: { maxFileMb: 10, maxTotalMb: 15 },
      agents: { defaults: { mediaMaxMb: 1 } },
    };
    expect(resolveChatAttachmentLimits(cfg)).toEqual({
      maxBytes: 10 * MB,
      maxTotalBytes: 15 * MB,
      maxMediaBytes: MB,
    });
    expect(resolveChatAttachmentPolicy(cfg)).toEqual({
      maxBytes: 10 * MB,
      maxTotalBytes: 15 * MB,
      maxMediaBytes: MB,
      maxImageBytes: MB,
    });
    expect(resolveGeneratedMediaMaxBytes(cfg, "audio")).toBe(MB);
    expect(resolveChatAttachmentMaxBytes({ agents: { defaults: { mediaMaxMb: 1 } } })).toBe(
      20 * MB,
    );
  });

  it("keeps the default batch finite without reducing a configured single-file cap", () => {
    expect(resolveChatAttachmentLimits({})).toEqual({
      maxBytes: 20 * MB,
      maxTotalBytes: 20 * MB,
      maxMediaBytes: 20 * MB,
    });
    expect(resolveChatAttachmentLimits({ attachments: { maxFileMb: 50 } })).toEqual({
      maxBytes: 50 * MB,
      maxTotalBytes: 50 * MB,
      maxMediaBytes: 20 * MB,
    });
  });

  it("advertises the binding total, image, and transport ceilings", () => {
    expect(resolveChatAttachmentPolicy({ attachments: { maxFileMb: 50 } })).toEqual({
      maxBytes: FRAME_BUDGET,
      maxImageBytes: 6 * MB,
      maxTotalBytes: FRAME_BUDGET,
      maxMediaBytes: FRAME_BUDGET,
    });
    expect(resolveChatAttachmentPolicy({ attachments: { maxFileMb: 10, maxTotalMb: 2 } })).toEqual({
      maxBytes: 2 * MB,
      maxImageBytes: 2 * MB,
      maxTotalBytes: 2 * MB,
      maxMediaBytes: 2 * MB,
    });
  });

  it("keeps direct caller byte conversions positive and representable", () => {
    expect(resolveChatAttachmentMaxBytes({ attachments: { maxFileMb: 1e308 } })).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(resolveChatAttachmentPolicy({ attachments: { maxFileMb: 0.0000001 } }).maxBytes).toBe(1);
  });
});
