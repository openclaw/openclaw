import { describe, expect, it } from "vitest";
import type { ReplyPayload } from "./types.js";
import { resolveHeartbeatReplyPayload } from "./heartbeat-reply-payload.js";

describe("resolveHeartbeatReplyPayload", () => {
  it("returns undefined for undefined input", () => {
    expect(resolveHeartbeatReplyPayload(undefined)).toBeUndefined();
  });

  it("returns a single payload as-is", () => {
    const p: ReplyPayload = { text: "HEARTBEAT_OK" } as ReplyPayload;
    expect(resolveHeartbeatReplyPayload(p)).toBe(p);
  });

  it("picks last non-empty payload from array", () => {
    const a: ReplyPayload = { text: "first" } as ReplyPayload;
    const b: ReplyPayload = { text: "second" } as ReplyPayload;
    expect(resolveHeartbeatReplyPayload([a, b])).toBe(b);
  });

  it("skips error payloads when a non-error payload exists", () => {
    const agent: ReplyPayload = { text: "HEARTBEAT_OK" } as ReplyPayload;
    const err: ReplyPayload = {
      text: "⚠️ 🛠️ Exec: command failed",
      isError: true,
    } as ReplyPayload;
    // Error appended after agent text — agent text should win.
    expect(resolveHeartbeatReplyPayload([agent, err])).toBe(agent);
  });

  it("returns error payload when no non-error payload exists", () => {
    const err: ReplyPayload = {
      text: "⚠️ 🛠️ Exec: command failed",
      isError: true,
    } as ReplyPayload;
    expect(resolveHeartbeatReplyPayload([err])).toBe(err);
  });

  it("skips empty payloads", () => {
    const empty: ReplyPayload = {} as ReplyPayload;
    const real: ReplyPayload = { text: "ok" } as ReplyPayload;
    expect(resolveHeartbeatReplyPayload([empty, real])).toBe(real);
  });

  it("returns undefined for array of empty payloads", () => {
    const empty: ReplyPayload = {} as ReplyPayload;
    expect(resolveHeartbeatReplyPayload([empty])).toBeUndefined();
  });

  it("prefers non-error payload even when error comes first", () => {
    const err: ReplyPayload = {
      text: "error",
      isError: true,
    } as ReplyPayload;
    const agent: ReplyPayload = { text: "HEARTBEAT_OK" } as ReplyPayload;
    expect(resolveHeartbeatReplyPayload([err, agent])).toBe(agent);
  });
});
