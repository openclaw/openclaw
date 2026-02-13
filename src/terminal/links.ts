import { formatTerminalLink } from "../utils.js";

export const DOCS_ROOT = "https://docs.openclaw.ai";

export function formatDocsLink(
  path?: string | null,
  label?: string,
  opts?: { fallback?: string; force?: boolean },
): string {
  const trimmed = path?.trim();
  if (!trimmed) {
    return formatTerminalLink(label ?? DOCS_ROOT, DOCS_ROOT, {
      fallback: opts?.fallback ?? DOCS_ROOT,
      force: opts?.force,
    });
  }
  const url = trimmed.startsWith("http")
    ? trimmed
    : `${DOCS_ROOT}${trimmed.startsWith("/") ? trimmed : `/${trimmed}`}`;
  return formatTerminalLink(label ?? url, url, {
    fallback: opts?.fallback ?? url,
    force: opts?.force,
  });
}

export function formatDocsRootLink(label?: string): string {
  return formatTerminalLink(label ?? DOCS_ROOT, DOCS_ROOT, {
    fallback: DOCS_ROOT,
  });
}
