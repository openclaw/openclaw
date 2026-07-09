// Proxy capture server tests cover the byte-bounded UTF-8 body preview boundary.
import { describe, expect, it } from "vitest";
import {
  appendBodyPreviewCapture,
  createBodyPreviewCapture,
  finishBodyPreviewCapture,
} from "./proxy-server.js";

describe("finishBodyPreviewCapture UTF-8 boundary", () => {
  // The body preview is capped at a byte budget; when a chunk lands mid-multibyte
  // sequence the finished dataText must not end in U+FFFD.
  it("does not split a multibyte sequence into U+FFFD when the byte budget cuts it", () => {
    const capture = createBodyPreviewCapture();
    // "é" is 2 UTF-8 bytes (0xc3 0xa9); feeding a body whose byte budget splits it
    // exercises the boundary backoff in finishBodyPreviewCapture.
    const body = `${"x".repeat(7)}é${"y".repeat(10)}`;
    appendBodyPreviewCapture(capture, Buffer.from(body, "utf8").subarray(0, 8));
    const { dataText } = finishBodyPreviewCapture(capture);
    expect(dataText.endsWith("\uFFFD")).toBe(false);
  });

  it("decodes a full multibyte body unchanged when under the byte budget", () => {
    const capture = createBodyPreviewCapture();
    const body = "café 😀 中文";
    appendBodyPreviewCapture(capture, body);
    const { dataText } = finishBodyPreviewCapture(capture);
    expect(dataText).toBe(body);
  });

  it("marks the preview truncated and records total body bytes when the budget is exceeded", () => {
    const capture = createBodyPreviewCapture();
    const big = "a".repeat(20000);
    appendBodyPreviewCapture(capture, big);
    const { dataText, metaJson } = finishBodyPreviewCapture(capture);
    expect(dataText.endsWith("\uFFFD")).toBe(false);
    expect(metaJson).toBeDefined();
    const meta = JSON.parse(metaJson ?? "{}");
    expect(meta.bodyBytes).toBe(20000);
    expect(meta.captureTruncated).toBe(true);
  });

  it("keeps a 4-byte emoji whole when the cut lands inside it", () => {
    const capture = createBodyPreviewCapture();
    // 😀 = 4 UTF-8 bytes; total 8193 bytes (8189 ascii + 4-byte emoji), budget 8192.
    const body = Buffer.from(`${"x".repeat(8189)}\uD83D\uDE00`, "utf8");
    appendBodyPreviewCapture(capture, body);
    const { dataText } = finishBodyPreviewCapture(capture);
    expect(dataText.endsWith("\uFFFD")).toBe(false);
    expect(Buffer.byteLength(dataText, "utf8")).toBeLessThanOrEqual(8192);
  });
});
