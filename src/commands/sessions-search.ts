import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

import { resolveStateDir } from "../config/paths.js";
import { info } from "../globals.js";
import type { RuntimeEnv } from "../runtime.js";
import { isRich, theme } from "../terminal/theme.js";

export type SessionSearchOptions = {
  query: string;
  agent?: string;
  channel?: string;
  since?: string;
  limit?: number;
  json?: boolean;
  bookmarks?: boolean;
};

type SearchResult = {
  file: string;
  agentId: string;
  sessionKey: string;
  line: number;
  role: string;
  content: string;
  timestamp?: string;
  channel?: string;
  bookmarked?: boolean;
};

const BOOKMARKS_FILENAME = "bookmarks.json";

function resolveBookmarksPath(stateDir: string): string {
  return path.join(stateDir, BOOKMARKS_FILENAME);
}

export function loadBookmarks(stateDir: string): Set<string> {
  const bookmarksPath = resolveBookmarksPath(stateDir);
  try {
    const raw = fs.readFileSync(bookmarksPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return new Set(parsed as string[]);
  } catch {
    // no bookmarks file yet
  }
  return new Set();
}

export async function saveBookmarks(stateDir: string, bookmarks: Set<string>): Promise<void> {
  const bookmarksPath = resolveBookmarksPath(stateDir);
  await fs.promises.mkdir(path.dirname(bookmarksPath), { recursive: true });
  await fs.promises.writeFile(bookmarksPath, JSON.stringify([...bookmarks], null, 2), "utf-8");
}

async function searchTranscriptFile(
  filePath: string,
  query: string,
  sinceMs: number | null,
  channelFilter: string | null,
): Promise<SearchResult[]> {
  const results: SearchResult[] = [];
  const lowerQuery = query.toLowerCase();
  const parts = filePath.split(path.sep);
  // Path: .../agents/<agentId>/sessions/<sessionKey>.jsonl
  const agentsIdx = parts.lastIndexOf("agents");
  const agentId = agentsIdx >= 0 && parts[agentsIdx + 1] ? parts[agentsIdx + 1] : "unknown";
  const basename = path.basename(filePath, ".jsonl");

  let lineNum = 0;
  const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

  for await (const line of rl) {
    lineNum++;
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      const role = String(entry.role ?? "unknown");
      const content = extractContent(entry);
      if (!content) continue;

      // Filter by timestamp
      if (sinceMs !== null) {
        const ts = entry.timestamp ?? entry.ts ?? entry.createdAt;
        if (typeof ts === "number" && ts < sinceMs) continue;
        if (typeof ts === "string") {
          const tsMs = new Date(ts).getTime();
          if (!Number.isNaN(tsMs) && tsMs < sinceMs) continue;
        }
      }

      // Filter by channel
      if (channelFilter) {
        const ch = String(entry.channel ?? entry.provider ?? "");
        if (ch && !ch.toLowerCase().includes(channelFilter.toLowerCase())) continue;
      }

      // Full-text match
      if (content.toLowerCase().includes(lowerQuery)) {
        results.push({
          file: filePath,
          agentId,
          sessionKey: basename,
          line: lineNum,
          role,
          content,
          timestamp: resolveTimestamp(entry),
          channel: String(entry.channel ?? entry.provider ?? ""),
        });
      }
    } catch {
      // skip unparseable lines
    }
  }

  return results;
}

function extractContent(entry: Record<string, unknown>): string {
  if (typeof entry.content === "string") return entry.content;
  if (Array.isArray(entry.content)) {
    return (entry.content as Array<Record<string, unknown>>)
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block.text === "string") return block.text;
        return "";
      })
      .filter(Boolean)
      .join(" ");
  }
  if (typeof entry.body === "string") return entry.body;
  if (typeof entry.text === "string") return entry.text;
  return "";
}

function resolveTimestamp(entry: Record<string, unknown>): string | undefined {
  const ts = entry.timestamp ?? entry.ts ?? entry.createdAt;
  if (typeof ts === "string") return ts;
  if (typeof ts === "number") return new Date(ts).toISOString();
  return undefined;
}

function parseSince(since: string): number | null {
  // Support formats: "1h", "2d", "30m", "2024-01-01", ISO date strings
  const match = since.match(/^(\d+)([mhd])$/);
  if (match) {
    const value = Number.parseInt(match[1], 10);
    const unit = match[2];
    const now = Date.now();
    if (unit === "m") return now - value * 60_000;
    if (unit === "h") return now - value * 3_600_000;
    if (unit === "d") return now - value * 86_400_000;
  }
  const parsed = new Date(since).getTime();
  if (!Number.isNaN(parsed)) return parsed;
  return null;
}

function truncateContent(content: string, maxLen = 120): string {
  if (content.length <= maxLen) return content;
  return `${content.slice(0, maxLen)}...`;
}

async function findTranscriptFiles(sessionsDir: string): Promise<string[]> {
  const files: string[] = [];
  try {
    const entries = await fs.promises.readdir(sessionsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(path.join(sessionsDir, entry.name));
      }
    }
  } catch {
    // dir doesn't exist
  }
  return files;
}

async function findAllTranscriptFiles(stateDir: string, agentFilter?: string): Promise<string[]> {
  const agentsDir = path.join(stateDir, "agents");
  const allFiles: string[] = [];

  try {
    const agents = await fs.promises.readdir(agentsDir, { withFileTypes: true });
    for (const agentEntry of agents) {
      if (!agentEntry.isDirectory()) continue;
      if (agentFilter && agentEntry.name !== agentFilter) continue;
      const sessionsDir = path.join(agentsDir, agentEntry.name, "sessions");
      const files = await findTranscriptFiles(sessionsDir);
      allFiles.push(...files);
    }
  } catch {
    // agents dir doesn't exist
  }

  return allFiles;
}

export async function sessionsSearchCommand(
  opts: SessionSearchOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const stateDir = resolveStateDir();
  const sinceMs = opts.since ? parseSince(opts.since) : null;
  const limit = opts.limit ?? 50;
  const bookmarks = loadBookmarks(stateDir);

  if (opts.bookmarks) {
    // List bookmarked messages
    if (bookmarks.size === 0) {
      runtime.log("No bookmarked messages.");
      return;
    }
    if (opts.json) {
      runtime.log(JSON.stringify([...bookmarks], null, 2));
    } else {
      runtime.log(info("Bookmarked messages:"));
      for (const bm of bookmarks) {
        runtime.log(`  ${bm}`);
      }
    }
    return;
  }

  const files = await findAllTranscriptFiles(stateDir, opts.agent);
  if (files.length === 0) {
    runtime.log("No session transcripts found.");
    return;
  }

  const allResults: SearchResult[] = [];
  for (const file of files) {
    if (allResults.length >= limit) break;
    const results = await searchTranscriptFile(file, opts.query, sinceMs, opts.channel ?? null);
    for (const r of results) {
      r.bookmarked = bookmarks.has(`${r.agentId}:${r.sessionKey}:${r.line}`);
      allResults.push(r);
      if (allResults.length >= limit) break;
    }
  }

  if (opts.json) {
    runtime.log(
      JSON.stringify(
        {
          query: opts.query,
          count: allResults.length,
          limit,
          results: allResults.map((r) => ({
            agentId: r.agentId,
            sessionKey: r.sessionKey,
            line: r.line,
            role: r.role,
            content: r.content,
            timestamp: r.timestamp,
            channel: r.channel,
            bookmarked: r.bookmarked,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  runtime.log(info(`Search: "${opts.query}" across ${files.length} transcript(s)`));
  runtime.log(info(`Found: ${allResults.length} result(s) (limit: ${limit})`));

  if (allResults.length === 0) {
    runtime.log("No matches found.");
    return;
  }

  const rich = isRich();
  for (const result of allResults) {
    const bookmark = result.bookmarked ? " *" : "";
    const ts = result.timestamp ? ` ${result.timestamp}` : "";
    const ch = result.channel ? ` [${result.channel}]` : "";
    const header = `${result.agentId}/${result.sessionKey}:${result.line}${ch}${ts}${bookmark}`;
    const content = truncateContent(result.content.replaceAll("\n", " "));

    if (rich) {
      runtime.log(`${theme.accent(header)}`);
      runtime.log(`  ${theme.muted(result.role)}: ${content}`);
    } else {
      runtime.log(header);
      runtime.log(`  ${result.role}: ${content}`);
    }
  }
}

export async function sessionsBookmarkCommand(
  opts: { add?: string; remove?: string; list?: boolean },
  runtime: RuntimeEnv,
): Promise<void> {
  const stateDir = resolveStateDir();
  const bookmarks = loadBookmarks(stateDir);

  if (opts.add) {
    bookmarks.add(opts.add);
    await saveBookmarks(stateDir, bookmarks);
    runtime.log(info(`Bookmarked: ${opts.add}`));
    return;
  }

  if (opts.remove) {
    bookmarks.delete(opts.remove);
    await saveBookmarks(stateDir, bookmarks);
    runtime.log(info(`Removed bookmark: ${opts.remove}`));
    return;
  }

  if (bookmarks.size === 0) {
    runtime.log("No bookmarked messages.");
    return;
  }

  runtime.log(info(`Bookmarks (${bookmarks.size}):`));
  for (const bm of bookmarks) {
    runtime.log(`  ${bm}`);
  }
}
