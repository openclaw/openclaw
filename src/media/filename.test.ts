import { describe, expect, it } from "vitest";
import {
  basenameFromUntrustedFilename,
  decodeContentDispositionFilename,
  recoverLatin1Utf8Mojibake,
} from "./filename.js";

describe("basenameFromUntrustedFilename", () => {
  it("handles POSIX and Windows path separators", () => {
    expect(basenameFromUntrustedFilename("../../report.pdf")).toBe("report.pdf");
    expect(basenameFromUntrustedFilename(String.raw`C:\temp\photo.jpg`)).toBe("photo.jpg");
  });

  it("drops control characters and rejects empty path components", () => {
    expect(basenameFromUntrustedFilename("bad\u0000name.txt")).toBe("badname.txt");
    expect(basenameFromUntrustedFilename("..")).toBeUndefined();
  });
});

describe("recoverLatin1Utf8Mojibake", () => {
  it("recovers UTF-8 bytes that were interpreted as Latin-1", () => {
    expect(recoverLatin1Utf8Mojibake("ä¸­å›½é“¶è¡Œ.pdf")).toBe("中国银行.pdf");
  });

  it("keeps normal Latin-1 text when recovery would be lossy", () => {
    expect(recoverLatin1Utf8Mojibake("café.pdf")).toBe("café.pdf");
  });
});

describe("decodeContentDispositionFilename", () => {
  it("prefers RFC 5987 filename* over plain filename", () => {
    expect(
      decodeContentDispositionFilename(
        "attachment; filename=wrong.txt; filename*=UTF-8''%E2%9C%93-report.txt",
      ),
    ).toBe("✓-report.txt");
  });

  it("decodes RFC 5987 values with language tags", () => {
    expect(
      decodeContentDispositionFilename("attachment; filename*=UTF-8'en'%E2%9C%93-report.txt"),
    ).toBe("✓-report.txt");
  });

  it("decodes explicit GB18030, Shift_JIS, and EUC-KR filename* values", () => {
    expect(
      decodeContentDispositionFilename("attachment; filename*=GB18030''%D6%D0%CE%C4.txt"),
    ).toBe("中文.txt");
    expect(
      decodeContentDispositionFilename("attachment; filename*=Shift_JIS''%83%65%83%58%83%67.txt"),
    ).toBe("テスト.txt");
    expect(decodeContentDispositionFilename("attachment; filename*=EUC-KR''%C7%D1%B1%DB.txt")).toBe(
      "한글.txt",
    );
  });

  it("recovers plain filename mojibake from Content-Disposition", () => {
    expect(decodeContentDispositionFilename('attachment; filename="ä¸­å›½é“¶è¡Œ.pdf"')).toBe(
      "中国银行.pdf",
    );
  });

  it("keeps semicolons inside quoted filenames", () => {
    expect(decodeContentDispositionFilename('attachment; filename="report; final.pdf"')).toBe(
      "report; final.pdf",
    );
  });
});
