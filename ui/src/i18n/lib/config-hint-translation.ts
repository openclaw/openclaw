import { fnv1aUtf16 } from "../../../../src/shared/fnv1a.js";

export function configHintTranslationKey(
  hintPath: string,
  field: "label" | "help",
  sourceText: string,
): string {
  const prefix = `configHints.${encodeURIComponent(hintPath).replaceAll(".", "%2E")}.${field}.`;
  const normalizedSource = sourceText.trim().split(/\s+/).join(" ");
  return `${prefix}v1-${fnv1aUtf16(normalizedSource).toString(36)}-${normalizedSource.length.toString(36)}`;
}
