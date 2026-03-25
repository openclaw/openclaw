import { formatCliCommand } from "../cli/command-format.js";
import type { RuntimeEnv } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { isRich, theme } from "../terminal/theme.js";

const SEARCH_MCP_URL = "https://docs.openclaw.ai/mcp";
const SEARCH_TOOL_NAME = "SearchOpenClaw";
const SEARCH_TIMEOUT_MS = 30_000;
const DEFAULT_SNIPPET_MAX = 220;

function extractLine(lines: string[], prefix: string): string | undefined {
  const line = lines.find((value) => value.startsWith(prefix));
  if (!line) {
    return undefined;
  }
  return line.slice(prefix.length).trim();
}

function normalizeSnippet(raw: string | undefined, fallback: string): string {
  const base = raw && raw.trim().length > 0 ? raw : fallback;
  const cleaned = base.replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return "";
  }
  if (cleaned.length <= DEFAULT_SNIPPET_MAX) {
    return cleaned;
  }
  return `${cleaned.slice(0, DEFAULT_SNIPPET_MAX - 3)}...`;
}

function firstParagraph(text: string): string {
  const parts = text
    .split(/\n\s*\n/)
    .map((chunk) => chunk.trim())
    .filter(Boolean);
  return parts[0] ?? "";
}

function parseSearchOutput(raw: string): DocResult[] {
  const normalized = raw.replace(/\r/g, "");
  const blocks = normalized
    .split(/\n(?=Title: )/g)
    .map((chunk) => chunk.trim())
    .filter(Boolean);

  const results: DocResult[] = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    const title = extractLine(lines, "Title:");
    const link = extractLine(lines, "Link:");
    if (!title || !link) {
      continue;
    }
    const content = extractLine(lines, "Content:");
    const contentIndex = lines.findIndex((line) => line.startsWith("Content:"));
    const body =
      contentIndex >= 0
        ? lines
            .slice(contentIndex + 1)
            .join("\n")
            .trim()
        : "";
    const snippet = normalizeSnippet(content, firstParagraph(body));
    results.push({ title, link, snippet: snippet || undefined });
  }
  return results;
}

function escapeMarkdown(text: string): string {
  return text.replace(/[()[\]]/g, "\\$&");
}

function buildMarkdown(query: string, results: DocResult[]): string {
  const lines: string[] = [`# Docs search: ${escapeMarkdown(query)}`, ""];
  if (results.length === 0) {
    lines.push("_No results._");
    return lines.join("\n");
  }
  for (const item of results) {
    const title = escapeMarkdown(item.title);
    const snippet = item.snippet ? escapeMarkdown(item.snippet) : "";
    const suffix = snippet ? ` - ${snippet}` : "";
    lines.push(`- [${title}](${item.link})${suffix}`);
  }
  return lines.join("\n");
}

function formatLinkLabel(link: string): string {
  return link.replace(/^https?:\/\//i, "");
}

function renderRichResults(query: string, results: DocResult[], runtime: RuntimeEnv) {
  runtime.log(`${theme.heading("Docs search:")} ${theme.info(query)}`);
  if (results.length === 0) {
    runtime.log(theme.muted("No results."));
    return;
  }
  for (const item of results) {
    const linkLabel = formatLinkLabel(item.link);
    const link = formatDocsLink(item.link, linkLabel);
    runtime.log(
      `${theme.muted("-")} ${theme.command(item.title)} ${theme.muted("(")}${link}${theme.muted(")")}`,
    );
    if (item.snippet) {
      runtime.log(`  ${theme.muted(item.snippet)}`);
    }
  }
}

async function renderMarkdown(markdown: string, runtime: RuntimeEnv) {
  runtime.log(markdown.trimEnd());
}

export async function docsSearchCommand(queryParts: string[], runtime: RuntimeEnv) {
  const query = queryParts.join(" ").trim();
  if (!query) {
    const docs = formatDocsLink("/", "docs.openclaw.ai");
    if (isRich()) {
      runtime.log(`${theme.muted("Docs:")} ${docs}`);
      runtime.log(`${theme.muted("Search:")} ${formatCliCommand('openclaw docs "your query"')}`);
    } else {
      runtime.log("Docs: https://docs.openclaw.ai/");
      runtime.log(`Search: ${formatCliCommand('openclaw docs "your query"')}`);
    }
    return;
  }

  // Call the docs MCP search endpoint directly via native HTTP (no mcporter dependency).
  let rawOutput: string;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
    try {
      const response = await fetch(SEARCH_MCP_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: SEARCH_TOOL_NAME, arguments: { query } },
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const json = (await response.json()) as {
        result?: { content?: Array<{ type: string; text?: string }> };
        error?: { message?: string };
      };
      if (json.error) {
        throw new Error(json.error.message ?? "MCP error");
      }
      const textParts = (json.result?.content ?? [])
        .filter((c) => c.type === "text" && c.text)
        .map((c) => c.text as string);
      rawOutput = textParts.join("\n");
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    runtime.error(`Docs search failed: ${msg}`);
    runtime.exit(1);
    return;
  }

  const results = parseSearchOutput(rawOutput);
  if (isRich()) {
    renderRichResults(query, results, runtime);
    return;
  }
  const markdown = buildMarkdown(query, results);
  await renderMarkdown(markdown, runtime);
}
