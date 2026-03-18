import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

export type TuiAliasMap = Record<string, string>;

const TUI_ALIAS_FILE = "aliases.json";
const TUI_ALIAS_DIR = "tui";
const TUI_ALIAS_NAME_RE = /^[a-z0-9][a-z0-9:_-]*$/;
const DOUBLE_QUOTE_ESCAPES = new Set(["\\", '"', "$", "`", "\n", "\r"]);

function isDoubleQuoteEscape(next: string | undefined): next is string {
  return Boolean(next && DOUBLE_QUOTE_ESCAPES.has(next));
}

function normalizeAliasRecord(value: unknown): TuiAliasMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .map(([rawName, rawPrompt]) => {
      const name = normalizeTuiAliasName(rawName);
      const prompt = typeof rawPrompt === "string" ? rawPrompt.trim() : "";
      if (!name || !prompt) {
        return null;
      }
      return [name, prompt] as const;
    })
    .filter((entry): entry is readonly [string, string] => entry !== null)
    .toSorted(([a], [b]) => a.localeCompare(b));
  return Object.fromEntries(entries);
}

export function normalizeTuiAliasName(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized || !TUI_ALIAS_NAME_RE.test(normalized)) {
    return null;
  }
  return normalized;
}

export function resolveTuiAliasStorePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), TUI_ALIAS_DIR, TUI_ALIAS_FILE);
}

export async function loadTuiAliases(env: NodeJS.ProcessEnv = process.env): Promise<TuiAliasMap> {
  const filePath = resolveTuiAliasStorePath(env);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return normalizeAliasRecord(parsed);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

export async function saveTuiAliases(
  aliases: TuiAliasMap,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const filePath = resolveTuiAliasStorePath(env);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const normalized = normalizeAliasRecord(aliases);
  await fs.writeFile(filePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
}

export function parseTuiAliasArgs(raw: string): string[] | null {
  const tokens: string[] = [];
  let buf = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  const pushToken = () => {
    if (buf.length > 0) {
      tokens.push(buf);
      buf = "";
    }
  };

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (escaped) {
      buf += ch;
      escaped = false;
      continue;
    }
    if (!inSingle && !inDouble && ch === "\\") {
      escaped = true;
      continue;
    }
    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        buf += ch;
      }
      continue;
    }
    if (inDouble) {
      const next = raw[i + 1];
      if (ch === "\\" && isDoubleQuoteEscape(next)) {
        buf += next;
        i += 1;
        continue;
      }
      if (ch === '"') {
        inDouble = false;
      } else {
        buf += ch;
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (/\s/.test(ch)) {
      pushToken();
      continue;
    }
    buf += ch;
  }

  if (escaped || inSingle || inDouble) {
    return null;
  }
  pushToken();
  return tokens;
}
