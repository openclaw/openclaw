import JSON5 from "json5";
import type {
  ClawdbotHookMetadata,
  HookEntry,
  HookInstallSpec,
  HookInvocationPolicy,
  ParsedHookFrontmatter,
} from "./types.js";

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Extract a multi-line block value from frontmatter lines.
 * Handles indented continuation lines (YAML-style multi-line values).
 *
 * @param lines - All lines in the frontmatter block
 * @param startIndex - Index of the line containing the key
 * @returns The combined multi-line value and the number of lines consumed
 */
function extractMultiLineValue(
  lines: string[],
  startIndex: number,
): { value: string; linesConsumed: number } {
  const startLine = lines[startIndex];
  const match = startLine.match(/^([\w-]+):\s*(.*)$/);
  if (!match) return { value: "", linesConsumed: 1 };

  const inlineValue = match[2].trim();

  // If there's a value on the same line, return it (single-line case)
  if (inlineValue) {
    return { value: inlineValue, linesConsumed: 1 };
  }

  // Multi-line case: collect indented continuation lines
  const valueLines: string[] = [];
  let i = startIndex + 1;

  while (i < lines.length) {
    const line = lines[i];
    // Stop if we hit a non-indented line (new key or empty line without indent)
    if (line.length > 0 && !line.startsWith(" ") && !line.startsWith("\t")) {
      break;
    }
    valueLines.push(line);
    i++;
  }

  // Join and trim the multi-line value
  const combined = valueLines.join("\n").trim();
  return { value: combined, linesConsumed: i - startIndex };
}

export function parseFrontmatter(content: string): ParsedHookFrontmatter {
  const frontmatter: ParsedHookFrontmatter = {};
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith("---")) return frontmatter;
  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) return frontmatter;
  const block = normalized.slice(4, endIndex);
  const lines = block.split("\n");

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const match = line.match(/^([\w-]+):\s*(.*)$/);
    if (!match) {
      i++;
      continue;
    }

    const key = match[1];
    const inlineValue = match[2].trim();

    if (!key) {
      i++;
      continue;
    }

    // Check if this is a multi-line value (no inline value and next line is indented)
    if (!inlineValue && i + 1 < lines.length) {
      const nextLine = lines[i + 1];
      if (nextLine.startsWith(" ") || nextLine.startsWith("\t")) {
        // Multi-line value
        const { value, linesConsumed } = extractMultiLineValue(lines, i);
        if (value) {
          frontmatter[key] = value;
        }
        i += linesConsumed;
        continue;
      }
    }

    // Single-line value
    const value = stripQuotes(inlineValue);
    if (value) {
      frontmatter[key] = value;
    }
    i++;
  }

  return frontmatter;
}

function normalizeStringList(input: unknown): string[] {
  if (!input) return [];
  if (Array.isArray(input)) {
    return input.map((value) => String(value).trim()).filter(Boolean);
  }
  if (typeof input === "string") {
    return input
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  }
  return [];
}

function parseInstallSpec(input: unknown): HookInstallSpec | undefined {
  if (!input || typeof input !== "object") return undefined;
  const raw = input as Record<string, unknown>;
  const kindRaw =
    typeof raw.kind === "string" ? raw.kind : typeof raw.type === "string" ? raw.type : "";
  const kind = kindRaw.trim().toLowerCase();
  if (kind !== "bundled" && kind !== "npm" && kind !== "git") {
    return undefined;
  }

  const spec: HookInstallSpec = {
    kind: kind as HookInstallSpec["kind"],
  };

  if (typeof raw.id === "string") spec.id = raw.id;
  if (typeof raw.label === "string") spec.label = raw.label;
  const bins = normalizeStringList(raw.bins);
  if (bins.length > 0) spec.bins = bins;
  if (typeof raw.package === "string") spec.package = raw.package;
  if (typeof raw.repository === "string") spec.repository = raw.repository;

  return spec;
}

function getFrontmatterValue(frontmatter: ParsedHookFrontmatter, key: string): string | undefined {
  const raw = frontmatter[key];
  return typeof raw === "string" ? raw : undefined;
}

function parseFrontmatterBool(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") {
    return false;
  }
  return fallback;
}

export function resolveClawdbotMetadata(
  frontmatter: ParsedHookFrontmatter,
): ClawdbotHookMetadata | undefined {
  const raw = getFrontmatterValue(frontmatter, "metadata");
  if (!raw) return undefined;
  try {
    // Use JSON5 to handle trailing commas and other relaxed JSON syntax
    const parsed = JSON5.parse(raw) as { clawdbot?: unknown };
    if (!parsed || typeof parsed !== "object") return undefined;
    const clawdbot = (parsed as { clawdbot?: unknown }).clawdbot;
    if (!clawdbot || typeof clawdbot !== "object") return undefined;
    const clawdbotObj = clawdbot as Record<string, unknown>;
    const requiresRaw =
      typeof clawdbotObj.requires === "object" && clawdbotObj.requires !== null
        ? (clawdbotObj.requires as Record<string, unknown>)
        : undefined;
    const installRaw = Array.isArray(clawdbotObj.install) ? (clawdbotObj.install as unknown[]) : [];
    const install = installRaw
      .map((entry) => parseInstallSpec(entry))
      .filter((entry): entry is HookInstallSpec => Boolean(entry));
    const osRaw = normalizeStringList(clawdbotObj.os);
    const eventsRaw = normalizeStringList(clawdbotObj.events);
    return {
      always: typeof clawdbotObj.always === "boolean" ? clawdbotObj.always : undefined,
      emoji: typeof clawdbotObj.emoji === "string" ? clawdbotObj.emoji : undefined,
      homepage: typeof clawdbotObj.homepage === "string" ? clawdbotObj.homepage : undefined,
      hookKey: typeof clawdbotObj.hookKey === "string" ? clawdbotObj.hookKey : undefined,
      export: typeof clawdbotObj.export === "string" ? clawdbotObj.export : undefined,
      os: osRaw.length > 0 ? osRaw : undefined,
      events: eventsRaw.length > 0 ? eventsRaw : [],
      requires: requiresRaw
        ? {
            bins: normalizeStringList(requiresRaw.bins),
            anyBins: normalizeStringList(requiresRaw.anyBins),
            env: normalizeStringList(requiresRaw.env),
            config: normalizeStringList(requiresRaw.config),
          }
        : undefined,
      install: install.length > 0 ? install : undefined,
    };
  } catch {
    return undefined;
  }
}

export function resolveHookInvocationPolicy(
  frontmatter: ParsedHookFrontmatter,
): HookInvocationPolicy {
  return {
    enabled: parseFrontmatterBool(getFrontmatterValue(frontmatter, "enabled"), true),
  };
}

export function resolveHookKey(hookName: string, entry?: HookEntry): string {
  return entry?.clawdbot?.hookKey ?? hookName;
}
