import { containsAsciiControlCharacter } from "@openclaw/normalization-core/string-normalization";
import { parseControlUiSessionPath } from "@openclaw/session-url-contract/parse";

// Navigation hints are carried to the app; only the pathname selects the session.
const RETURN_PATH_QUERY_VALIDATORS = new Map<string, (value: string) => boolean>([
  ["dashboard", (value) => value === "expanded"],
  ["draft", () => true],
  ["openclaw_mount_recovery", (value) => /^[0-9]+$/u.test(value)],
  ["__openclawSessionFacePreference", (value) => value === "1"],
  ["__openclawComposerFocus", (value) => value === "1"],
  ["__openclawSessionKey", (value) => Boolean(value.trim())],
]);

export function controlUiSessionEntryPath(basePath: string): string {
  return `${basePath}/__openclaw__/session-entry`;
}

/** Return paths are local chat documents, never URLs, API paths, or credential carriers. */
export function parseControlUiSessionReturnPath(value: string, basePath: string) {
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    containsAsciiControlCharacter(value) ||
    /[\\ #]/u.test(value)
  ) {
    return null;
  }
  const url = URL.parse(value, "http://localhost");
  if (
    !url ||
    `${url.pathname}${url.search}` !== value ||
    [...url.searchParams].some(
      ([key, queryValue]) =>
        url.searchParams.getAll(key).length > 1 ||
        !RETURN_PATH_QUERY_VALIDATORS.get(key)?.(queryValue),
    )
  ) {
    return null;
  }
  const target = parseControlUiSessionPath(url.pathname, basePath);
  return target?.namespace === "chat" ? target : null;
}

export function buildControlUiSessionEntryUrl(path: string, basePath: string): string {
  return `${controlUiSessionEntryPath(basePath)}?${new URLSearchParams({ path })}`;
}
