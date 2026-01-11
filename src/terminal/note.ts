import { note as clackNote } from "@clack/prompts";
import { stylePromptTitle } from "./prompt-style.js";

const ANSI_ESCAPE = /\u001b\[[0-9;]*m/g;

function visibleLength(value: string): number {
  return Array.from(value.replace(ANSI_ESCAPE, "")).length;
}

function splitLongWord(word: string, maxLen: number): string[] {
  if (maxLen <= 0) return [word];
  const chars = Array.from(word);
  const parts: string[] = [];
  for (let i = 0; i < chars.length; i += maxLen) {
    parts.push(chars.slice(i, i + maxLen).join(""));
  }
  return parts.length > 0 ? parts : [word];
}

function wrapLine(line: string, maxWidth: number): string[] {
  if (line.trim().length === 0) return [line];
  const match = line.match(/^(\s*)([-*\u2022]\s+)?(.*)$/);
  const indent = match?.[1] ?? "";
  const bullet = match?.[2] ?? "";
  const content = match?.[3] ?? "";
  const firstPrefix = `${indent}${bullet}`;
  const nextPrefix = `${indent}${bullet ? " ".repeat(bullet.length) : ""}`;
  const firstWidth = Math.max(10, maxWidth - visibleLength(firstPrefix));
  const nextWidth = Math.max(10, maxWidth - visibleLength(nextPrefix));

  const words = content.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  let prefix = firstPrefix;
  let available = firstWidth;

  for (const word of words) {
    if (!current) {
      if (visibleLength(word) > available) {
        const parts = splitLongWord(word, available);
        const first = parts.shift() ?? "";
        lines.push(prefix + first);
        prefix = nextPrefix;
        available = nextWidth;
        for (const part of parts) lines.push(prefix + part);
        continue;
      }
      current = word;
      continue;
    }

    const candidate = `${current} ${word}`;
    if (visibleLength(candidate) <= available) {
      current = candidate;
      continue;
    }

    lines.push(prefix + current);
    prefix = nextPrefix;
    available = nextWidth;

    if (visibleLength(word) > available) {
      const parts = splitLongWord(word, available);
      const first = parts.shift() ?? "";
      lines.push(prefix + first);
      for (const part of parts) lines.push(prefix + part);
      current = "";
      continue;
    }
    current = word;
  }

  if (current || words.length === 0) {
    lines.push(prefix + current);
  }

  return lines;
}

export function wrapNoteMessage(
  message: string,
  options: { maxWidth?: number; columns?: number } = {},
): string {
  const columns = options.columns ?? process.stdout.columns ?? 80;
  const maxWidth = options.maxWidth ?? Math.max(40, Math.min(88, columns - 10));
  return message
    .split("\n")
    .flatMap((line) => wrapLine(line, maxWidth))
    .join("\n");
}

export function note(message: string, title?: string) {
  clackNote(wrapNoteMessage(message), stylePromptTitle(title));
}
