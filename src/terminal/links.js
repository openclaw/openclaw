import { formatTerminalLink } from "../utils.js";
export const DOCS_ROOT = "https://docs.openclaw.ai";
export function formatDocsLink(path, label, opts) {
    const trimmed = path.trim();
    const url = trimmed.startsWith("http")
        ? trimmed
        : `${DOCS_ROOT}${trimmed.startsWith("/") ? trimmed : `/${trimmed}`}`;
    return formatTerminalLink(label ?? url, url, {
        fallback: opts?.fallback ?? url,
        force: opts?.force,
    });
}
export function formatDocsRootLink(label) {
    return formatTerminalLink(label ?? DOCS_ROOT, DOCS_ROOT, {
        fallback: DOCS_ROOT,
    });
}
