/** Fold search case without changing callers' whitespace or Unicode normalization. */
export function foldSearchCase(value: string): string {
  // Lowercasing chooses final sigma from word context; substring queries may lack that context.
  return value.toLowerCase().replace(/ς/g, "σ");
}
