import iconv from "iconv-lite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  decodeWindowsLauncherScript,
  encodeWindowsLauncherScript,
} from "./windows-launcher-encoding.js";

const { encoding, codePage } = vi.hoisted(() => ({
  encoding: vi.fn((): string | null => null),
  codePage: vi.fn((): number | null => null),
}));

vi.mock("./windows-encoding.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./windows-encoding.js")>()),
  resolveWindowsOemCodePage: codePage,
  resolveWindowsOemEncoding: encoding,
}));

const cmd = (name: string) =>
  `@echo off\r\ncd /d "C:\\Users\\${name}\\.openclaw"\r\nnode gateway.js\r\n`;
const encodeCmd = (content: string) => encodeWindowsLauncherScript({ format: "cmd", content });
const decode = (buffer: Buffer) => decodeWindowsLauncherScript({ buffer });
function roundTrip(name: string, label: string, page: number) {
  encoding.mockReturnValue(label);
  const content = cmd(name);
  const encoded = encodeCmd(content);
  const marker = `@chcp ${page} >nul\r\n@rem openclaw-launcher-encoding=${label}\r\n`;
  expect(encoded).toEqual(iconv.encode(marker + content, label));
  expect(decode(encoded)).toBe(content);
}

beforeEach(() => {
  encoding.mockReset().mockReturnValue(null);
  codePage.mockReset().mockReturnValue(437);
});

afterEach(() => vi.restoreAllMocks());

it("fails closed for ASCII cmd syntax on OEMCP 864", () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  codePage.mockReturnValue(864);
  expect(() => encodeCmd("@echo off\r\necho %PATH%\r\n")).toThrow(/remaps ASCII syntax/);
});

it.each([
  ["隆", "gbk", 936], // Valid UTF-8 bytes must still decode as GBK.
  ["똠이", "euc-kr", 949], // CP949 extensions are absent from ICU's KS X 1001 decoder.
  ["Yiğit Öğün", "cp857", 857], // Turkish OEM paths (#108774).
] as const)("round-trips %s using %s", roundTrip);

it("fails closed when no OEM code page is available", () => {
  expect(() => encodeCmd(cmd("苗振"))).toThrow(/OEM code page is unavailable or unsupported/);
});

it("allows only Windows-1258 content that round-trips exactly", () => {
  encoding.mockReturnValue("windows-1258");
  const supported = cmd("Đăng");
  expect(decode(encodeCmd(supported))).toBe(supported);
  expect(() => encodeCmd(cmd("Việt"))).toThrow(/cannot be represented/);
  expect(() => encodeCmd(cmd("e\u0323"))).toThrow(/cannot be represented/);
});

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
  expect(decode(Buffer.from(content, "utf8"))).toBe(content);
});
