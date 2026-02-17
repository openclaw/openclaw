/**
 * Query expansion for FTS-only search mode.
 *
 * When no embedding provider is available, we fall back to FTS (full-text search).
 * FTS works best with specific keywords, but users often ask conversational queries
 * like "that thing we discussed yesterday" or "之前讨论的那个方案".
 *
 * This module extracts meaningful keywords from such queries to improve FTS results.
 */

// Common stop words that don't add search value
const STOP_WORDS_EN = new Set([
  // Articles and determiners
  "a",
  "an",
  "the",
  "this",
  "that",
  "these",
  "those",
  // Pronouns
  "i",
  "me",
  "my",
  "we",
  "our",
  "you",
  "your",
  "he",
  "she",
  "it",
  "they",
  "them",
  // Common verbs
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "can",
  "may",
  "might",
  // Prepositions
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "with",
  "by",
  "from",
  "about",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "between",
  "under",
  "over",
  // Conjunctions
  "and",
  "or",
  "but",
  "if",
  "then",
  "because",
  "as",
  "while",
  "when",
  "where",
  "what",
  "which",
  "who",
  "how",
  "why",
  // Time references (vague, not useful for FTS)
  "yesterday",
  "today",
  "tomorrow",
  "earlier",
  "later",
  "recently",
  "before",
  "ago",
  "just",
  "now",
  // Vague references
  "thing",
  "things",
  "stuff",
  "something",
  "anything",
  "everything",
  "nothing",
  // Question words
  "please",
  "help",
  "find",
  "show",
  "get",
  "tell",
  "give",
]);

const STOP_WORDS_ZH = new Set([
  // Pronouns
  "我",
  "我们",
  "你",
  "你们",
  "他",
  "她",
  "它",
  "他们",
  "这",
  "那",
  "这个",
  "那个",
  "这些",
  "那些",
  // Auxiliary words
  "的",
  "了",
  "着",
  "过",
  "得",
  "地",
  "吗",
  "呢",
  "吧",
  "啊",
  "呀",
  "嘛",
  "啦",
  // Verbs (common, vague)
  "是",
  "有",
  "在",
  "被",
  "把",
  "给",
  "让",
  "用",
  "到",
  "去",
  "来",
  "做",
  "说",
  "看",
  "找",
  "想",
  "要",
  "能",
  "会",
  "可以",
  // Prepositions and conjunctions
  "和",
  "与",
  "或",
  "但",
  "但是",
  "因为",
  "所以",
  "如果",
  "虽然",
  "而",
  "也",
  "都",
  "就",
  "还",
  "又",
  "再",
  "才",
  "只",
  // Time (vague)
  "之前",
  "以前",
  "之后",
  "以后",
  "刚才",
  "现在",
  "昨天",
  "今天",
  "明天",
  "最近",
  // Vague references
  "东西",
  "事情",
  "事",
  "什么",
  "哪个",
  "哪些",
  "怎么",
  "为什么",
  "多少",
  // Question/request words
  "请",
  "帮",
  "帮忙",
  "告诉",
]);

/**
 * Check if a token looks like a meaningful keyword.
 * Returns false for short tokens, numbers-only, etc.
 */
function isValidKeyword(token: string): boolean {
  if (!token || token.length === 0) {
    return false;
  }
  // Skip very short English words (likely stop words or fragments)
  if (/^[a-zA-Z]+$/.test(token) && token.length < 3) {
    return false;
  }
  // Skip pure numbers (not useful for semantic search)
  if (/^\d+$/.test(token)) {
    return false;
  }
  // Skip tokens that are all punctuation
  if (/^[\p{P}\p{S}]+$/u.test(token)) {
    return false;
  }
  return true;
}

/**
 * Simple tokenizer that handles both English and Chinese text.
 * For Chinese, we do character-based splitting since we don't have a proper segmenter.
 * For English, we split on whitespace and punctuation.
 */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const normalized = text.toLowerCase().trim();

  // Split into segments (English words, Chinese character sequences, etc.)
  const segments = normalized.split(/[\s\p{P}]+/u).filter(Boolean);

  for (const segment of segments) {
    // Check if segment contains CJK characters
    if (/[\u4e00-\u9fff]/.test(segment)) {
      // For Chinese, extract character n-grams (unigrams and bigrams)
      const chars = Array.from(segment).filter((c) => /[\u4e00-\u9fff]/.test(c));
      // Add individual characters
      tokens.push(...chars);
      // Add bigrams for better phrase matching
      for (let i = 0; i < chars.length - 1; i++) {
        tokens.push(chars[i] + chars[i + 1]);
      }
    } else {
      // For non-CJK, keep as single token
      tokens.push(segment);
    }
  }

  return tokens;
}

/**
 * Extract keywords from a conversational query for FTS search.
 *
 * Examples:
 * - "that thing we discussed about the API" → ["discussed", "API"]
 * - "之前讨论的那个方案" → ["讨论", "方案"]
 * - "what was the solution for the bug" → ["solution", "bug"]
 */
export function extractKeywords(query: string): string[] {
  const tokens = tokenize(query);
  const keywords: string[] = [];
  const seen = new Set<string>();

  for (const token of tokens) {
    // Skip stop words
    if (STOP_WORDS_EN.has(token) || STOP_WORDS_ZH.has(token)) {
      continue;
    }
    // Skip invalid keywords
    if (!isValidKeyword(token)) {
      continue;
    }
    // Skip duplicates
    if (seen.has(token)) {
      continue;
    }
    seen.add(token);
    keywords.push(token);
  }

  return keywords;
}

/**
 * Expand a query for FTS search.
 * Returns both the original query and extracted keywords for OR-matching.
 *
 * @param query - User's original query
 * @returns Object with original query and extracted keywords
 */
export function expandQueryForFts(query: string): {
  original: string;
  keywords: string[];
  expanded: string;
} {
  const original = query.trim();
  const keywords = extractKeywords(original);

  // Build expanded query: original terms OR extracted keywords
  // This ensures both exact matches and keyword matches are found
  const expanded = keywords.length > 0 ? `${original} OR ${keywords.join(" OR ")}` : original;

  return { original, keywords, expanded };
}

/**
 * Type for an optional LLM-based query expander.
 * Can be provided to enhance keyword extraction with semantic understanding.
 */
export type LlmQueryExpander = (query: string) => Promise<string[]>;

/**
 * Expand query with optional LLM assistance.
 * Falls back to local extraction if LLM is unavailable or fails.
 */
export async function expandQueryWithLlm(
  query: string,
  llmExpander?: LlmQueryExpander,
): Promise<string[]> {
  // If LLM expander is provided, try it first
  if (llmExpander) {
    try {
      const llmKeywords = await llmExpander(query);
      if (llmKeywords.length > 0) {
        return llmKeywords;
      }
    } catch {
      // LLM failed, fall back to local extraction
    }
  }

  // Fall back to local keyword extraction
  return extractKeywords(query);
}
