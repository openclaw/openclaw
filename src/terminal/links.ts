import { isClaworksCliProduct } from "../cli/cli-name.js";
import { resolveProductDocUrl } from "../cli/product-surface.js";
import { formatTerminalLink } from "./terminal-link.js";

function resolveDocsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return resolveProductDocUrl("", env);
}

function productizeDocsLinkLabel(
  label: string | undefined,
  url: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!label || !isClaworksCliProduct(env)) {
    return label;
  }
  if (label.includes("docs.openclaw.ai")) {
    return label.replaceAll("docs.openclaw.ai", new URL(url).host);
  }
  return label;
}

export function formatDocsLink(
  path: string | undefined | null,
  label?: string,
  opts?: { fallback?: string; force?: boolean; env?: NodeJS.ProcessEnv },
): string {
  const env = opts?.env ?? process.env;
  const docsRoot = resolveDocsRoot(env);
  const trimmed = typeof path === "string" ? path.trim() : "";
  // When a caller has no docsPath, link to the docs root rather than crashing
  // the onboarding/channel-selection flows that pass meta.docsPath through
  // here unguarded. The typed contract says docsPath is required, but a
  // handful of channel plugins and catalog rows leave it unset at runtime.
  const url = trimmed
    ? trimmed.startsWith("http")
      ? trimmed
      : `${docsRoot}${trimmed.startsWith("/") ? trimmed : `/${trimmed}`}`
    : docsRoot;
  const resolvedLabel = productizeDocsLinkLabel(label ?? url, url, env);
  return formatTerminalLink(resolvedLabel ?? url, url, {
    fallback: opts?.fallback ?? url,
    force: opts?.force,
  });
}
