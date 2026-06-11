import { describe, expect, it } from "vitest";
import { resolveHeartbeatReplyPayload } from "./heartbeat-reply-payload.js";

describe("resolveHeartbeatReplyPayload", () => {
  it("returns undefined for undefined input", () => {
    expect(resolveHeartbeatReplyPayload(undefined)).toBeUndefined();
  });

  it("returns single payload directly", () => {
    const payload = { text: "hello" };
    expect(resolveHeartbeatReplyPayload(payload)).toBe(payload);
  });

  it("returns undefined for single reasoning payload when includeReasoning is false", () => {
    const payload = { text: "thinking...", isReasoning: true };
    expect(
      resolveHeartbeatReplyPayload(payload, { includeReasoning: false }),
    ).toBeUndefined();
  });

  it("returns single reasoning payload when includeReasoning is true", () => {
    const payload = { text: "thinking...", isReasoning: true };
    expect(
      resolveHeartbeatReplyPayload(payload, { includeReasoning: true }),
    ).toBe(payload);
  });

  it("returns single reasoning payload by default (backward compat)", () => {
    const payload = { text: "thinking...", isReasoning: true };
    expect(resolveHeartbeatReplyPayload(payload)).toBe(payload);
  });

  it("picks the last outbound payload from array", () => {
    const payloads = [{ text: "first" }, { text: "last" }];
    expect(resolveHeartbeatReplyPayload(payloads)).toBe(payloads[1]);
  });

  it("skips reasoning payloads when includeReasoning is false", () => {
    const payloads = [
      { text: "answer" },
      { text: "thinking...", isReasoning: true },
    ];
    expect(
      resolveHeartbeatReplyPayload(payloads, { includeReasoning: false }),
    ).toBe(payloads[0]);
  });

  it("returns undefined when all payloads are reasoning and includeReasoning is false", () => {
    const payloads = [
      { text: "think step 1", isReasoning: true },
      { text: "think step 2", isReasoning: true },
    ];
    expect(
      resolveHeartbeatReplyPayload(payloads, { includeReasoning: false }),
    ).toBeUndefined();
  });

  it("returns reasoning payload when includeReasoning is true", () => {
    const payloads = [
      { text: "answer" },
      { text: "thinking...", isReasoning: true },
    ];
    expect(
      resolveHeartbeatReplyPayload(payloads, { includeReasoning: true }),
    ).toBe(payloads[1]);
  });

  it("skips null/undefined entries in array", () => {
    const payloads = [null, { text: "answer" }] as any[];
    expect(resolveHeartbeatReplyPayload(payloads)).toBe(payloads[1]);
  });

  it("returns undefined when no outbound content exists", () => {
    const payloads = [{}];
    expect(resolveHeartbeatReplyPayload(payloads)).toBeUndefined();
  });

  it("handles reasoning payload without isReasoning flag as normal payload", () => {
    const payloads = [{ text: "normal text" }];
    expect(
      resolveHeartbeatReplyPayload(payloads, { includeReasoning: false }),
    ).toBe(payloads[0]);
  });
});
