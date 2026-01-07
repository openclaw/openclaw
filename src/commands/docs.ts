import { hasBinary } from "../agents/skills.js";
import { runCommandWithTimeout } from "../process/exec.js";
import type { RuntimeEnv } from "../runtime.js";

const SEARCH_TOOL = "https://docs.clawd.bot/mcp.SearchClawdbot";
const SEARCH_TIMEOUT_MS = 30_000;
const RENDER_TIMEOUT_MS = 10_000;
const DEFAULT_SNIPPET_MAX = 220;

type DocResult = {
  title: string;
  link: string;
  snippet?: string;
};

type NodeRunner = {
  cmd: string;
  args: string[];
};

type ToolRunOptions = {
  input?: string;
  timeoutMs?: number;
};

function resolveNodeRunner(): NodeRunner {
  if (hasBinary("pnpm")) return { cmd: "pnpm", args: ["dlx"] };
  if (hasBinary("npx")) return { cmd: "npx", args: ["-y"] };
  throw new Error("Missing pnpm or npx; install a Node package runner.");
}

async function runNodeTool(
  tool: string,
  toolArgs: string[],
  options: ToolRunOptions = {},
) {
  const runner = resolveNodeRunner();
  const argv = [runner.cmd, ...runner.args, tool, ...toolArgs];
  return await runCommandWithTimeout(argv, {
    timeoutMs: options.timeoutMs ?? SEARCH_TIMEOUT_MS,
    input: options.input,
  });
}

async function runTool(
  tool: string,
  toolArgs: string[],
  options: ToolRunOptions = {},
) {
  if (hasBinary(tool)) {
    return await runCommandWithTimeout([tool, ...toolArgs], {
      timeoutMs: options.timeoutMs ?? SEARCH_TIMEOUT_MS,
      input: options.input,
    });
  }
  return await runNodeTool(tool, toolArgs, options);
}

function extractLine(lines: string[], prefix: string): string | undefined {
  const line = lines.find((value) => value.startsWith(prefix));
  if (!line) return undefined;
  return line.slice(prefix.length).trim();
}

function normalizeSnippet(raw: string | undefined, fallback: string): string {
  const base = raw && raw.trim().length > 0 ? raw : fallback;
  const cleaned = base.replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  if (cleaned.length <= DEFAULT_SNIPPET_MAX) return cleaned;
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
    if (!title || !link) continue;
    const content = extractLine(lines, "Content:");
    const contentIndex = lines.findIndex((line) => line.startsWith("Content:"));
    const body =
      contentIndex >= 0 ? lines.slice(contentIndex + 1).join("\n").trim() : "";
    const snippet = normalizeSnippet(content, firstParagraph(body));
    results.push({ title, link, snippet: snippet || undefined });
  }
  return results;
}

function escapeMarkdown(text: string): string {
  return text.replace(/[\[\]()]/g, "\\$&");
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

async function renderMarkdown(markdown: string, runtime: RuntimeEnv) {
  const width = process.stdout.columns ?? 0;
  const args = width > 0 ? ["--width", String(width)] : [];
  try {
    const res = await runTool("markdansi", args, {
      timeoutMs: RENDER_TIMEOUT_MS,
      input: markdown,
    });
    if (res.code === 0 && res.stdout.trim()) {
      runtime.log(res.stdout.trimEnd());
      return;
    }
  } catch {
    // Fall back to plain Markdown if renderer fails or cannot be installed.
  }
  runtime.log(markdown.trimEnd());
}

export async function docsSearchCommand(
  queryParts: string[],
  runtime: RuntimeEnv,
) {
  const query = queryParts.join(" ").trim();
  if (!query) {
    runtime.log("Docs: https://docs.clawd.bot/");
    runtime.log('Search: clawdbot docs "your query"');
    return;
  }

  const payload = JSON.stringify({ query });
  const res = await runTool(
    "mcporter",
    ["call", SEARCH_TOOL, "--args", payload, "--output", "text"],
    { timeoutMs: SEARCH_TIMEOUT_MS },
  );

  if (res.code !== 0) {
    const err = res.stderr.trim() || res.stdout.trim() || `exit ${res.code}`;
    runtime.error(`Docs search failed: ${err}`);
    runtime.exit(1);
    return;
  }

  const results = parseSearchOutput(res.stdout);
  const markdown = buildMarkdown(query, results);
  await renderMarkdown(markdown, runtime);
}
