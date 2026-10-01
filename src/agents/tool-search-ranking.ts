// Lexical ranking for the OpenClaw Tool Search runtime.
import { isRecord } from "@openclaw/normalization-core/record-coerce";

/** Collects property names and descriptions from a JSON-Schema-shaped value. */
export function readParameterText(parameters: unknown, depth = 0): string {
  const parts: string[] = [];
  collectParameterText(parameters, depth, parts);
  return parts.join(" ");
}

function collectParameterText(parameters: unknown, depth: number, parts: string[]): void {
  if (depth > 4 || !isRecord(parameters)) {
    return;
  }
  const description = parameters.description;
  if (typeof description === "string" && description) {
    parts.push(description);
  }
  const properties = parameters.properties;
  if (isRecord(properties)) {
    for (const [name, child] of Object.entries(properties)) {
      if (name) {
        parts.push(name);
      }
      collectParameterText(child, depth + 1, parts);
    }
  }
  const items = parameters.items;
  if (items !== undefined) {
    collectParameterText(items, depth + 1, parts);
  }
}

/** BM25 term-frequency saturation. Standard Okapi default. */
const BM25_K1 = 1.2;
/** BM25 length normalization. Standard Okapi default. */
const BM25_B = 0.75;

// Drop filler, but retain capability verbs such as "get" in "get_weather".
const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "can",
  "do",
  "for",
  "from",
  "had",
  "has",
  "have",
  "here",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "me",
  "my",
  "no",
  "not",
  "of",
  "on",
  "or",
  "our",
  "so",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "to",
  "up",
  "us",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "will",
  "with",
  "you",
  "your",
]);

// Bridge intent to catalog wording using generic capabilities, never vendor or plugin names.
const QUERY_EXPANSIONS: ReadonlyArray<{ terms: readonly string[]; add: readonly string[] }> = [
  { terms: ["look", "lookup", "google", "research"], add: ["search", "web", "find"] },
  {
    terms: ["current", "today", "latest", "now", "recent", "news", "price", "weather"],
    add: ["search", "web"],
  },
  { terms: ["url", "link", "page", "article", "site", "website"], add: ["fetch", "web", "browse"] },
  {
    terms: ["remember", "recall", "memory", "earlier", "previously", "discussed", "decided"],
    add: ["memory", "recall", "history"],
  },
  {
    terms: ["remind", "reminder", "later", "tomorrow", "daily", "weekly", "recurring"],
    add: ["schedule", "automations", "cron", "reminder"],
  },
  { terms: ["say", "tell", "reply", "respond", "answer"], add: ["message", "send"] },
  { terms: ["picture", "photo", "meme", "screenshot"], add: ["image"] },
  { terms: ["speak", "say", "voice"], add: ["audio", "speech"] },
  { terms: ["run", "execute", "command", "shell", "terminal"], add: ["exec", "process"] },
  { terms: ["directory", "folder", "path"], add: ["file", "list"] },
];

// Repeat suffix stripping so "reminders" -> "reminder" -> "remind".
function stem(token: string): string {
  let current = token;
  for (let pass = 0; pass < 3; pass += 1) {
    const next = stripOneSuffix(current);
    if (next === current) {
      return current;
    }
    current = next;
  }
  return current;
}

// Preserve non-plurals: stemming "news" to "new" would favor "Create a new ..." tools.
const NON_PLURAL_S_WORDS = new Set([
  "news",
  "status",
  "alias",
  "canvas",
  "focus",
  "bonus",
  "virus",
  "atlas",
  "lens",
  "axis",
  "basis",
  "analysis",
  "gas",
  "bus",
  "plus",
]);

/** Suffixes whose stripping can expose a consonant doubled only by inflection. */
const UNDOUBLING_SUFFIXES = new Set(["ing", "ed", "er"]);
/** Doubles that belong to the root ("call", "process", "off", "buzz"). */
const KEPT_DOUBLE_CONSONANTS = new Set(["l", "s", "f", "z"]);

// Undo inflection's doubled consonants so "running" and "run" share a stem.
function undoubleFinalConsonant(token: string): string {
  const last = token.at(-1);
  if (
    !last ||
    last !== token.at(-2) ||
    KEPT_DOUBLE_CONSONANTS.has(last) ||
    "aeiou".includes(last) ||
    token.length <= 3
  ) {
    return token;
  }
  return token.slice(0, -1);
}

function stripOneSuffix(token: string): string {
  if (token.length <= 3 || NON_PLURAL_S_WORDS.has(token)) {
    return token;
  }
  for (const suffix of ["ies", "ing", "ed", "ly", "es", "er", "s", "e"]) {
    if (!token.endsWith(suffix) || token.length - suffix.length < 3) {
      continue;
    }
    // "ss" is part of the root ("process"), not a plural marker.
    if (suffix === "s" && token.endsWith("ss")) {
      continue;
    }
    // "repositories" -> "repository", not "repositori", or it never meets the
    // singular form the catalog is more likely to use.
    if (suffix === "ies") {
      return `${token.slice(0, -3)}y`;
    }
    const stripped = token.slice(0, -suffix.length);
    return UNDOUBLING_SUFFIXES.has(suffix) ? undoubleFinalConsonant(stripped) : stripped;
  }
  return token;
}

// Keep acronyms and their plural s together: "URLs" must not split into "UR"/"Ls".
const WORD_PARTS = /\p{Lu}+s?(?![\p{Ll}])|\p{Lu}?\p{Ll}+|\p{N}+/gu;

// Index whole identifiers plus underscore/camelCase parts; retain non-Latin words.
function splitWords(input: string): string[] {
  const words: string[] = [];
  for (const raw of input.split(/[^\p{L}\p{N}_]+/u)) {
    if (!raw) {
      continue;
    }
    words.push(raw.toLowerCase());
    const parts = raw.match(WORD_PARTS) ?? [];
    if (parts.length >= 2) {
      for (const part of parts) {
        words.push(part.toLowerCase());
      }
    }
  }
  return words;
}

// Emit both readings of ambiguous -ies plurals ("policies"/"cookies").
function stemVariants(word: string): string[] {
  if (word.length > 4 && word.endsWith("ies")) {
    const base = word.slice(0, -3);
    return [`${base}y`, stem(`${base}ie`)];
  }
  const stemmed = stem(word);
  return stemmed ? [stemmed] : [];
}

/** Indexable terms for one document, with stopwords dropped and roots collapsed. */
export function tokenizeDocument(input: string): string[] {
  return splitWords(input)
    .filter((word) => !STOPWORDS.has(word))
    .flatMap(stemVariants);
}

// Singularize triggers without full stemming, which can conflate unrelated intents.
function normalizeTrigger(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) {
    return `${word.slice(0, -3)}y`;
  }
  return word.length > 4 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;
}

const NORMALIZED_EXPANSIONS: ReadonlyArray<{
  triggers: readonly string[];
  add: readonly string[];
}> = QUERY_EXPANSIONS.map((group) => ({
  triggers: group.terms.map(normalizeTrigger),
  add: group.add.map(stem),
}));

// Discount inferred terms relative to the caller's own words.
const EXPANSION_WEIGHT = 0.35;

type WeightedTerm = { term: string; weight: number };

/** Query terms: literal words at full weight, expansions discounted. */
export function tokenizeQuery(input: string): WeightedTerm[] {
  const words = splitWords(input).filter((word) => !STOPWORDS.has(word));
  const weights = new Map<string, number>();
  for (const term of words.flatMap(stemVariants)) {
    weights.set(term, 1);
  }
  const triggers = new Set(words.map(normalizeTrigger));
  for (const group of NORMALIZED_EXPANSIONS) {
    if (!group.triggers.some((trigger) => triggers.has(trigger))) {
      continue;
    }
    for (const addition of group.add) {
      // A word the caller actually wrote keeps full weight.
      weights.set(addition, Math.max(weights.get(addition) ?? 0, EXPANSION_WEIGHT));
    }
  }
  return [...weights].map(([term, weight]) => ({ term, weight }));
}

type RankedDocument<T> = { value: T; terms: readonly string[] };

type IndexedDocument<T> = { readonly value: T; readonly length: number; readonly position: number };

type LexicalIndex<T> = {
  postings: ReadonlyMap<string, ReadonlyMap<IndexedDocument<T>, number>>;
  documentCount: number;
  averageLength: number;
};

export function buildLexicalIndex<T>(documents: ReadonlyArray<RankedDocument<T>>): LexicalIndex<T> {
  const postings = new Map<string, Map<IndexedDocument<T>, number>>();
  const documentCount = documents.length;
  let totalLength = 0;
  documents.forEach((document, position) => {
    const indexed = { value: document.value, length: document.terms.length, position };
    for (const term of document.terms) {
      let matches = postings.get(term);
      if (!matches) {
        matches = new Map();
        postings.set(term, matches);
      }
      matches.set(indexed, (matches.get(indexed) ?? 0) + 1);
    }
    totalLength += indexed.length;
  });
  return {
    postings,
    documentCount,
    averageLength: documentCount > 0 ? totalLength / documentCount : 0,
  };
}

/**
 * Okapi BM25; empty queries return no hits. Callers rank literal matches first:
 * rare expansions can still outscore a common literal despite their discount.
 */
export function scoreLexical<T>(
  index: LexicalIndex<T>,
  queryTerms: readonly WeightedTerm[],
): Array<{ value: T; score: number; matchedLiteral: boolean }> {
  if (queryTerms.length === 0 || index.documentCount === 0) {
    return [];
  }
  const total = index.documentCount;
  const results: Array<{ value: T; score: number; matchedLiteral: boolean }> = [];
  for (const { term, weight } of queryTerms) {
    const matches = index.postings.get(term);
    if (!matches) {
      continue;
    }
    const matching = matches.size;
    const idf = Math.log(1 + (total - matching + 0.5) / (matching + 0.5));
    for (const [document, frequency] of matches) {
      let result = results[document.position];
      if (!result) {
        result = { value: document.value, score: 0, matchedLiteral: false };
        results[document.position] = result;
      }
      if (weight >= 1) {
        result.matchedLiteral = true;
      }
      const normalized = index.averageLength > 0 ? document.length / index.averageLength : 1;
      result.score +=
        (weight * (idf * (frequency * (BM25_K1 + 1)))) /
        (frequency + BM25_K1 * (1 - BM25_B + BM25_B * normalized));
    }
  }
  // Sparse slots keep document positions; filter skips holes and preserves catalog order.
  return results.filter((result) => result.score > 0);
}
