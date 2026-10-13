import {
  asFiniteNumber,
  asSafeIntegerInRange,
  expectDefined,
  isRecord as isObject,
  parseStrictInteger,
} from "@openclaw/normalization-core";
import { formatTokenCount } from "../../utils/token-format.js";
export type UsageBarTemplate = Record<string, unknown>;
export type UsageContract = Record<string, unknown>;
type Vocab = Record<string, unknown>;

function coerceFiniteValue(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }
  return asFiniteNumber(Number(value));
}

function num(n: number): string {
  if (Math.abs(n) >= 1000) {
    const compact = formatTokenCount(Math.abs(n));
    return n < 0 ? `-${compact}` : compact;
  }
  return String(Math.trunc(n));
}

function fixed(value: unknown, digits: number): string {
  const n = coerceFiniteValue(value);
  return n === undefined ? "" : n.toFixed(digits);
}

function dur(raw: number): string {
  const s = Math.max(0, Math.trunc(raw));
  if (s >= 86400) {
    return `${(s / 86400).toFixed(1)}d`;
  }
  if (s >= 3600) {
    const m = Math.floor((s % 3600) / 60);
    return `${Math.floor(s / 3600)}h${String(m).padStart(2, "0")}m`;
  }
  return `${Math.floor(s / 60)}m`;
}

function meter(value: unknown, width: number, scale: unknown): string {
  const glyphs = Array.isArray(scale)
    ? scale.filter((glyph): glyph is string => typeof glyph === "string")
    : typeof scale === "string"
      ? Array.from(scale)
      : [];
  if (glyphs.length < 2 || width < 1) {
    return "";
  }
  const empty = expectDefined(glyphs[0], "glyphs entry at 0");
  const full = expectDefined(glyphs[glyphs.length - 1], "glyphs entry at glyphs.length 1");
  const total = (Math.max(0, Math.min(100, coerceFiniteValue(value) ?? 0)) / 100) * width;
  const fullc = Math.trunc(total);
  if (fullc === width) {
    return full.repeat(width);
  }
  const partial = expectDefined(
    glyphs[Math.round((total - fullc) * (glyphs.length - 1))],
    "glyphs entry at math.round((total fullc) * (glyphs.length 1))",
  );
  return full.repeat(fullc) + partial + empty.repeat(width - fullc - 1);
}

function parseBoundedIntegerArg(
  raw: string | undefined,
  options: { defaultValue: number; min: number; max: number },
): number | undefined {
  const value = raw === undefined ? options.defaultValue : parseStrictInteger(raw);
  return asSafeIntegerInRange(value, options);
}

type UsageVerb = (value: unknown, args: string[], vocab: Vocab) => unknown;

function numeric(format: (value: number) => unknown, preserveInvalid = false): UsageVerb {
  return (value) => {
    const n = coerceFiniteValue(value);
    return n === undefined ? (preserveInvalid ? value : "") : format(n);
  };
}

const VERBS: Record<string, UsageVerb> = {
  num: numeric(num),
  dur: numeric(dur),
  pct: numeric((n) => `${Math.round(n)}%`),
  inv: numeric((n) => 100 - Math.max(0, Math.min(100, n)), true),
  fixed(value, args) {
    const digits = parseBoundedIntegerArg(args[0], { defaultValue: 2, min: 0, max: 100 });
    return digits === undefined ? "" : fixed(value, digits);
  },
  alias(value, args, vocab) {
    const aliases = isObject(vocab["_aliases"]) ? vocab["_aliases"] : {};
    const table =
      args[0] && isObject(aliases[args[0]]) ? (aliases[args[0]] as Record<string, unknown>) : {};
    const key = String(value);
    if (Object.hasOwn(table, key)) {
      return table[key];
    }
    const lower = key.toLowerCase();
    return Object.hasOwn(table, lower) ? table[lower] : value;
  },
  meter(value, args, vocab) {
    const rawWidth = args[0]?.trim() ? args[0] : undefined;
    const width = parseBoundedIntegerArg(rawWidth, { defaultValue: 5, min: 1, max: 100 });
    const scale = args.length > 1 ? vocab[expectDefined(args[1], "args entry at 1")] : undefined;
    return width === undefined ? "" : meter(value, width, scale);
  },
};

function getPath(ctx: unknown, path: string): unknown {
  let cur: unknown = ctx;
  for (const part of path.split(".")) {
    if (!isObject(cur)) {
      return undefined;
    }
    cur = cur[part];
    if (cur === null || cur === undefined) {
      return undefined;
    }
  }
  return cur;
}

const TOKEN = /\{([^}]+)\}/g;

function interp(text: string, ctx: unknown, vocab: Vocab): string {
  return text.replace(TOKEN, (_match, body: string) => {
    const parts = body.split("|");
    let val = getPath(ctx, (parts[0] ?? "").trim());
    const ops: Array<{ apply: UsageVerb; args: string[] }> = [];
    let fallback: string | undefined;
    for (const segRaw of parts.slice(1)) {
      const seg = segRaw.trim();
      const [name = "", ...args] = seg.split(":");
      const apply = Object.hasOwn(VERBS, name) ? VERBS[name] : undefined;
      if (apply) {
        ops.push({ apply, args });
      } else {
        fallback = seg;
      }
    }
    if (val === null || val === undefined || val === "") {
      return fallback ?? "";
    }
    for (const op of ops) {
      val = op.apply(val, op.args, vocab);
    }
    return String(val);
  });
}

type Segment = Record<string, unknown>;

function renderSegment(seg: Segment, ctx: unknown, vocab: Vocab): string | null {
  if ("when" in seg) {
    const v = getPath(ctx, String(seg.when));
    if (v === null || v === undefined || v === false || v === "") {
      return null;
    }
  }
  if ("map" in seg) {
    const v = getPath(ctx, String(seg.map));
    const key = String(v);
    const cases = isObject(seg.cases) ? seg.cases : {};
    const hit = Object.hasOwn(cases, key) ? cases[key] : cases["_default"];
    return typeof hit === "string" ? hit : null;
  }
  if ("each" in seg) {
    const arr = getPath(ctx, String(seg.each));
    const items = Array.isArray(arr) ? arr : [];
    const itemTpl = typeof seg.item === "string" ? seg.item : "";
    const names = Array.isArray(seg.item_scales) ? (seg.item_scales as string[]) : undefined;
    const parts = items
      .map((el, i) =>
        interp(
          itemTpl,
          el,
          names?.length
            ? {
                ...vocab,
                "*": vocab[
                  expectDefined(
                    names[Math.min(i, names.length - 1)],
                    "names entry at math.min(i, names.length 1)",
                  )
                ],
              }
            : vocab,
        ),
      )
      .filter(Boolean);
    const join = typeof seg.join === "string" ? seg.join : " ";
    const body = parts.join(join);
    if (!body) {
      return null;
    }
    const prefix = typeof seg.text === "string" ? seg.text : "";
    return prefix ? `${prefix} ${body}` : body;
  }
  if ("text" in seg) {
    return interp(String(seg.text), ctx, vocab) || null;
  }
  return null;
}

function resolveLayout(
  template: UsageBarTemplate,
  surface: unknown,
): { sep: string; pieces: Segment[] } {
  const output = template.output;
  if (isObject(output)) {
    const surfaces = isObject(output.surfaces) ? output.surfaces : {};
    let pieces = typeof surface === "string" ? surfaces[surface] : undefined;
    if (pieces === undefined) {
      pieces = output.default;
    }
    const sep = typeof output.sep === "string" ? output.sep : "";
    return { sep, pieces: Array.isArray(pieces) ? (pieces as Segment[]) : [] };
  }
  const ov =
    typeof surface === "string" &&
    isObject(template.surfaces) &&
    isObject(template.surfaces[surface])
      ? template.surfaces[surface]
      : {};
  const sep =
    typeof ov.sep === "string" ? ov.sep : typeof template.sep === "string" ? template.sep : " ";
  const segments = Array.isArray(ov.segments)
    ? ov.segments
    : Array.isArray(template.segments)
      ? template.segments
      : [];
  return { sep, pieces: segments as Segment[] };
}

export function renderUsageBar(template: UsageBarTemplate, contract: UsageContract): string {
  try {
    const { sep, pieces } = resolveLayout(template, contract.surface);
    const vocab: Vocab = {
      ...(isObject(template.ramps) ? template.ramps : {}),
      ...(isObject(template.series) ? template.series : {}),
      ...(isObject(template.scales) ? template.scales : {}),
    };
    vocab["_aliases"] = isObject(template.aliases) ? template.aliases : {};
    return pieces
      .filter(isObject)
      .map((piece) => renderSegment(piece, contract, vocab))
      .filter(Boolean)
      .join(sep);
  } catch {
    return "";
  }
}
