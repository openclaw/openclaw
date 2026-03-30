import { formatTerminalLink } from "./terminal-link.js";

export function resolveDocsRoot(): string {
	return "https://docs.openclaw.ai";
}

export const DOCS_ROOT = resolveDocsRoot();

export function formatDocsLink(
	path: string,
	label?: string,
	opts?: { fallback?: string; force?: boolean },
): string {
	const trimmed = path.trim();
	const docsRoot = resolveDocsRoot();
	const url = trimmed.startsWith("http")
		? trimmed
		: `${docsRoot}${trimmed.startsWith("/") ? trimmed : `/${trimmed}`}`;
	return formatTerminalLink(label ?? url, url, {
		fallback: opts?.fallback ?? url,
		force: opts?.force,
	});
}

export function formatDocsRootLink(label?: string): string {
	const docsRoot = resolveDocsRoot();
	return formatTerminalLink(label ?? docsRoot, docsRoot, {
		fallback: docsRoot,
	});
}
