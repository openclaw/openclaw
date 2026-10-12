import { containsAsciiControlCharacter } from "@openclaw/normalization-core/string-normalization";
import { parseControlUiSessionPath } from "@openclaw/session-url-contract/parse";

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
    [...url.searchParams.keys()].some(
      (key) => key !== "dashboard" && key !== "draft" && key !== "openclaw_mount_recovery",
    ) ||
    url.searchParams.getAll("openclaw_mount_recovery").length > 1 ||
    (url.searchParams.has("openclaw_mount_recovery") &&
      !/^[0-9]+$/u.test(url.searchParams.get("openclaw_mount_recovery") ?? "")) ||
    url.searchParams.getAll("draft").length > 1 ||
    url.searchParams.getAll("dashboard").length > 1 ||
    (url.searchParams.has("dashboard") && url.searchParams.get("dashboard") !== "expanded")
  ) {
    return null;
  }
  const target = parseControlUiSessionPath(url.pathname, basePath);
  return target?.namespace === "chat" ? target : null;
}

export function buildControlUiSessionEntryUrl(path: string, basePath: string): string {
  return `${controlUiSessionEntryPath(basePath)}?${new URLSearchParams({ path })}`;
}
