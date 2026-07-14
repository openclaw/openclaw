// Covers Windows launcher script encoding for wscript/cmd code page contracts (#107416).
import iconv from "iconv-lite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeWindowsLauncherScript, encodeWindowsLauncherScript } from "./launcher-encoding.js";

const resolveWindowsSystemEncodingMock = vi.hoisted(() => vi.fn((): string | null => null));

vi.mock("../infra/windows-encoding.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/windows-encoding.js")>(
    "../infra/windows-encoding.js",
  );
  return {
    ...actual,
    resolveWindowsSystemEncoding: () => resolveWindowsSystemEncodingMock(),
  };
});

const CJK_SCRIPT_PATH = "C:\\Users\\苗振\\.openclaw\\gateway.cmd";
const REPLACEMENT_CHAR = String.fromCharCode(0xfffd);

beforeEach(() => {
  resolveWindowsSystemEncodingMock.mockReset();
  resolveWindowsSystemEncodingMock.mockReturnValue(null);
});

describe("encodeWindowsLauncherScript", () => {
  it("writes vbs scripts as UTF-16 LE with BOM including CJK paths", () => {
    const content = `CreateObject("WScript.Shell").Run """${CJK_SCRIPT_PATH}""", 0, False\r\n`;
    const encoded = encodeWindowsLauncherScript({ format: "vbs", content });

    expect(encoded.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]));
    expect(encoded.subarray(2).toString("utf16le")).toBe(content);
  });

  it("writes vbs scripts as UTF-16 LE even for pure-ASCII content", () => {
    const content = 'CreateObject("WScript.Shell").Run """C:\\gw.cmd""", 0, False\r\n';
    const encoded = encodeWindowsLauncherScript({ format: "vbs", content });

    expect(encoded.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]));
    expect(encoded.subarray(2).toString("utf16le")).toBe(content);
  });

  it("keeps ASCII cmd scripts byte-identical to UTF-8 regardless of code page", () => {
    const content = '@echo off\r\ncd /d "C:\\temp"\r\nnode gateway.js\r\n';
    const encoded = encodeWindowsLauncherScript({
      format: "cmd",
      content,
      windowsEncoding: "gbk",
    });

    expect(encoded.equals(Buffer.from(content, "utf8"))).toBe(true);
  });

  it("encodes non-ASCII cmd scripts with the CJK system code page", () => {
    const content = `@echo off\r\ncd /d "C:\\Users\\苗振\\.openclaw"\r\nnode gateway.js\r\n`;
    const encoded = encodeWindowsLauncherScript({
      format: "cmd",
      content,
      windowsEncoding: "gbk",
    });

    expect(encoded.equals(Buffer.from(content, "utf8"))).toBe(false);
    expect(encoded.equals(iconv.encode(content, "gbk"))).toBe(true);
    expect(decodeWindowsLauncherScript({ buffer: encoded, windowsEncoding: "gbk" })).toBe(content);
  });

  it("falls back to UTF-8 when no system code page is available", () => {
    const content = `@echo off\r\ncd /d "C:\\Users\\苗振"\r\n`;
    const encoded = encodeWindowsLauncherScript({
      format: "cmd",
      content,
      windowsEncoding: null,
    });

    expect(encoded.equals(Buffer.from(content, "utf8"))).toBe(true);
  });

  it("falls back to UTF-8 on windows-125x hosts whose console page differs from ANSI", () => {
    const content = '@echo off\r\ncd /d "C:\\Users\\café"\r\n';
    const encoded = encodeWindowsLauncherScript({
      format: "cmd",
      content,
      windowsEncoding: "windows-1252",
    });

    expect(encoded.equals(Buffer.from(content, "utf8"))).toBe(true);
  });

  it("resolves the system code page when no override is given", () => {
    resolveWindowsSystemEncodingMock.mockReturnValue("gbk");
    const content = `@echo off\r\ncd /d "C:\\Users\\苗振"\r\n`;
    const encoded = encodeWindowsLauncherScript({ format: "cmd", content });

    expect(encoded.equals(iconv.encode(content, "gbk"))).toBe(true);
  });

  it("fails the install instead of writing unrepresentable cmd content", () => {
    const content = '@echo off\r\nset "OC_LABEL=🚀"\r\n';

    expect(() =>
      encodeWindowsLauncherScript({ format: "cmd", content, windowsEncoding: "gbk" }),
    ).toThrow(/cannot be represented in the Windows system code page \(gbk\)/);
  });
});

describe("decodeWindowsLauncherScript", () => {
  it("strips the UTF-16 LE BOM and decodes vbs scripts", () => {
    const content = `CreateObject("WScript.Shell").Run """${CJK_SCRIPT_PATH}""", 0, False\r\n`;
    const buffer = encodeWindowsLauncherScript({ format: "vbs", content });

    expect(decodeWindowsLauncherScript({ buffer })).toBe(content);
  });

  it("prefers valid UTF-8 over the system code page for legacy scripts", () => {
    const content = `@echo off\r\ncd /d "C:\\Users\\苗振\\.openclaw"\r\nnode gateway.js\r\n`;
    const buffer = Buffer.from(content, "utf8");

    expect(decodeWindowsLauncherScript({ buffer, windowsEncoding: "gbk" })).toBe(content);
  });

  it("decodes ANSI scripts with the system code page", () => {
    // GBK bytes for 你好, mirroring src/infra/windows-encoding.test.ts fixtures.
    const buffer = Buffer.concat([
      Buffer.from("@echo off\r\nrem ", "utf8"),
      Buffer.from([0xc4, 0xe3, 0xba, 0xc3]),
    ]);

    expect(decodeWindowsLauncherScript({ buffer, windowsEncoding: "gbk" })).toBe(
      "@echo off\r\nrem 你好",
    );
  });

  it("degrades to UTF-8 replacement output when no code page is available", () => {
    const buffer = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]);

    const decoded = decodeWindowsLauncherScript({ buffer, windowsEncoding: null });
    expect(decoded).toContain(REPLACEMENT_CHAR);
  });
});
