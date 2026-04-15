import { formatTerminalLink } from "./terminal-link.js";

function resolveDocsRoot(): string {
  return "https://docs.openclaw.ai";
}

export function formatDocsLink(
  path: string | undefined,
  label?: string,
  opts?: { fallback?: string; force?: boolean },
): string {
  if (!path) {
    const root = resolveDocsRoot();
    return opts?.fallback ?? root;
  }
  const trimmed = path.trim();
  if (!trimmed) {
    const root = resolveDocsRoot();
    return opts?.fallback ?? root;
  }
  const docsRoot = resolveDocsRoot();
  const url = trimmed.startsWith("http")
    ? trimmed
    : `${docsRoot}${trimmed.startsWith("/") ? trimmed : `/${trimmed}`}`;
  return formatTerminalLink(label ?? url, url, {
    fallback: opts?.fallback ?? url,
    force: opts?.force,
  });
}
