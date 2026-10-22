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

const REPLACEMENT_CHAR = String.fromCharCode(0xfffd);
const cmd = (name: string) =>
  `@echo off\r\ncd /d "C:\\Users\\${name}\\.openclaw"\r\nnode gateway.js\r\n`;
const encodeCmd = (content: string) => encodeWindowsLauncherScript({ format: "cmd", content });
const decode = (buffer: Buffer) => decodeWindowsLauncherScript({ buffer });
function roundTrip(name: string, encoding: string, codePage: number) {
  resolveWindowsOemEncodingMock.mockReturnValue(encoding);
  const content = cmd(name);
  const encoded = encodeCmd(content);
  const marker = `@chcp ${codePage} >nul\r\n@rem openclaw-launcher-encoding=${encoding}\r\n`;
  expect(encoded).toEqual(iconv.encode(marker + content, encoding));
  expect(decode(encoded)).toBe(content);
  return encoded;
}

beforeEach(() => {
  resolveWindowsOemEncodingMock.mockReset().mockReturnValue(null);
  resolveWindowsOemCodePageMock.mockReset().mockReturnValue(437);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("encodeWindowsLauncherScript", () => {
  it("fails closed for ASCII cmd syntax on OEMCP 864", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    resolveWindowsOemCodePageMock.mockReturnValue(864);
    const content = "@echo off\r\necho %PATH%\r\n";

    expect(() => encodeCmd(content)).toThrow(/remaps ASCII syntax/);
  });

  it("round-trips cmd content whose GBK bytes are also valid UTF-8 (隆 -> C2 A1 -> ¡)", () => {
    const collisionBytes = iconv.encode("隆", "gbk");
    expect(collisionBytes.toString("utf8")).not.toBe("隆");
    expect(collisionBytes.toString("utf8")).not.toContain(REPLACEMENT_CHAR);

    // These GBK bytes are valid UTF-8 but silently corrupt the profile path.
    const encoded = roundTrip("隆", "gbk", 936);
    expect(encoded.toString("utf8")).not.toContain(REPLACEMENT_CHAR);
    expect(encoded.toString("utf8")).not.toContain("隆");
  });

  it("encodes cp949 extension syllables", () => {
    // CP949/UHC extension syllables are absent from ICU's KS X 1001 decoder.
    const extensionBytes = iconv.encode("똠", "euc-kr");
    expect(iconv.decode(extensionBytes, "euc-kr")).toBe("똠");

    roundTrip("똠이", "euc-kr", 949);
  });

  it("encodes Turkish profile paths with the cp857 OEM page cmd.exe reads (#108774)", () => {
    const encoded = roundTrip("Yiğit Öğün", "cp857", 857);
    expect(encoded.equals(Buffer.from(cmd("Yiğit Öğün"), "utf8"))).toBe(false);
  });

  it("fails closed when no OEM code page is available", () => {
    const content = `@echo off\r\ncd /d "C:\\Users\\苗振"\r\n`;

    expect(() => encodeCmd(content)).toThrow(/OEM code page is unavailable or unsupported/);
  });

  it("allows only Windows-1258 content that round-trips exactly", () => {
    resolveWindowsOemEncodingMock.mockReturnValue("windows-1258");
    const supported = '@echo off\r\ncd /d "C:\\Users\\Đăng"\r\n';
    const unsupported = '@echo off\r\ncd /d "C:\\Users\\Việt"\r\n';
    const decomposed = '@echo off\r\ncd /d "C:\\Users\\e\u0323"\r\n';

    expect(decode(encodeCmd(supported))).toBe(supported);
    expect(() => encodeCmd(unsupported)).toThrow(/cannot be represented/);
    expect(() => encodeCmd(decomposed)).toThrow(/cannot be represented/);
  });
});

describe("decodeWindowsLauncherScript", () => {
  it("strips the UTF-16 LE BOM and decodes vbs scripts", () => {
    const content =
      'CreateObject("WScript.Shell").Run """C:\\Users\\苗振\\.openclaw\\gateway.cmd""", 0, False\r\n';
    const buffer = encodeWindowsLauncherScript({ format: "vbs", content });

    expect(buffer.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]));
    expect(buffer.subarray(2).toString("utf16le")).toBe(content);
    expect(decode(buffer)).toBe(content);
  });

  it("falls back to UTF-8 for marker labels iconv cannot decode", () => {
    const content = "@rem openclaw-launcher-encoding=bogus\r\nnode gateway.js\r\n";
    const buffer = Buffer.from(content, "utf8");

    expect(decode(buffer)).toBe(content);
  });
});
