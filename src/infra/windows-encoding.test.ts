import { describe, expect, it, vi } from "vitest";
import {
  decodeCapturedOutputBuffer,
  parseWindowsCodePage,
  resolveWindowsConsoleEncoding,
} from "./windows-encoding.js";

describe("parseWindowsCodePage", () => {
  it("parses English chcp output", () => {
    expect(parseWindowsCodePage("Active code page: 936")).toBe(936);
  });

  it("parses Chinese chcp output", () => {
    expect(parseWindowsCodePage("活动代码页: 65001")).toBe(65001);
  });

  it("returns null for empty string", () => {
    expect(parseWindowsCodePage("")).toBeNull();
  });

  it("returns null when no code page number found", () => {
    expect(parseWindowsCodePage("no code page")).toBeNull();
  });

  it("parses Japanese chcp output", () => {
    expect(parseWindowsCodePage("アクティブ コード ページ: 932")).toBe(932);
  });

  it("parses Korean chcp output", () => {
    expect(parseWindowsCodePage("활성 코드 페이지: 949")).toBe(949);
  });

  it("returns null for non-numeric code page", () => {
    expect(parseWindowsCodePage("Active code page: abc")).toBeNull();
  });

  it("returns null for zero code page", () => {
    expect(parseWindowsCodePage("Active code page: 0")).toBeNull();
  });
});

describe("resolveWindowsConsoleEncoding", () => {
  it("returns null on non-Windows platforms", () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    try {
      expect(resolveWindowsConsoleEncoding()).toBeNull();
    } finally {
      platformSpy.mockRestore();
    }
  });
});

describe("decodeCapturedOutputBuffer", () => {
  it("returns UTF-8 string on non-Windows platforms", () => {
    const raw = Buffer.from("hello world");
    const decoded = decodeCapturedOutputBuffer({ buffer: raw, platform: "darwin" });
    expect(decoded).toBe("hello world");
  });

  it("returns UTF-8 string when encoding is utf-8", () => {
    const raw = Buffer.from("hello world");
    const decoded = decodeCapturedOutputBuffer({
      buffer: raw,
      platform: "win32",
      windowsEncoding: "utf-8",
    });
    expect(decoded).toBe("hello world");
  });

  it("returns UTF-8 string when encoding is null", () => {
    const raw = Buffer.from("hello world");
    const decoded = decodeCapturedOutputBuffer({
      buffer: raw,
      platform: "win32",
      windowsEncoding: null,
    });
    expect(decoded).toBe("hello world");
  });

  it("decodes GBK output on Windows when code page is known", () => {
    let supportsGbk = true;
    try {
      void new TextDecoder("gbk");
    } catch {
      supportsGbk = false;
    }

    const raw = Buffer.from([0xb2, 0xe2, 0xca, 0xd4, 0xa1, 0xab, 0xa3, 0xbb]);
    const decoded = decodeCapturedOutputBuffer({
      buffer: raw,
      platform: "win32",
      windowsEncoding: "gbk",
    });

    if (!supportsGbk) {
      expect(decoded).toContain("�");
      return;
    }
    expect(decoded).toBe("测试～；");
  });

  it("decodes Shift_JIS output on Windows", () => {
    let supportsShiftJis = true;
    try {
      void new TextDecoder("shift_jis");
    } catch {
      supportsShiftJis = false;
    }

    const raw = Buffer.from([0x82, 0xb1, 0x82, 0xf1, 0x82, 0xc9, 0x82, 0xbf, 0x82, 0xcd]);
    const decoded = decodeCapturedOutputBuffer({
      buffer: raw,
      platform: "win32",
      windowsEncoding: "shift_jis",
    });

    if (!supportsShiftJis) {
      expect(decoded).toContain("�");
      return;
    }
    expect(decoded).toBe("こんにちは");
  });

  it("falls back to UTF-8 on unsupported encoding", () => {
    const raw = Buffer.from([0xb2, 0xe2, 0xca, 0xd4]);
    const decoded = decodeCapturedOutputBuffer({
      buffer: raw,
      platform: "win32",
      windowsEncoding: "nonexistent-encoding",
    });
    expect(decoded).toBe(raw.toString("utf8"));
  });

  it("handles empty buffer", () => {
    const raw = Buffer.alloc(0);
    const decoded = decodeCapturedOutputBuffer({ buffer: raw, platform: "win32" });
    expect(decoded).toBe("");
  });

  it("handles pure ASCII on Windows with GBK encoding", () => {
    const raw = Buffer.from("ASCII text");
    const decoded = decodeCapturedOutputBuffer({
      buffer: raw,
      platform: "win32",
      windowsEncoding: "gbk",
    });
    expect(decoded).toBe("ASCII text");
  });

  it("handles mixed CJK and ASCII in GBK", () => {
    let supportsGbk = true;
    try {
      void new TextDecoder("gbk");
    } catch {
      supportsGbk = false;
    }

    const gbkBytes = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]);
    const asciiBytes = Buffer.from(" hello");
    const raw = Buffer.concat([gbkBytes, asciiBytes]);
    const decoded = decodeCapturedOutputBuffer({
      buffer: raw,
      platform: "win32",
      windowsEncoding: "gbk",
    });

    if (!supportsGbk) {
      return;
    }
    expect(decoded).toBe("你好 hello");
  });
});
