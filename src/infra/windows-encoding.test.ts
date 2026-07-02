// Covers Windows command-output code page parsing and decoding.
import { describe, expect, it } from "vitest";
import {
  createWindowsOutputDecoder,
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

  describe("parseWindowsCodePage", () => {
    it("returns null for empty or whitespace-only input", () => {
      expect(parseWindowsCodePage("")).toBeNull();
      expect(parseWindowsCodePage("   ")).toBeNull();
    });

    it("rejects 1-2 digit numbers that are too short for a valid code page", () => {
      expect(parseWindowsCodePage("Active code page: 0")).toBeNull();
      expect(parseWindowsCodePage("Active code page: 12")).toBeNull();
    });

    it("accepts valid 3-5 digit code pages at the boundaries", () => {
      expect(parseWindowsCodePage("Active code page: 437")).toBe(437);
      expect(parseWindowsCodePage("Active code page: 54936")).toBe(54936);
    });

    it("extracts the first 3-5 digit number from multi-line text", () => {
      expect(parseWindowsCodePage("line1\nActive code page: 936\nline3")).toBe(936);
      expect(parseWindowsCodePage("error line\nActive code page: 1252\nsome error")).toBe(1252);
    });

    it("returns null when no 3-5 digit number is present", () => {
      expect(parseWindowsCodePage("Active code page:")).toBeNull();
      expect(parseWindowsCodePage("some text without numbers")).toBeNull();
      expect(parseWindowsCodePage("1234567")).toBeNull(); // 6+ digits won't match
    });
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

  it("keeps split UTF-8 output intact on POSIX", () => {
    const decoder = createWindowsOutputDecoder({ platform: "linux" });
    const raw = Buffer.from(JSON.stringify({ text: "hello 世" }), "utf8");
    const splitIndex = raw.indexOf(Buffer.from("世", "utf8")[0]);

    expect(decoder.decode(raw.subarray(0, splitIndex + 1))).toBe(
      raw.subarray(0, splitIndex).toString("utf8"),
    );
    expect(decoder.decode(raw.subarray(splitIndex + 1))).toBe('世"}');
    expect(decoder.flush()).toBe("");
  });
});
