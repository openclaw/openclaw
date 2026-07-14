/** Encodes and decodes generated Windows launcher scripts (gateway.cmd / gateway.vbs). */
import iconv from "iconv-lite";
import {
  decodeWindowsTextFileBuffer,
  resolveWindowsSystemEncoding,
} from "../infra/windows-encoding.js";

type WindowsLauncherScriptFormat = "cmd" | "vbs";

const UTF16LE_BOM = Buffer.from([0xff, 0xfe]);

// cmd.exe decodes batch files with the console OEM code page, which matches the
// ANSI code page only on these locales. windows-125x hosts pair ANSI with a
// separate OEM page (437/850/852/866/...) that WHATWG decoders cannot model, so
// non-ASCII cmd content stays UTF-8 there instead of guessing wrong bytes.
const CMD_CONSOLE_SAFE_ENCODINGS = new Set([
  "gbk",
  "big5",
  "shift_jis",
  "euc-kr",
  "gb18030",
  "windows-874",
]);

function isAsciiOnly(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0x7f) {
      return false;
    }
  }
  return true;
}

/**
 * wscript.exe reads .vbs only as ANSI or UTF-16 LE with BOM, and cmd.exe reads
 * .cmd in the console code page; plain UTF-8 garbles CJK profile paths into
 * "file not found" launch failures (#107416). Do not simplify back to utf8.
 */
export function encodeWindowsLauncherScript(params: {
  format: WindowsLauncherScriptFormat;
  content: string;
  windowsEncoding?: string | null;
}): Buffer {
  if (params.format === "vbs") {
    // UTF-16 LE with BOM is the one wscript encoding that works on every locale.
    return Buffer.concat([UTF16LE_BOM, Buffer.from(params.content, "utf16le")]);
  }
  if (isAsciiOnly(params.content)) {
    // ASCII bytes are identical in UTF-8 and every Windows code page; keep the
    // legacy byte-for-byte output so non-CJK installs see no change.
    return Buffer.from(params.content, "utf8");
  }
  const encoding =
    params.windowsEncoding !== undefined ? params.windowsEncoding : resolveWindowsSystemEncoding();
  if (!encoding || !CMD_CONSOLE_SAFE_ENCODINGS.has(encoding) || !iconv.encodingExists(encoding)) {
    return Buffer.from(params.content, "utf8");
  }
  const encoded = iconv.encode(params.content, encoding);
  // iconv-lite substitutes "?" for unmappable characters, which would silently
  // corrupt paths; verify with the same decoder the read path uses and fail the
  // install before any launcher file is written.
  if (new TextDecoder(encoding).decode(encoded) !== params.content) {
    throw new Error(
      `Windows ${params.format} launcher script contains characters that cannot be represented in the Windows system code page (${encoding}); cmd.exe would misread the script. Remove those characters or switch Windows to UTF-8 (code page 65001).`,
    );
  }
  return encoded;
}

/** Decodes launcher scripts written by any OpenClaw version (UTF-16 LE BOM, UTF-8, or ANSI). */
export function decodeWindowsLauncherScript(params: {
  buffer: Buffer;
  windowsEncoding?: string | null;
}): string {
  if (params.buffer.length >= 2 && params.buffer[0] === 0xff && params.buffer[1] === 0xfe) {
    return params.buffer.subarray(2).toString("utf16le");
  }
  // Valid UTF-8 first: covers ASCII and pre-fix UTF-8 installs without paying
  // for code page detection on frequent readScheduledTaskCommand polls.
  const utf8 = params.buffer.toString("utf8");
  if (!utf8.includes("\uFFFD")) {
    return utf8;
  }
  const encoding =
    params.windowsEncoding !== undefined ? params.windowsEncoding : resolveWindowsSystemEncoding();
  // Launcher files are Windows artifacts no matter which host runs this code,
  // so pin the platform instead of letting the decoder no-op off-Windows.
  return decodeWindowsTextFileBuffer({
    buffer: params.buffer,
    platform: "win32",
    windowsEncoding: encoding ?? "utf-8",
  });
}
