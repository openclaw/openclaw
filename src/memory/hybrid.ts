export type HybridSource = string;

export type HybridVectorResult = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  source: HybridSource;
  snippet: string;
  vectorScore: number;
};

export type HybridKeywordResult = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  source: HybridSource;
  snippet: string;
  textScore: number;
};

/**
 * Regex matching a single CJK ideograph, kana, or bopomofo character.
 *
 * Included ranges (letters/ideographs only, no punctuation):
 *  - U+2E80–U+2EFF  CJK Radicals Supplement
 *  - U+3040–U+309F  Hiragana
 *  - U+30A0–U+30FF  Katakana
 *  - U+3100–U+312F  Bopomofo
 *  - U+3400–U+4DBF  CJK Unified Ideographs Extension A
 *  - U+4E00–U+9FFF  CJK Unified Ideographs
 *  - U+F900–U+FAFF  CJK Compatibility Ideographs
 *
 * Deliberately excludes CJK punctuation (U+3000–U+303F), fullwidth forms
 * (U+FF00–U+FFEF), and other symbol blocks so punctuation remains a separator.
 */
const CJK_CHAR_REGEX =
  /[\u2e80-\u2eff\u3040-\u309f\u30a0-\u30ff\u3100-\u312f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/**
 * Add spaces around every CJK character so the unicode61 tokenizer treats each
 * character as its own token.  Non-CJK text (Latin, digits, etc.) is untouched.
 *
 * This must be applied symmetrically: both when **inserting** text into FTS5 and
 * when **building the query**, so the tokens match.
 */
export function segmentCjk(text: string): string {
  let out = "";
  for (const ch of text) {
    if (CJK_CHAR_REGEX.test(ch)) {
      out += ` ${ch} `;
    } else {
      out += ch;
    }
  }
  // Collapse runs of whitespace that the insertion may create.
  return out.replace(/\s{2,}/g, " ").trim();
}

export function buildFtsQuery(raw: string): string | null {
  // Segment CJK characters so they become individual FTS tokens.
  const segmented = segmentCjk(raw);

  // Match ASCII word tokens AND individual CJK characters.
  const tokens =
    segmented
      .match(
        /[A-Za-z0-9_]+|[\u2e80-\u2eff\u3040-\u309f\u30a0-\u30ff\u3100-\u312f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g,
      )
      ?.map((t) => t.trim())
      .filter(Boolean) ?? [];
  if (tokens.length === 0) {
    return null;
  }
  const quoted = tokens.map((t) => `"${t.replaceAll('"', "")}"`);
  return quoted.join(" AND ");
}

export function bm25RankToScore(rank: number): number {
  const normalized = Number.isFinite(rank) ? Math.max(0, rank) : 999;
  return 1 / (1 + normalized);
}

export function mergeHybridResults(params: {
  vector: HybridVectorResult[];
  keyword: HybridKeywordResult[];
  vectorWeight: number;
  textWeight: number;
}): Array<{
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: HybridSource;
}> {
  const byId = new Map<
    string,
    {
      id: string;
      path: string;
      startLine: number;
      endLine: number;
      source: HybridSource;
      snippet: string;
      vectorScore: number;
      textScore: number;
    }
  >();

  for (const r of params.vector) {
    byId.set(r.id, {
      id: r.id,
      path: r.path,
      startLine: r.startLine,
      endLine: r.endLine,
      source: r.source,
      snippet: r.snippet,
      vectorScore: r.vectorScore,
      textScore: 0,
    });
  }

  for (const r of params.keyword) {
    const existing = byId.get(r.id);
    if (existing) {
      existing.textScore = r.textScore;
      if (r.snippet && r.snippet.length > 0) {
        existing.snippet = r.snippet;
      }
    } else {
      byId.set(r.id, {
        id: r.id,
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
        source: r.source,
        snippet: r.snippet,
        vectorScore: 0,
        textScore: r.textScore,
      });
    }
  }

  const merged = Array.from(byId.values()).map((entry) => {
    const score = params.vectorWeight * entry.vectorScore + params.textWeight * entry.textScore;
    return {
      path: entry.path,
      startLine: entry.startLine,
      endLine: entry.endLine,
      score,
      snippet: entry.snippet,
      source: entry.source,
    };
  });

  return merged.toSorted((a, b) => b.score - a.score);
}
