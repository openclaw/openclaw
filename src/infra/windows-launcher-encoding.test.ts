// Covers Windows launcher script encoding for wscript/cmd code page contracts (#107416, #108774).
import iconv from "iconv-lite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodeWindowsLauncherScript,
  encodeWindowsLauncherScript,
} from "./windows-launcher-encoding.js";

const resolveWindowsOemEncodingMock = vi.hoisted(() => vi.fn((): string | null => null));
const resolveWindowsOemCodePageMock = vi.hoisted(() => vi.fn((): number | null => null));

vi.mock("./windows-encoding.js", async () => {
  const actual =
    await vi.importActual<typeof import("./windows-encoding.js")>("./windows-encoding.js");
  return {
    ...actual,
    resolveWindowsOemCodePage: () => resolveWindowsOemCodePageMock(),
    resolveWindowsOemEncoding: () => resolveWindowsOemEncodingMock(),
  };
});

const CJK_SCRIPT_PATH = "C:\\Users\\苗振\\.openclaw\\gateway.cmd";
const REPLACEMENT_CHAR = String.fromCharCode(0xfffd);
const marker = (codePage: number, encoding: string) =>
  `@chcp ${codePage} >nul\r\n@rem openclaw-launcher-encoding=${encoding}\r\n`;
const GBK_MARKER = marker(936, "gbk");
const EUC_KR_MARKER = marker(949, "euc-kr");
const CP857_MARKER = marker(857, "cp857");

beforeEach(() => {
  resolveWindowsOemEncodingMock.mockReset();
  resolveWindowsOemEncodingMock.mockReturnValue(null);
  resolveWindowsOemCodePageMock.mockReset();
  resolveWindowsOemCodePageMock.mockReturnValue(437);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("encodeWindowsLauncherScript", () => {
  it("fails closed for ASCII cmd syntax on OEMCP 864", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    resolveWindowsOemCodePageMock.mockReturnValue(864);
    const content = "@echo off\r\necho %PATH%\r\n";

    expect(() => encodeWindowsLauncherScript({ format: "cmd", content })).toThrow(
      /remaps ASCII syntax/,
    );
  });

  it("round-trips cmd content whose GBK bytes are also valid UTF-8 (隆 -> C2 A1 -> ¡)", () => {
    resolveWindowsOemEncodingMock.mockReturnValue("gbk");
    // Verify the trap on this iconv build: valid UTF-8, wrong string, no U+FFFD.
    const collisionBytes = iconv.encode("隆", "gbk");
    expect(collisionBytes.toString("utf8")).not.toBe("隆");
    expect(collisionBytes.toString("utf8")).not.toContain(REPLACEMENT_CHAR);

    const content = `@echo off\r\ncd /d "C:\\Users\\隆\\.openclaw"\r\nnode gateway.js\r\n`;
    const encoded = encodeWindowsLauncherScript({ format: "cmd", content });

    expect(encoded.equals(iconv.encode(GBK_MARKER + content, "gbk"))).toBe(true);
    // Locks the regression: a raw UTF-8 readback of these bytes decodes
    // cleanly (no replacement char) yet corrupts the path — the pre-marker bug.
    expect(encoded.toString("utf8")).not.toContain(REPLACEMENT_CHAR);
    expect(encoded.toString("utf8")).not.toContain("隆");
    expect(decodeWindowsLauncherScript({ buffer: encoded })).toBe(content);
  });

  it("encodes cp949 extension syllables", () => {
    resolveWindowsOemEncodingMock.mockReturnValue("euc-kr");
    // Windows code page 949 is cp949/UHC; "똠" (8C 63) is a UHC extension syllable.
    // Verify the same iconv codec used by the launcher instead of runtime-specific ICU behavior.
    const extensionBytes = iconv.encode("똠", "euc-kr");
    expect(iconv.decode(extensionBytes, "euc-kr")).toBe("똠");

    const content = `@echo off\r\ncd /d "C:\\Users\\똠이\\.openclaw"\r\nnode gateway.js\r\n`;
    const encoded = encodeWindowsLauncherScript({ format: "cmd", content });

    expect(encoded.equals(iconv.encode(EUC_KR_MARKER + content, "euc-kr"))).toBe(true);
    expect(decodeWindowsLauncherScript({ buffer: encoded })).toBe(content);
  });

  it("encodes Turkish profile paths with the cp857 OEM page cmd.exe reads (#108774)", () => {
    resolveWindowsOemEncodingMock.mockReturnValue("cp857");
    const content = `@echo off\r\ncd /d "C:\\Users\\Yiğit Öğün\\.openclaw"\r\nnode gateway.js\r\n`;
    const encoded = encodeWindowsLauncherScript({ format: "cmd", content });

    expect(encoded.equals(Buffer.from(content, "utf8"))).toBe(false);
    expect(encoded.equals(iconv.encode(CP857_MARKER + content, "cp857"))).toBe(true);
    expect(decodeWindowsLauncherScript({ buffer: encoded })).toBe(content);
  });

  it("fails closed when no OEM code page is available", () => {
    const content = `@echo off\r\ncd /d "C:\\Users\\苗振"\r\n`;

    expect(() => encodeWindowsLauncherScript({ format: "cmd", content })).toThrow(
      /OEM code page is unavailable or unsupported/,
    );
  });

  it("allows only Windows-1258 content that round-trips exactly", () => {
    resolveWindowsOemEncodingMock.mockReturnValue("windows-1258");
    const supported = '@echo off\r\ncd /d "C:\\Users\\Đăng"\r\n';
    const unsupported = '@echo off\r\ncd /d "C:\\Users\\Việt"\r\n';
    const decomposed = '@echo off\r\ncd /d "C:\\Users\\e\u0323"\r\n';

    expect(
      decodeWindowsLauncherScript({
        buffer: encodeWindowsLauncherScript({ format: "cmd", content: supported }),
      }),
    ).toBe(supported);
    expect(() => encodeWindowsLauncherScript({ format: "cmd", content: unsupported })).toThrow(
      /cannot be represented/,
    );
    expect(() => encodeWindowsLauncherScript({ format: "cmd", content: decomposed })).toThrow(
      /cannot be represented/,
    );
  });
});

describe("decodeWindowsLauncherScript", () => {
  it("strips the UTF-16 LE BOM and decodes vbs scripts", () => {
    const content = `CreateObject("WScript.Shell").Run """${CJK_SCRIPT_PATH}""", 0, False\r\n`;
    const buffer = encodeWindowsLauncherScript({ format: "vbs", content });

    expect(buffer.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]));
    expect(buffer.subarray(2).toString("utf16le")).toBe(content);
    expect(decodeWindowsLauncherScript({ buffer })).toBe(content);
  });

  it("falls back to UTF-8 for marker labels iconv cannot decode", () => {
    const content = "@rem openclaw-launcher-encoding=bogus\r\nnode gateway.js\r\n";
    const buffer = Buffer.from(content, "utf8");

    expect(decodeWindowsLauncherScript({ buffer })).toBe(content);
  });
});
