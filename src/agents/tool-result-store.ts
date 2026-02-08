import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { TextContent } from "@mariozechner/pi-ai";
import fs from "node:fs";
import path from "node:path";

export type StoredToolResultRef = {
  /** Relative to the session transcripts dir (agent-scoped). */
  ref: string;
  bytes: number;
  totalTextChars: number;
  previewHead: string;
  previewTail: string;
};

export type ToolResultStoreOptions = {
  /** Base directory that contains session transcript jsonl files. */
  sessionDir: string;
  sessionId: string;
  toolCallId: string;
};

function safeMkdirp(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function extractToolResultTextBlocks(message: AgentMessage): string[] {
  if ((message as { role?: unknown }).role !== "toolResult") {
    return [];
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return [];
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const type = (block as { type?: unknown }).type;
    if (type !== "text") {
      continue;
    }
    const text = (block as TextContent).text;
    if (typeof text === "string") {
      parts.push(text);
    }
  }
  return parts;
}

function sumLengths(parts: string[]): number {
  let len = 0;
  for (const p of parts) {
    len += p.length;
  }
  return len;
}

export function storeToolResultPayload(params: {
  message: AgentMessage;
  options: ToolResultStoreOptions;
  preview?: { headChars?: number; tailChars?: number };
}): StoredToolResultRef | null {
  const parts = extractToolResultTextBlocks(params.message);
  const totalTextChars = sumLengths(parts);
  const headChars = Math.max(0, Math.floor(params.preview?.headChars ?? 1500));
  const tailChars = Math.max(0, Math.floor(params.preview?.tailChars ?? 1500));
  const previewHead = takeHead(parts[0] ?? "", headChars);
  const previewTail = takeTail(parts.at(-1) ?? "", tailChars);

  const payload = {
    version: 1,
    sessionId: params.options.sessionId,
    toolCallId: params.options.toolCallId,
    storedAt: new Date().toISOString(),
    textBlocks: parts,
  };

  const baseDir = params.options.sessionDir;
  const relDir = path.join("_tool_results", params.options.sessionId);
  const outDir = path.join(baseDir, relDir);
  safeMkdirp(outDir);

  const fileName = `${encodeURIComponent(params.options.toolCallId)}.json`;
  const absPath = path.join(outDir, fileName);

  const json = JSON.stringify(payload);
  fs.writeFileSync(absPath, json, "utf-8");
  const bytes = Buffer.byteLength(json, "utf8");

  return {
    ref: path.join(relDir, fileName),
    bytes,
    totalTextChars,
    previewHead,
    previewTail,
  };
}

function takeHead(text: string, maxChars: number): string {
  if (maxChars <= 0) {
    return "";
  }
  if (text.length <= maxChars) {
    return text;
  }
  return text.slice(0, maxChars);
}

function takeTail(text: string, maxChars: number): string {
  if (maxChars <= 0) {
    return "";
  }
  if (text.length <= maxChars) {
    return text;
  }
  return text.slice(text.length - maxChars);
}

export function makeExternalizedToolResultDigest(params: {
  toolName?: string;
  toolCallId: string;
  storedRef: string;
  originalChars: number;
  previewHead: string;
  previewTail: string;
  maxDigestChars?: number;
}): string {
  const maxDigestChars = Math.max(0, Math.floor(params.maxDigestChars ?? 4000));

  const header = `[Tool result externalized${params.toolName ? `: ${params.toolName}` : ""}]
ToolCallId: ${params.toolCallId}
StoredRef: ${params.storedRef}
Original: ${params.originalChars} chars
`;

  const preview = `${params.previewHead}
...
${params.previewTail}`.trim();

  const howTo = `
[Fetch full or slice]
Use tool_result_get with:
  { ref: "${params.storedRef}", offsetChars: 0, maxChars: 4000 }
`;

  const raw = `${header}
${preview}

${howTo}`;
  if (raw.length <= maxDigestChars) {
    return raw;
  }

  const clipped = takeHead(raw, Math.max(0, maxDigestChars - 20));
  return `${clipped}
…(truncated)…`;
}

export function readStoredToolResultText(params: {
  sessionDir: string;
  ref: string;
}): { ok: true; text: string } | { ok: false; error: string } {
  const base = path.resolve(params.sessionDir);
  const target = path.resolve(path.join(base, params.ref));
  if (!target.startsWith(base + path.sep)) {
    return { ok: false, error: "Invalid ref path." };
  }
  if (!fs.existsSync(target)) {
    return { ok: false, error: `Not found: ${params.ref}` };
  }
  try {
    const json = fs.readFileSync(target, "utf-8");
    const data = JSON.parse(json) as { textBlocks?: unknown };
    const blocks = Array.isArray(data.textBlocks) ? data.textBlocks : [];
    const parts = blocks.filter((b): b is string => typeof b === "string");
    return { ok: true, text: parts.join("\n") };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}
