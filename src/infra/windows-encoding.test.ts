// Covers Windows command-output code page parsing and decoding.
import { describe, expect, it } from "vitest";
import {
  createWindowsOutputDecoder,
  decodeTextFileBuffer,
  decodeWindowsOutputBuffer,
  decodeWindowsTextFileBuffer,
  parseWindowsCodePage,
} from "./windows-encoding.js";

describe("windows output encoding", () => {
  it("parses code pages from chcp output text", () => {
    expect(parseWindowsCodePage("Active code page: 936")).toBe(936);
    expect(parseWindowsCodePage("活动代码页: 65001")).toBe(65001);
    expect(parseWindowsCodePage("no code page")).toBeNull();
  });

  it("decodes GBK output on Windows when UTF-8 is invalid and code page is known", () => {
    const raw = Buffer.from([0xb2, 0xe2, 0xca, 0xd4, 0xa1, 0xab, 0xa3, 0xbb]);

    expect(
      decodeWindowsOutputBuffer({
        buffer: raw,
        platform: "win32",
        windowsEncoding: "gbk",
      }),
    ).toBe("测试～；");
  });

  it("prefers valid UTF-8 output on Windows even when the console code page is legacy", () => {
    const raw = Buffer.from("测试", "utf8");

    expect(
      decodeWindowsOutputBuffer({
        buffer: raw,
        platform: "win32",
        windowsEncoding: "gbk",
      }),
    ).toBe("测试");
  });

  it("decodes legacy text files with the Windows system encoding", () => {
    const raw = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]);

    expect(
      decodeWindowsTextFileBuffer({
        buffer: raw,
        platform: "win32",
        windowsEncoding: "gbk",
      }),
    ).toBe("你好");
  });

  it("supports common Windows system codepage decoder labels", () => {
    for (const encoding of [
      "windows-874",
      "windows-1250",
      "windows-1251",
      "windows-1252",
      "windows-1253",
      "windows-1254",
      "windows-1255",
      "windows-1256",
      "windows-1257",
      "windows-1258",
    ]) {
      expect(() => new TextDecoder(encoding)).not.toThrow();
    }
  });

  it("keeps multibyte Windows codepage characters intact across chunk boundaries", () => {
    const decoder = createWindowsOutputDecoder({
      platform: "win32",
      windowsEncoding: "gbk",
    });

    expect(decoder.decode(Buffer.from([0xb2]))).toBe("");
    expect(decoder.decode(Buffer.from([0xe2, 0xca]))).toBe("测");
    expect(decoder.decode(Buffer.from([0xd4]))).toBe("试");
    expect(decoder.flush()).toBe("");
  });

  it("replays buffered UTF-8 lead bytes when split GBK output falls back to the console code page", () => {
    const decoder = createWindowsOutputDecoder({
      platform: "win32",
      windowsEncoding: "gbk",
    });

    expect(decoder.decode(Buffer.from([0xc4]))).toBe("");
    expect(decoder.decode(Buffer.from([0xe3]))).toBe("你");
    expect(decoder.flush()).toBe("");
  });

  it("keeps split valid UTF-8 output on the UTF-8 path for streaming decode", () => {
    const decoder = createWindowsOutputDecoder({
      platform: "win32",
      windowsEncoding: "gbk",
    });
    const raw = Buffer.from("测试", "utf8");

    expect(decoder.decode(raw.subarray(0, 1))).toBe("");
    expect(decoder.decode(raw.subarray(1, 3))).toBe("测");
    expect(decoder.decode(raw.subarray(3))).toBe("试");
    expect(decoder.flush()).toBe("");
  });
});

describe("decodeTextFileBuffer", () => {
  it("decodes GBK-encoded content with explicit encoding on non-Windows platforms", () => {
    const gbkBytes = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]);
    expect(decodeTextFileBuffer({ buffer: gbkBytes, encoding: "gbk", platform: "linux" })).toBe(
      "你好",
    );
  });

  it("prefers valid UTF-8 when encoding is specified but buffer is valid UTF-8", () => {
    const utf8Bytes = Buffer.from("中文测试", "utf8");
    expect(decodeTextFileBuffer({ buffer: utf8Bytes, encoding: "gbk", platform: "linux" })).toBe(
      "中文测试",
    );
  });

  it("falls back to UTF-8 on non-Windows when no encoding is specified and buffer is not valid UTF-8", () => {
    const gbkBytes = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]);
    const result = decodeTextFileBuffer({ buffer: gbkBytes, platform: "linux" });
    expect(result).toBe(gbkBytes.toString("utf8"));
  });

  it("decodes GBK with explicit encoding on Windows", () => {
    const gbkBytes = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]);
    expect(
      decodeTextFileBuffer({ buffer: gbkBytes, encoding: "gbk", platform: "win32" }),
    ).toBe("你好");
  });

  it("falls back gracefully for unsupported encoding labels", () => {
    const utf8Bytes = Buffer.from("test", "utf8");
    expect(
      decodeTextFileBuffer({ buffer: utf8Bytes, encoding: "unsupported-encoding" }),
    ).toBe("test");
  });

  it("treats utf-8 and utf8 encoding labels as direct UTF-8 decode", () => {
    const utf8Bytes = Buffer.from("中文", "utf8");
    expect(decodeTextFileBuffer({ buffer: utf8Bytes, encoding: "utf-8" })).toBe("中文");
    expect(decodeTextFileBuffer({ buffer: utf8Bytes, encoding: "utf8" })).toBe("中文");
  });
});
