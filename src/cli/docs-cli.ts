import { asNonArrayRecord } from "@openclaw/normalization-core/record-coerce";
import type { Command } from "commander";
import { formatDocsLink } from "../../packages/terminal-core/src/links.js";
import { isRich, theme } from "../../packages/terminal-core/src/theme.js";
import { readResponseWithLimit } from "../infra/http-body.js";
import { defaultRuntime, writeRuntimeJson } from "../runtime.js";
import { runCommandWithRuntime } from "./cli-utils.js";
import { formatCliCommand } from "./command-format.js";
import { formatDocsHelp } from "./help-format.js";
import { parseStrictPositiveIntOption } from "./program/helpers.js";

const SEARCH_API = "https://docs.openclaw.ai/api/search";
const SEARCH_TIMEOUT_MS = 30_000;
const DOCS_SEARCH_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;

type DocResult = {
  title: string;
  link: string;
  snippet?: string;
};

function escapeMarkdown(text: string): string {
  return text.replace(/[()[\]]/g, "\\$&");
}

async function fetchDocsSearch(query: string): Promise<DocResult[]> {
  const url = new URL(SEARCH_API);
  url.searchParams.set("q", query);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      // A retained capture clone can keep cancellation pending until peer EOF.
      // Request cancellation, then let this request owner abort transport in finally.
      void response.body?.cancel().catch(() => undefined);
      throw new Error(`HTTP ${response.status}`);
    }
    const bytes = await readResponseWithLimit(response, DOCS_SEARCH_RESPONSE_MAX_BYTES, {
      onOverflow: ({ maxBytes }) => new Error(`Docs search response exceeds ${maxBytes} bytes`),
    });
    let payload: Record<string, unknown>;
    try {
      payload = asNonArrayRecord(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      );
    } catch (cause) {
      throw new Error("Docs search response is malformed JSON", { cause });
    }
    const raw = payload.results;
    if (!Array.isArray(raw)) {
      throw new Error("Docs search response is malformed: expected results array");
    }
    const results: DocResult[] = [];
    for (const item of raw) {
      const entry = asNonArrayRecord(item);
      if (typeof entry.title !== "string" || typeof entry.link !== "string") {
        continue;
      }
      results.push({
        title: entry.title,
        link: entry.link,
        snippet:
          typeof entry.snippet === "string" && entry.snippet.trim() ? entry.snippet : undefined,
      });
    }
    return results;
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

export function registerDocsCli(program: Command) {
  program
    .command("docs")
    .description("Search the live OpenClaw docs")
    .argument("[query...]", "Search query")
    .option("--json", "Output JSON", false)
    .option("--limit <count>", "Maximum results to return", (value: string) =>
      parseStrictPositiveIntOption(value, "--limit"),
    )
    .addHelpText("after", () => formatDocsHelp("/cli/docs"))
    .action(async (queryParts: string[], opts: { json?: boolean; limit?: number }) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { json, limit } = opts;
        const query = queryParts.join(" ").trim();
        if (!query) {
          if (json) {
            writeRuntimeJson(defaultRuntime, {
              query: null,
              url: "https://docs.openclaw.ai/",
              results: [],
            });
            return;
          }
          const docs = formatDocsLink("/", "docs.openclaw.ai");
          if (isRich()) {
            defaultRuntime.log(`${theme.muted("Docs:")} ${docs}`);
            defaultRuntime.log(
              `${theme.muted("Search:")} ${formatCliCommand('openclaw docs "your query"')}`,
            );
          } else {
            defaultRuntime.log("Docs: https://docs.openclaw.ai/");
            defaultRuntime.log(`Search: ${formatCliCommand('openclaw docs "your query"')}`);
          }
          return;
        }

        let results: DocResult[];
        try {
          results = await fetchDocsSearch(query);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`Docs search failed: ${message}`, { cause: error });
        }
        if (limit !== undefined) {
          results = results.slice(0, limit);
        }

        if (json) {
          writeRuntimeJson(defaultRuntime, { query, results });
          return;
        }

        if (isRich()) {
          defaultRuntime.log(`${theme.heading("Docs search:")} ${theme.info(query)}`);
          if (results.length === 0) {
            defaultRuntime.log(theme.muted("No results."));
            return;
          }
          for (const item of results) {
            const link = formatDocsLink(item.link, item.link.replace(/^https?:\/\//i, ""));
            defaultRuntime.log(
              `${theme.muted("-")} ${theme.command(item.title)} ${theme.muted("(")}${link}${theme.muted(")")}`,
            );
            if (item.snippet) {
              defaultRuntime.log(`  ${theme.muted(item.snippet)}`);
            }
          }
          return;
        }
        const lines: string[] = [`# Docs search: ${escapeMarkdown(query)}`, ""];
        if (results.length === 0) {
          lines.push("_No results._");
        }
        for (const item of results) {
          const title = escapeMarkdown(item.title);
          const snippet = item.snippet ? escapeMarkdown(item.snippet) : "";
          const suffix = snippet ? ` - ${snippet}` : "";
          lines.push(`- [${title}](${item.link})${suffix}`);
        }
        defaultRuntime.log(lines.join("\n").trimEnd());
      });
    });
}
