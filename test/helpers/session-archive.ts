import fs from "node:fs";
import { zstdDecompressSync } from "node:zlib";

/** Reads an archive with Node's own decoder so fixtures never validate the encoder against itself. */
export function readSessionArchiveText(filePath: string): string {
  const bytes = fs.readFileSync(filePath);
  return (filePath.endsWith(".zst") ? zstdDecompressSync(bytes) : bytes).toString("utf8");
}

function xorshift(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function skewedPick<T>(items: readonly T[], next: () => number): T {
  return items[Math.floor(next() ** 1.5 * items.length)]!;
}

// One session shares its vocabulary; transcripts repeat phrases, paths, and tool output.
const vocabularyRandom = xorshift(0x5eed);
const words = Array.from({ length: 600 }, () =>
  Array.from({ length: 2 + Math.floor(vocabularyRandom() * 9) }, () =>
    skewedPick("etaoinshrdlucmfwypvbgkjqxz".split(""), vocabularyRandom),
  ).join(""),
);
const sentences = Array.from({ length: 400 }, () =>
  Array.from({ length: 6 + Math.floor(vocabularyRandom() * 14) }, () =>
    skewedPick(words, vocabularyRandom),
  ).join(" "),
);

/**
 * Deterministic prose that zstd compresses like production transcripts
 * (about 10x; team archives: p50 6.5x, p90 11.7x), unlike repeated characters.
 */
export function realisticTranscriptText(bytes: number, seed = 1): string {
  const next = xorshift(seed);
  const parts: string[] = [];
  let length = 0;
  while (length < bytes) {
    const part = next() < 0.3 ? skewedPick(sentences, next) : skewedPick(words, next);
    parts.push(part);
    length += part.length + 2;
  }
  return parts.join(". ").slice(0, bytes);
}
