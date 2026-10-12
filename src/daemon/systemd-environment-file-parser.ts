/** Native systemd EnvironmentFile value decoding; no filesystem or service access. */
import { isUnresolvedShellReference } from "../config/state-dir-dotenv.js";

function decodeSystemdEnvironmentFileValue(rawValue: string) {
  type ParseState =
    | "pre"
    | "unquoted"
    | "unquoted-escape"
    | "single-quoted"
    | "double-quoted"
    | "double-quoted-escape";

  // Match systemd parse_env_file_internal: closing quotes return to pre ("foo"bar -> foobar).
  let state: ParseState = "pre";
  let decoded = "";
  let literalDollar = false;
  let trailingWhitespaceStart: number | undefined;
  for (const char of rawValue) {
    const whitespace = char === " " || char === "\t" || char === "\r";
    if (state === "pre") {
      if (whitespace) {
        continue;
      }
      if (char === "'" || char === '"') {
        state = char === "'" ? "single-quoted" : "double-quoted";
        continue;
      }
      if (char === "\\") {
        state = "unquoted-escape";
        continue;
      }
      state = "unquoted";
      decoded += char;
      continue;
    }
    if (state === "unquoted") {
      if (char === "\\") {
        state = "unquoted-escape";
        trailingWhitespaceStart = undefined;
        continue;
      }
      if (whitespace) {
        trailingWhitespaceStart ??= decoded.length;
      } else {
        trailingWhitespaceStart = undefined;
      }
      decoded += char;
      continue;
    }
    if (state === "single-quoted" || state === "double-quoted") {
      const quote = state === "single-quoted" ? "'" : '"';
      if (char === quote) {
        state = "pre";
      } else if (state === "double-quoted" && char === "\\") {
        state = "double-quoted-escape";
      } else {
        literalDollar ||= char === "$";
        decoded += char;
      }
      continue;
    }
    const doubleQuoted: boolean = state === "double-quoted-escape";
    state = doubleQuoted ? "double-quoted" : "unquoted";
    if (doubleQuoted && !['"', "\\", "`", "$"].includes(char)) {
      decoded += "\\";
    }
    literalDollar ||= char === "$";
    decoded += char;
  }
  if (state === "unquoted" && trailingWhitespaceStart !== undefined) {
    decoded = decoded.slice(0, trailingWhitespaceStart);
  }
  return { value: decoded, literalDollar };
}

export function parseSystemdEnvironmentFileLine(rawLine: string) {
  const trimmedStart = rawLine.trimStart();
  if (!trimmedStart || trimmedStart.startsWith("#") || trimmedStart.startsWith(";")) {
    return null;
  }
  const eq = trimmedStart.indexOf("=");
  if (eq <= 0) {
    return null;
  }
  const key = trimmedStart.slice(0, eq).trim();
  const decoded = decodeSystemdEnvironmentFileValue(trimmedStart.slice(eq + 1));
  return {
    key,
    value: decoded.value,
    literalShellReference: decoded.literalDollar && isUnresolvedShellReference(decoded.value),
  };
}
