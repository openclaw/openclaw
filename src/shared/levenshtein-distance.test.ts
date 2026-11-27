import { describe, expect, it } from "vitest";
import { levenshteinDistance } from "./levenshtein-distance.js";

// Full matrix reference: no cutoff, row reuse, or early exit.
function referenceDistance(left: string, right: string): number {
  const matrix = Array.from({ length: left.length + 1 }, (_, i) =>
    Array.from({ length: right.length + 1 }, (_value, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      matrix[i]![j] = Math.min(
        matrix[i - 1]![j]! + 1,
        matrix[i]![j - 1]! + 1,
        matrix[i - 1]![j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    }
  }
  return matrix[left.length]![right.length]!;
}

describe("levenshteinDistance", () => {
  it.each([
    ["", "", 0],
    ["", "abc", 3],
    ["abc", "", 3],
    ["kitten", "sitting", 3],
    ["ab", "ba", 2],
    ["😀", "😃", 1],
    ["😀", "a", 2],
  ] as const)("keeps the full UTF-16 distance from %j to %j", (left, right, expected) => {
    const distance: number = levenshteinDistance(left, right);
    expect(distance).toBe(expected);
  });

  it.each([
    ["same", "same", 0, 0],
    ["", "abc", 3, null],
    ["abc", "", 3, null],
    ["a", "abcde", 3, null],
    ["kitten", "sitting", 3, 3],
    ["kitten", "sitting", 2, null],
    ["ab", "ba", 1, null],
    ["😀", "😃", 1, 1],
    ["😀", "a", 1, null],
  ] as const)("bounds the distance from %j to %j at %i", (left, right, bound, expected) => {
    expect(levenshteinDistance(left, right, bound)).toBe(expected);
  });

  it("preserves full and bounded distances across filenames and seeded UTF-16 strings", () => {
    const names = [
      "AGENTS.md",
      "README.md",
      "package.json",
      "pnpm-lock.yaml",
      "tsconfig.json",
      "levenshtein-distance.test.ts",
      "read.ts",
      "session-12345678-1234-1234-1234-123456789abc.jsonl",
      "résumé.txt",
      "re\u0301sume\u0301.txt",
      "🦞.md",
      "",
    ];
    let seed = 2141;
    const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    const alphabet = "abCD09_-.é\u0301🦞";
    const randomString = () =>
      Array.from({ length: random() % 65 }, () => alphabet[random() % alphabet.length]).join("");
    const pairs = names.flatMap((left) => names.map((right) => [left, right] as const));
    pairs.push(...Array.from({ length: 200 }, () => [randomString(), randomString()] as const));
    for (const [left, right] of pairs) {
      const distance = referenceDistance(left, right);
      expect(levenshteinDistance(left, right)).toBe(distance);
      for (const bound of [0, 1, 3, Math.floor(left.length * 0.4), distance, Infinity]) {
        // Preserve the existing bounded empty-string contract, including equality first.
        const expected = left === right ? 0 : !left || !right || distance > bound ? null : distance;
        expect(
          levenshteinDistance(left, right, bound),
          JSON.stringify({ left, right, bound }),
        ).toBe(expected);
      }
    }
  });
});
