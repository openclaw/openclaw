import { fnv1aUtf16 } from "../../lib/fnv1a.ts";

export type ConfigHintTranslationField = "label" | "help";

export function configHintTranslationKey(
  hintPath: string,
  field: ConfigHintTranslationField,
  sourceText: string,
): string {
  const prefix = `configHints.${encodeURIComponent(hintPath).replaceAll(".", "%2E")}.${field}.`;
  const normalizedSource = sourceText.trim().split(/\s+/).join(" ");
  return `${prefix}v1-${fnv1aUtf16(normalizedSource).toString(36)}-${normalizedSource.length.toString(36)}`;
}
