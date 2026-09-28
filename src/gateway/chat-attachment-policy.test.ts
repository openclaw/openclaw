// Attachment policy tests guard the numbers advertised on `hello-ok` against the
// ceilings the parser actually enforces.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  DEFAULT_CHAT_ATTACHMENT_MAX_BYTES,
  resolveChatAttachmentMaxBytes,
  resolveChatAttachmentPolicy,
} from "./chat-attachment-policy.js";

const MB = 1024 * 1024;

const cfgWithMediaMaxMb = (value: unknown): OpenClawConfig =>
  ({ agents: { defaults: { mediaMaxMb: value } } }) as unknown as OpenClawConfig;

describe("resolveChatAttachmentMaxBytes", () => {
  it("falls back to the default ceiling when unset", () => {
    expect(resolveChatAttachmentMaxBytes({} as OpenClawConfig)).toBe(
      DEFAULT_CHAT_ATTACHMENT_MAX_BYTES,
    );
    expect(resolveChatAttachmentMaxBytes({ agents: {} } as unknown as OpenClawConfig)).toBe(
      DEFAULT_CHAT_ATTACHMENT_MAX_BYTES,
    );
  });

  it("rejects non-positive, non-finite, or non-number values", () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, "50", null, undefined]) {
      expect(resolveChatAttachmentMaxBytes(cfgWithMediaMaxMb(bad))).toBe(
        DEFAULT_CHAT_ATTACHMENT_MAX_BYTES,
      );
    }
  });

  it("never floors a legal sub-byte mediaMaxMb to zero", () => {
    expect(resolveChatAttachmentMaxBytes(cfgWithMediaMaxMb(0.0000001))).toBe(1);
  });

  it("keeps an enormous mediaMaxMb representable instead of overflowing", () => {
    expect(resolveChatAttachmentMaxBytes(cfgWithMediaMaxMb(1e308))).toBe(Number.MAX_SAFE_INTEGER);
  });
});

// Frame budget mirrored from the policy module: base64 expands 4/3 and the
// JSON envelope needs slack, so the advertised ceiling must fit one WS frame.
const MAX_ADVERTISED_BYTES = Math.floor(((25 * MB - 256 * 1024) * 3) / 4);

describe("resolveChatAttachmentPolicy", () => {
  it("clamps the advertised ceiling to what one WS frame can carry as base64", () => {
    // The 20MB default and any raised mediaMaxMb both exceed the frame budget:
    // advertising them would let the client encode a frame the server
    // hard-drops with 1009.
    expect(resolveChatAttachmentPolicy({} as OpenClawConfig).maxBytes).toBe(MAX_ADVERTISED_BYTES);
    expect(resolveChatAttachmentPolicy(cfgWithMediaMaxMb(50)).maxBytes).toBe(MAX_ADVERTISED_BYTES);
    expect(MAX_ADVERTISED_BYTES).toBeLessThan(20 * MB);
  });

  it("keeps both ceilings positive so the hello-ok schema stays satisfiable", () => {
    const policy = resolveChatAttachmentPolicy(cfgWithMediaMaxMb(0.0000001));
    expect(policy.maxBytes).toBeGreaterThanOrEqual(1);
    expect(policy.maxImageBytes).toBeGreaterThanOrEqual(1);
  });
});
