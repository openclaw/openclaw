import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

export function isForbiddenBrowserProxyMutation(params: unknown): boolean {
  if (!params || typeof params !== "object") {
    return false;
  }
  const candidate = params as { method?: unknown; path?: unknown };
  const method = normalizeOptionalString(candidate.method)?.toUpperCase();
  const path = normalizeOptionalString(candidate.path);
  if (!method || !path) {
    return false;
  }
  const withLeadingSlash = path.startsWith("/") ? path : `/${path}`;
  const normalizedPath =
    withLeadingSlash.length <= 1 ? withLeadingSlash : withLeadingSlash.replace(/\/+$/, "");
  if (
    method === "POST" &&
    (normalizedPath === "/profiles/create" || normalizedPath === "/reset-profile")
  ) {
    return true;
  }
  return method === "DELETE" && /^\/profiles\/[^/]+$/.test(normalizedPath);
}
