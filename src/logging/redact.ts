import { createRequire } from "node:module";
import type { OpenClawConfig } from "../config/config.js";

const requireConfig = createRequire(import.meta.url);

export type RedactSensitiveMode = "off" | "tools";

const DEFAULT_REDACT_MODE: RedactSensitiveMode = "tools";
const DEFAULT_REDACT_MIN_LENGTH = 18;
const DEFAULT_REDACT_KEEP_START = 6;
const DEFAULT_REDACT_KEEP_END = 4;
const DEFAULT_REDACT_OBJECT_DEPTH = 12;

const DEFAULT_REDACT_PATTERNS: string[] = [
  // ENV-style assignments.
  String.raw`\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)\b\s*[=:]\s*(["']?)([^\s"'\\]+)\1`,
  // JSON fields.
  String.raw`"(?:apiKey|token|secret|password|passwd|accessToken|refreshToken)"\s*:\s*"([^"]+)"`,
  // CLI flags.
  String.raw`--(?:api[-_]?key|token|secret|password|passwd)\s+(["']?)([^\s"']+)\1`,
  // Authorization headers.
  String.raw`Authorization\s*[:=]\s*Bearer\s+([A-Za-z0-9._\-+=]+)`,
  String.raw`\bBearer\s+([A-Za-z0-9._\-+=]{18,})\b`,
  // PEM blocks.
  String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----`,
  // Common token prefixes.
  String.raw`\b(sk-[A-Za-z0-9_-]{8,})\b`,
  String.raw`\b(ghp_[A-Za-z0-9]{20,})\b`,
  String.raw`\b(github_pat_[A-Za-z0-9_]{20,})\b`,
  String.raw`\b(xox[baprs]-[A-Za-z0-9-]{10,})\b`,
  String.raw`\b(xapp-[A-Za-z0-9-]{10,})\b`,
  String.raw`\b(gsk_[A-Za-z0-9_-]{10,})\b`,
  String.raw`\b(AIza[0-9A-Za-z\-_]{20,})\b`,
  String.raw`\b(pplx-[A-Za-z0-9_-]{10,})\b`,
  String.raw`\b(npm_[A-Za-z0-9]{10,})\b`,
  String.raw`\b(\d{6,}:[A-Za-z0-9_-]{20,})\b`,
];

export type RedactOptions = {
  mode?: RedactSensitiveMode;
  patterns?: string[];
};

type ResolvedRedactOptions = {
  mode: RedactSensitiveMode;
  patterns: RegExp[];
};

export type SensitiveRedactor = {
  mode: RedactSensitiveMode;
  redactText: (text: string) => string;
  redactValue: (value: unknown) => unknown;
  redactArgs: (args: unknown[]) => unknown[];
};

function normalizeMode(value?: string): RedactSensitiveMode {
  return value === "off" ? "off" : DEFAULT_REDACT_MODE;
}

const patternCache = new Map<string, RegExp | null>();

function parsePattern(raw: string): RegExp | null {
  if (!raw.trim()) {
    return null;
  }
  const cached = patternCache.get(raw);
  if (cached !== undefined) {
    return cached;
  }
  const match = raw.match(/^\/(.+)\/([gimsuy]*)$/);
  try {
    if (match) {
      const flags = match[2].includes("g") ? match[2] : `${match[2]}g`;
      const compiled = new RegExp(match[1], flags);
      patternCache.set(raw, compiled);
      return compiled;
    }
    const compiled = new RegExp(raw, "gi");
    patternCache.set(raw, compiled);
    return compiled;
  } catch {
    patternCache.set(raw, null);
    return null;
  }
}

function resolvePatterns(value?: string[]): RegExp[] {
  const source = value?.length ? value : DEFAULT_REDACT_PATTERNS;
  return source.map(parsePattern).filter((re): re is RegExp => Boolean(re));
}

function maskToken(token: string): string {
  if (token.length < DEFAULT_REDACT_MIN_LENGTH) {
    return "***";
  }
  const start = token.slice(0, DEFAULT_REDACT_KEEP_START);
  const end = token.slice(-DEFAULT_REDACT_KEEP_END);
  return `${start}…${end}`;
}

function isPasswordKey(key: string): boolean {
  return /(pass(word)?|passwd)\b/i.test(key);
}

function isSensitiveKey(key: string): boolean {
  return (
    /(pass(word)?|passwd|token|secret|api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|cookie)\b/i.test(
      key,
    ) || /^x-api-key$/i.test(key)
  );
}

function redactPemBlock(block: string): string {
  const lines = block.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) {
    return "***";
  }
  return `${lines[0]}\n…redacted…\n${lines[lines.length - 1]}`;
}

function redactMatch(match: string, groups: string[]): string {
  if (match.includes("PRIVATE KEY-----")) {
    return redactPemBlock(match);
  }
  const shouldFullyRedact = /\bpass(word)?\b/i.test(match) || /\bpasswd\b/i.test(match);
  const token =
    groups.filter((value) => typeof value === "string" && value.length > 0).at(-1) ?? match;
  const masked = shouldFullyRedact ? "***" : maskToken(token);
  if (token === match) {
    return masked;
  }
  return match.replace(token, masked);
}

function redactText(text: string, patterns: RegExp[]): string {
  let next = text;
  for (const pattern of patterns) {
    next = next.replace(pattern, (...args: string[]) =>
      redactMatch(args[0], args.slice(1, args.length - 2)),
    );
  }
  return next;
}

function resolveConfigRedaction(): RedactOptions {
  let cfg: OpenClawConfig["logging"] | undefined;
  try {
    const loaded = requireConfig("../config/config.js") as {
      loadConfig?: () => OpenClawConfig;
    };
    cfg = loaded.loadConfig?.().logging;
  } catch {
    cfg = undefined;
  }
  return {
    mode: normalizeMode(cfg?.redactSensitive),
    patterns: cfg?.redactPatterns,
  };
}

export function getConfiguredRedactOptions(): RedactOptions {
  return resolveConfigRedaction();
}

function resolveRedactOptions(options?: RedactOptions): ResolvedRedactOptions {
  const raw = options ?? resolveConfigRedaction();
  return {
    mode: normalizeMode(raw.mode),
    patterns: resolvePatterns(raw.patterns),
  };
}

export function createSensitiveRedactor(options?: RedactOptions): SensitiveRedactor {
  const resolved = resolveRedactOptions(options);
  if (resolved.mode === "off" || resolved.patterns.length === 0) {
    return {
      mode: "off",
      redactText: (text) => text,
      redactValue: (value) => value,
      redactArgs: (args) => args,
    };
  }

  const patterns = resolved.patterns;
  return {
    mode: resolved.mode,
    redactText: (text) => (text ? redactText(text, patterns) : text),
    redactValue: (value) => redactSensitiveValueInner(value, patterns, new WeakSet<object>(), 0),
    redactArgs: (args) => {
      if (!Array.isArray(args) || args.length === 0) {
        return args;
      }
      const seen = new WeakSet<object>();
      return args.map((value) => redactSensitiveValueInner(value, patterns, seen, 0));
    },
  };
}

export function redactSensitiveText(text: string, options?: RedactOptions): string {
  if (!text) {
    return text;
  }
  const resolved = resolveRedactOptions(options);
  if (resolved.mode === "off") {
    return text;
  }
  if (resolved.patterns.length === 0) {
    return text;
  }
  return redactText(text, resolved.patterns);
}

export function redactToolDetail(detail: string): string {
  const resolved = resolveConfigRedaction();
  if (normalizeMode(resolved.mode) !== "tools") {
    return detail;
  }
  return redactSensitiveText(detail, resolved);
}

function redactSensitivePrimitive(value: unknown, patterns: RegExp[]): unknown {
  if (typeof value === "string") {
    return redactText(value, patterns);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  return value;
}

function redactSensitiveValueInner(
  value: unknown,
  patterns: RegExp[],
  seen: WeakSet<object>,
  depth: number,
): unknown {
  const prim = redactSensitivePrimitive(value, patterns);
  if (prim !== value) {
    return prim;
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  if (depth >= DEFAULT_REDACT_OBJECT_DEPTH) {
    return "[MaxDepth]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveValueInner(item, patterns, seen, depth + 1));
  }

  if (value instanceof Date) {
    return value;
  }
  if (value instanceof RegExp) {
    return value;
  }
  if (value instanceof URL) {
    return redactText(value.toString(), patterns);
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactText(value.message, patterns),
      stack: value.stack ? redactText(value.stack, patterns) : undefined,
    };
  }

  const proto = Object.getPrototypeOf(value);
  const next: Record<string, unknown> = proto ? Object.create(proto) : {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      if (raw == null) {
        next[key] = raw;
        continue;
      }
      if (isPasswordKey(key)) {
        next[key] = "***";
        continue;
      }
      const text = typeof raw === "string" ? raw : typeof raw === "bigint" ? raw.toString() : "";
      if (text) {
        const redacted = redactText(text, patterns);
        next[key] = redacted === text ? maskToken(text) : redacted;
      } else {
        next[key] = "***";
      }
      continue;
    }
    next[key] = redactSensitiveValueInner(raw, patterns, seen, depth + 1);
  }
  return next;
}

export function redactSensitiveValue(value: unknown, options?: RedactOptions): unknown {
  const resolved = resolveRedactOptions(options);
  if (resolved.mode === "off") {
    return value;
  }
  if (resolved.patterns.length === 0) {
    return value;
  }
  return redactSensitiveValueInner(value, resolved.patterns, new WeakSet<object>(), 0);
}

export function redactSensitiveArgs(args: unknown[], options?: RedactOptions): unknown[] {
  if (!Array.isArray(args) || args.length === 0) {
    return args;
  }
  const resolved = resolveRedactOptions(options);
  if (resolved.mode === "off") {
    return args;
  }
  if (resolved.patterns.length === 0) {
    return args;
  }
  const seen = new WeakSet<object>();
  return args.map((value) => redactSensitiveValueInner(value, resolved.patterns, seen, 0));
}

export function getDefaultRedactPatterns(): string[] {
  return [...DEFAULT_REDACT_PATTERNS];
}
