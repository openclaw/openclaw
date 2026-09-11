import { describe, expect, it } from "vitest";
import {
  clipLocalSessionRecordText,
  decodeLocalSessionGatewayFrame,
  decodeLocalSessionSourceFrame,
  encodeLocalSessionFrame,
  formatLocalSessionInputEnvelope,
  LOCAL_SESSION_RECORD_TEXT_MAX_BYTES,
} from "./local-session-source-protocol.js";

describe("local session source protocol", () => {
  it("round-trips source frames and rejects unknown fields", () => {
    const frame = {
      type: "records" as const,
      threadId: "thread-1",
      records: [{ id: "r1", seq: 1, ts: 1, kind: "user" as const, text: "hi" }],
    };
    expect(decodeLocalSessionSourceFrame(encodeLocalSessionFrame(frame))).toEqual(frame);
    expect(() =>
      decodeLocalSessionSourceFrame(
        new TextEncoder().encode(JSON.stringify({ ...frame, extra: true })),
      ),
    ).toThrow();
  });

  it("rejects gateway input without a sender and accepts the documented modes", () => {
    const input = {
      type: "input" as const,
      inputId: "in-1",
      threadId: "thread-1",
      mode: "followup" as const,
      text: "run the tests",
      sender: { displayName: "Alice" },
    };
    expect(decodeLocalSessionGatewayFrame(encodeLocalSessionFrame(input))).toEqual(input);
    expect(() =>
      decodeLocalSessionGatewayFrame(
        new TextEncoder().encode(JSON.stringify({ ...input, sender: undefined })),
      ),
    ).toThrow();
    expect(() =>
      decodeLocalSessionGatewayFrame(
        new TextEncoder().encode(JSON.stringify({ ...input, mode: "interrupt" })),
      ),
    ).toThrow();
  });

  it("clips record text to the wire ceiling and flags it", () => {
    const long = "x".repeat(LOCAL_SESSION_RECORD_TEXT_MAX_BYTES + 100);
    const clipped = clipLocalSessionRecordText(long);
    expect(clipped.truncated).toBe(true);
    expect(Buffer.byteLength(clipped.text, "utf8")).toBeLessThanOrEqual(
      LOCAL_SESSION_RECORD_TEXT_MAX_BYTES,
    );
    expect(clipLocalSessionRecordText("short")).toEqual({ text: "short", truncated: false });
  });

  it("names the sender in the envelope the native model receives", () => {
    expect(
      formatLocalSessionInputEnvelope({
        senderDisplayName: "Alice",
        inputId: "7f2a9c1d-0000",
        text: "please run the focused test",
      }),
    ).toBe("[Alice via OpenClaw team · message 7f2a9c1d]\nplease run the focused test");
  });
});
