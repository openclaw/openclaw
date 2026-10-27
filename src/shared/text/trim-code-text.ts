import { findCodeRegions } from "./code-ranges.js";

/** Trim surrounding padding without removing Markdown block indentation. */
export function trimTextPreservingCode(
  text: string,
  mode: "start" | "both" = "both",
  codeRegions?: ReturnType<typeof findCodeRegions>,
): string {
  let trimmed = text.trimStart();
  if (trimmed && trimmed.length !== text.length) {
    const contentStart = text.length - trimmed.length;
    const leadingCode = (codeRegions ?? findCodeRegions(text)).find(
      (region) =>
        (region.block || (codeRegions && region.start === 0)) &&
        region.start <= contentStart &&
        contentStart < region.end,
    );
    if (leadingCode) {
      trimmed = text.slice(leadingCode.start);
    }
  }
  if (mode === "both") {
    const contentEnd = text.trimEnd().length;
    if (codeRegions?.some((region) => region.start <= contentEnd && region.end === text.length)) {
      return trimmed;
    }
    return trimmed.trimEnd();
  }
  return trimmed;
}
