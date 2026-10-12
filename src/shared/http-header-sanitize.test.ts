import { describe, expect, it } from "vitest";
import {
  isHeaderValueLatin1Safe,
  sanitizeContentDispositionHeader,
  sanitizeForwardedResponseHeaders,
  sanitizeLatin1HeaderValue,
} from "./http-header-sanitize.js";

describe("isHeaderValueLatin1Safe", () => {
  it.each([
    { name: "ascii", value: "attachment; filename=report.pdf" },
    { name: "latin-1 umlaut", value: "date; e=ä" },
    { name: "latin-1 upper bound", value: "ÿ" },
    { name: "no-break space", value: "\u00A0" },
  ])("accepts $name", ({ value }) => {
    expect(isHeaderValueLatin1Safe(value)).toBe(true);
  });

  it.each([
    { name: "tab", value: "a\tb" },
    { name: "cjk", value: "附件.log" },
    { name: "emoji", value: "a😀b" },
    { name: "carriage return", value: "a\rb" },
    { name: "line feed", value: "a\nb" },
    { name: "null", value: "a\u0000b" },
    { name: "delete", value: "a\u007Fb" },
    { name: "control char", value: "a\u001Fb" },
  ])("rejects $name", ({ value }) => {
    expect(isHeaderValueLatin1Safe(value)).toBe(false);
  });
});

describe("sanitizeLatin1HeaderValue", () => {
  it("keeps a safe value verbatim", () => {
    expect(sanitizeLatin1HeaderValue("Content-Type: text/plain")).toBe("Content-Type: text/plain");
  });

  it("replaces non-Latin-1 characters", () => {
    expect(sanitizeLatin1HeaderValue("附a\u{1F600}")).toBe("_a_");
  });

  it("replaces tab and other controls", () => {
    expect(sanitizeLatin1HeaderValue("a\tb\nc\u0000")).toBe("a_b_c_");
  });
});

describe("sanitizeContentDispositionHeader", () => {
  it("returns a safe value unchanged", () => {
    const value = 'attachment; filename="report.pdf"';
    expect(sanitizeContentDispositionHeader(value)).toBe(value);
  });

  it("re-encodes a cjk filename with an ascii fallback and rfc 5987", () => {
    expect(sanitizeContentDispositionHeader('attachment; filename="附件.log"')).toBe(
      "attachment; filename=\"__.log\"; filename*=UTF-8''%E9%99%84%E4%BB%B6.log",
    );
  });

  it("escapes rfc 5987 attribute characters in the extended value", () => {
    expect(sanitizeContentDispositionHeader('attachment; filename="附件\'a(b).log"')).toBe(
      "attachment; filename=\"__'a(b).log\"; filename*=UTF-8''%E9%99%84%E4%BB%B6%27a%28b%29.log",
    );
  });

  it("keeps the disposition type", () => {
    expect(sanitizeContentDispositionHeader('inline; filename="报告.txt"')).toBe(
      "inline; filename=\"__.txt\"; filename*=UTF-8''%E6%8A%A5%E5%91%8A.txt",
    );
  });

  it("handles a bare (unquoted) filename", () => {
    expect(sanitizeContentDispositionHeader("attachment; filename=附件.log")).toBe(
      "attachment; filename=\"__.log\"; filename*=UTF-8''%E9%99%84%E4%BB%B6.log",
    );
  });

  it("keeps an ascii filename and scrubs other non-ascii parameters", () => {
    expect(sanitizeContentDispositionHeader('attachment; filename="ok.txt"; x-note="附件"')).toBe(
      'attachment; filename="ok.txt"; x-note="__"',
    );
  });

  it("preserves escaped quotes inside a cjk filename", () => {
    expect(sanitizeContentDispositionHeader('attachment; filename="附\\"件.log"')).toBe(
      "attachment; filename=\"___.log\"; filename*=UTF-8''%E9%99%84%22%E4%BB%B6.log",
    );
  });
});

describe("sanitizeForwardedResponseHeaders", () => {
  it("re-encodes a cjk content-disposition header", () => {
    const result = sanitizeForwardedResponseHeaders({
      "content-type": "application/octet-stream",
      "content-disposition": 'attachment; filename="附件.log"',
    });
    expect(result["content-disposition"]).toBe(
      "attachment; filename=\"__.log\"; filename*=UTF-8''%E9%99%84%E4%BB%B6.log",
    );
    expect(result["content-type"]).toBe("application/octet-stream");
  });

  it("scrubs non-Latin-1 characters from other headers", () => {
    const result = sanitizeForwardedResponseHeaders({ "x-note": "附" });
    expect(result["x-note"]).toBe("_");
  });

  it("preserves array values", () => {
    const result = sanitizeForwardedResponseHeaders({
      "set-cookie": ["a=1; 附", "b=2"],
    });
    expect(result["set-cookie"]).toEqual(["a=1; _", "b=2"]);
  });

  it("drops undefined header values", () => {
    const result = sanitizeForwardedResponseHeaders({
      "content-type": "text/plain",
      "x-missing": undefined,
    });
    expect(result).toEqual({ "content-type": "text/plain" });
  });

  it("returns safe headers unchanged", () => {
    const headers = { "content-type": "text/plain", "content-length": "4" };
    expect(sanitizeForwardedResponseHeaders(headers)).toEqual(headers);
  });
});
