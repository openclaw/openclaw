// Declarative usage-bar translator — the in-core port of the reference
// `usage_bar.py` engine. It is a TRANSLATOR, not a dictionary: it contains no
// glyphs, no layout, and no default footer — only mechanisms. All *content*
// (which glyphs make a meter, the segment order, the framing) is DATA in the
// template (`scales` / `aliases` / `output`). See usage-bar/template.ts.
//
// Verbs, used as {path|verb:args|fallback}:
//   num                3000 -> "3.0k"      (compact count)
//   fixed:N            0.03771985 -> "0.0377"  (fixed-decimal; N digits, default 2)
//   dur                14820 -> "4h07m"    (seconds -> reset)
//   pct                96 -> "96%"
//   inv                100-value complement (88 -> 12); pipe before another verb
//   alias:TABLE        look value up in aliases[TABLE]; echo raw value if unlisted
//   meter:WIDTH:SCALE  0-100 value -> WIDTH cells from scales[SCALE] (graded
//                      boundary cell); meter:1 = a single glyph
// Segment forms: text / when / map+cases / each(+item, item_scales).

export type UsageBarTemplate = Record<string, unknown>;
export type UsageContract = Record<string, unknown>;
type Vocab = Record<string, unknown>;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// A "scale" is an ordered glyph vocabulary. Strings must be split by CODE POINT
// (not UTF-16 unit) so astral glyphs like 🌑 stay intact — JS string indexing
// would slice a surrogate pair in half.
function toGlyphs(scale: unknown): string[] {
  if (Array.isArray(scale)) {
    return scale.filter((g): g is string => typeof g === "string");
  }
  if (typeof scale === "string") {
    // Array.from iterates by code point (like spread) so astral glyphs survive,
    // without tripping no-misused-spread. Scales are single-code-point glyphs;
    // multi-code-point emoji (e.g. ☀️) are supplied as array scales instead.
    return Array.from(scale);
  }
  return [];
}

// --- number formatters (algorithms, not content) ----------------------------
function num(value: unknown): string {
  if (value === null || value === undefined || value === "") {
    return "";
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return "";
  }
  if (Math.abs(n) >= 1000) {
    const v = n / 1000;
    return Math.abs(v) < 10 ? `${v.toFixed(1)}k` : `${Math.round(v)}k`;
  }
  return String(Math.trunc(n));
}

function fixed(value: unknown, digits: number): string {
  if (value === null || value === undefined || value === "") {
    return "";
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return "";
  }
  return n.toFixed(Math.max(0, digits));
}

function dur(value: unknown): string {
  if (value === null || value === undefined || value === "") {
    return "";
  }
  const raw = Number(value);
  if (!Number.isFinite(raw)) {
    return "";
  }
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

function pct(value: unknown): string {
  if (value === null || value === undefined || value === "") {
    return "";
  }
  const n = Number(value);
  return Number.isFinite(n) ? `${Math.round(n)}%` : "";
}

function inv(value: unknown): unknown {
  if (value === null || value === undefined || value === "") {
    return value;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return value;
  }
  return 100 - Math.max(0, Math.min(100, n));
}

function norm(value: unknown): number {
  const n = Number(value);
  if (value === null || value === undefined || !Number.isFinite(n)) {
    return 0;
  }
  return Math.max(0, Math.min(100, n)) / 100;
}

// --- meter mechanism (glyphs supplied by the template, not here) --------------
function meter(value: unknown, width: number, scale: unknown): string {
  const glyphs = toGlyphs(scale);
  if (glyphs.length < 2 || width < 1) {
    return "";
  }
  const empty = glyphs[0];
  const full = glyphs[glyphs.length - 1];
  const total = norm(value) * width;
  const fullc = Math.trunc(total);
  const cells: string[] = [];
  for (let i = 0; i < Math.min(fullc, width); i++) {
    cells.push(full);
  }
  if (cells.length < width) {
    cells.push(glyphs[Math.round((total - fullc) * (glyphs.length - 1))]);
  }
  while (cells.length < width) {
    cells.push(empty);
  }
  return cells.slice(0, width).join("");
}

const VERB_NAMES = new Set(["num", "fixed", "dur", "pct", "inv", "alias", "meter"]);

function applyVerb(name: string, args: string[], value: unknown, vocab: Vocab): unknown {
  switch (name) {
    case "num":
      return num(value);
    case "fixed": {
      const digits = args[0] ? Number.parseInt(args[0], 10) || 0 : 2;
      return fixed(value, digits);
    }
    case "dur":
      return dur(value);
    case "pct":
      return pct(value);
    case "inv":
      return inv(value);
    case "alias": {
      const aliases = isObject(vocab["_aliases"]) ? vocab["_aliases"] : {};
      const table =
        args[0] && isObject(aliases[args[0]]) ? (aliases[args[0]] as Record<string, unknown>) : {};
      const key = String(value);
      if (key in table) {
        return table[key];
      }
      const lower = key.toLowerCase();
      return lower in table ? table[lower] : value;
    }
    case "meter": {
      const width = args[0] ? Number.parseInt(args[0], 10) || 5 : 5;
      const scale = args.length > 1 ? vocab[args[1]] : undefined;
      return meter(value, width, scale);
    }
    default:
      return String(value);
  }
}

// --- template walker ----------------------------------------------------------
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
    const ops: Array<{ name: string; args: string[] }> = [];
    let fallback: string | undefined;
    for (const segRaw of parts.slice(1)) {
      const seg = segRaw.trim();
      const name = seg.split(":")[0];
      if (VERB_NAMES.has(name)) {
        ops.push({ name, args: seg.split(":").slice(1) });
      } else {
        fallback = seg;
      }
    }
    if (val === null || val === undefined || val === "") {
      return fallback ?? "";
    }
    for (const op of ops) {
      val = applyVerb(op.name, op.args, val, vocab);
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
    const key = typeof v === "boolean" ? String(v) : String(v);
    const cases = isObject(seg.cases) ? seg.cases : {};
    const hit = key in cases ? cases[key] : cases["_default"];
    return typeof hit === "string" ? hit : null;
  }
  if ("each" in seg) {
    const arr = getPath(ctx, String(seg.each));
    const items = Array.isArray(arr) ? arr : [];
    const itemTpl = typeof seg.item === "string" ? seg.item : "";
    const names = Array.isArray(seg.item_scales) ? (seg.item_scales as string[]) : undefined;
    const parts: string[] = [];
    items.forEach((el, i) => {
      let iv = vocab;
      if (names && names.length > 0) {
        iv = { ...vocab, "*": vocab[names[Math.min(i, names.length - 1)]] };
      }
      const r = interp(itemTpl, el, iv);
      if (r) {
        parts.push(r);
      }
    });
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
  // legacy: top-level surfaces.<surface>.{sep,segments} over top-level sep/segments
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

/**
 * Render a usage footer from a template + contract. Returns "" when the template
 * produces nothing (caller falls back to the boring built-in footer). Never
 * throws for malformed templates — best-effort, fail-open.
 */
export function renderUsageBar(template: UsageBarTemplate, contract: UsageContract): string {
  try {
    const { sep, pieces } = resolveLayout(template, contract.surface);
    const vocab: Vocab = {
      ...(isObject(template.ramps) ? template.ramps : {}),
      ...(isObject(template.series) ? template.series : {}),
      ...(isObject(template.scales) ? template.scales : {}),
    };
    vocab["_aliases"] = isObject(template.aliases) ? template.aliases : {};
    const out: string[] = [];
    for (const piece of pieces) {
      if (isObject(piece)) {
        const r = renderSegment(piece, contract, vocab);
        if (r) {
          out.push(r);
        }
      }
    }
    return out.join(sep);
  } catch {
    return "";
  }
}
