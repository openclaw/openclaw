/**
 * Fuzzy search scoring for the command palette.
 *
 * Scores a query against a target string using an in-order character
 * matching algorithm with bonuses for:
 *  - Exact match
 *  - Prefix match
 *  - Substring match (with position penalty)
 *  - Consecutive character runs
 *  - Word-boundary alignment
 *
 * Exported separately so the scoring logic is reusable and independently
 * testable outside of the UI render layer.
 */

/**
 * Score a single query term against a single text string.
 * Returns 0 when there is no match.
 */
export function fuzzyScorePart(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  const t = text.trim().toLowerCase();

  if (!q) return 0;
  if (!t) return 0;

  // Exact match — highest possible score.
  if (t === q) return 1000;

  // Prefix match — strong signal.
  if (t.startsWith(q)) return 700;

  // Substring match — decent signal; penalise distance from start.
  const containsAt = t.indexOf(q);
  if (containsAt !== -1) {
    return 500 - Math.min(containsAt * 5, 250);
  }

  // Fuzzy in-order character match. Reward consecutive runs and
  // word-boundary alignment.
  let score = 0;
  let qIndex = 0;
  let consecutive = 0;

  for (let i = 0; i < t.length && qIndex < q.length; i++) {
    if (t[i] === q[qIndex]) {
      const isWordBoundary =
        i === 0 ||
        t[i - 1] === " " ||
        t[i - 1] === "-" ||
        t[i - 1] === "_" ||
        t[i - 1] === "/";

      score += 12 + consecutive * 6 + (isWordBoundary ? 10 : 0);
      consecutive++;
      qIndex++;
    } else {
      consecutive = 0;
    }
  }

  // Every query character must have been matched.
  if (qIndex < q.length) return 0;

  // Prefer shorter target strings when scores are otherwise similar.
  return score - Math.min(t.length, 100) * 0.25;
}

/**
 * Represents a searchable command item for scoring purposes.
 * Mirrors the `Command` type's searchable fields.
 */
export interface Scorable {
  label: string;
  id: string;
  category?: string;
}

/**
 * Score a command against a (possibly multi-term) query.
 * Each whitespace-separated term must match at least one field
 * (label, category, id) or the command is rejected (returns 0).
 */
export function scoreCommand<T extends Scorable>(cmd: T, query: string): number {
  const parts = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  if (parts.length === 0) return 0;

  let total = 0;
  for (const part of parts) {
    const labelScore = fuzzyScorePart(part, cmd.label);
    const categoryScore = cmd.category ? fuzzyScorePart(part, cmd.category) * 0.8 : 0;
    const idScore = fuzzyScorePart(part, cmd.id) * 0.3;

    const best = Math.max(labelScore, categoryScore, idScore);
    if (best <= 0) return 0; // every term must match *something*
    total += best;
  }

  return total;
}

/**
 * Filter and sort a list of scorable items by fuzzy relevance.
 * Returns items whose score is > 0, sorted highest-first.
 * When query is empty all items are returned in their original order.
 */
export function filterByFuzzy<T extends Scorable>(items: T[], query: string): T[] {
  if (!query.trim()) return items;

  return items
    .map((item, index) => ({ item, index, score: scoreCommand(item, query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => {
      const scoreDiff = b.score - a.score;
      if (scoreDiff !== 0) return scoreDiff;
      // Stable: preserve original order for tied scores.
      return a.index - b.index;
    })
    .map((entry) => entry.item);
}
