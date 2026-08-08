// Content-Disposition and remote filename parsing helpers extracted from
// fetch.ts to keep the media fetch module within the max-lines budget.
import { basenameFromAnyPath } from "@openclaw/media-core/file-name";

function stripQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, "");
}

function decodeRemoteFileNameComponent(value: string): string {
  try {
    return decodeURIComponent(value).replace(/[\\/]/g, "_");
  } catch {
    return value;
  }
}

function decodeExtendedRemoteFileName(value: string): string | undefined {
  const match = /^([^']*)'[^']*'(.*)$/u.exec(value);
  if (!match) {
    return undefined;
  }
  const charset = match[1]?.toLowerCase();
  const encoded = match[2] ?? "";
  try {
    if (charset === "utf-8") {
      return decodeURIComponent(encoded).replace(/[\\/]/g, "_");
    }
    if (charset === "iso-8859-1") {
      if (/%(?![\da-f]{2})/iu.test(encoded)) {
        return undefined;
      }
      return encoded
        .replace(/%([\da-f]{2})/giu, (_match, hex: string) =>
          String.fromCharCode(Number.parseInt(hex, 16)),
        )
        .replace(/[\\/]/g, "_");
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function* parseContentDispositionParameters(header: string): Generator<{
  name: string;
  value: string;
}> {
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index <= header.length; index += 1) {
    const character = header[index];
    if (escaped || (quoted && character === "\\")) {
      escaped = !escaped;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (index !== header.length && (quoted || character !== ";")) {
      continue;
    }
    const parameter = header.slice(start, index).trim();
    start = index + 1;
    const separator = parameter.indexOf("=");
    if (separator > 0) {
      yield {
        name: parameter.slice(0, separator).trim().toLowerCase(),
        value: stripQuotes(parameter.slice(separator + 1).trim()),
      };
    }
  }
}

function decodeQuotedRemoteFileName(value: string): string {
  const windowsDrivePath = /^[a-z]:[\\/]/iu.test(value);
  const windowsNetworkPath = value.startsWith("\\\\");
  const mixedWindowsPath = value.includes("/") && value.includes("\\");
  const relativeWindowsPath =
    /\\[\p{L}\p{N}]/u.test(value) && /^[^\\/:]+(?:\\[^\\]+)+$/u.test(value);
  if (!windowsDrivePath && !windowsNetworkPath && !mixedWindowsPath && !relativeWindowsPath) {
    return value.replace(/\\(.)/gu, "$1");
  }
  const lastForwardSeparator = value.lastIndexOf("/");
  if (lastForwardSeparator >= 0) {
    const prefix = value.slice(0, lastForwardSeparator + 1);
    const fileName = value.slice(lastForwardSeparator + 1).replace(/\\([^\p{L}\p{N}])/gu, "$1");
    return `${prefix}${fileName}`;
  }
  const firstBackslash = value.indexOf("\\");
  if (
    !windowsDrivePath &&
    !windowsNetworkPath &&
    firstBackslash === value.lastIndexOf("\\") &&
    /\\[^\p{L}\p{N}]/u.test(value)
  ) {
    return value.replace(/\\(.)/gu, "$1");
  }
  // Backslash-only legacy paths need every separator, including before Unicode or spaces.
  return value.replace(/\\"/gu, '"');
}

export function parseContentDispositionFileName(header?: string | null): string | undefined {
  if (!header) {
    return undefined;
  }
  let fallbackFileName: string | undefined;
  for (const parameter of parseContentDispositionParameters(header)) {
    if (parameter.name === "filename") {
      fallbackFileName ??=
        basenameFromAnyPath(decodeQuotedRemoteFileName(parameter.value)) || undefined;
      continue;
    }
    if (parameter.name !== "filename*") {
      continue;
    }
    const decoded = decodeExtendedRemoteFileName(parameter.value);
    if (decoded) {
      return basenameFromAnyPath(decoded) || undefined;
    }
  }
  return fallbackFileName;
}

export function basenameFromUrlPathname(pathname: string): string {
  const base = basenameFromAnyPath(pathname);
  if (!base) {
    return "";
  }
  return decodeRemoteFileNameComponent(base);
}
