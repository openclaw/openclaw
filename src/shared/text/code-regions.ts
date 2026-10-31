import { scanFenceSpans } from "../../../packages/markdown-core/src/fences.js";
import { findMarkdownCodeOwnership as findCodeOwnership } from "../../../packages/markdown-core/src/markdown-code-regions.js";
import {
  advanceProtectionScanState,
  createProtectionScanState,
} from "../../../packages/tool-call-repair/src/protection-fast-path.js";
import { findCodeRegions } from "./code-ranges.js";

export { findCodeOwnership, findCodeRegions };
export type { CodeRegion } from "./code-ranges.js";

export {
  createTextPartCodeRegionResolver,
  isInsideCode,
  isInsideSettledBlockCode,
  stripLinesOutsideCode,
  projectLinesOutsideCode,
} from "./code-ranges.js";

/** Stable retained Markdown boundary and the context required to resume its tail. */
export function findTextCheckpoint(
  text: string,
  referenceLength: number,
  resolveOwnership: (text: string) => ReturnType<typeof findCodeOwnership>,
): {
  offset: number;
  context: string;
  definitions?: ReturnType<typeof findCodeOwnership>["definitions"];
} {
  const state = createProtectionScanState();
  let cursor = referenceLength;
  let lastLineStart = cursor;
  let closedFence = false;
  for (let end = text.indexOf("\n", cursor); end !== -1; end = text.indexOf("\n", cursor)) {
    const line = text.slice(cursor, end + 1);
    const inFence = Boolean(state.fenceChar);
    advanceProtectionScanState(state, line);
    // References, image descriptions, and setext headings can need earlier paragraph context.
    if (
      state.paragraphAmbiguous ||
      state.structuralUnknown ||
      (!inFence && !state.fenceChar && /\[|^ {0,3}=+[ \t]*\r?\n$/.test(line))
    ) {
      const ownership = resolveOwnership(text);
      if (ownership.continuation) {
        return { ...ownership.continuation, definitions: ownership.definitions };
      }
      const retain = ownership.retainStart;
      let start = retain === 0 ? 0 : text.lastIndexOf("\n", retain - 1) + 1;
      const startsDefinition = ownership.definitions.some(
        (definition) =>
          definition.start >= start && /^[ \t]*$/.test(text.slice(start, definition.start)),
      );
      if (!startsDefinition) {
        const adjacentDefinition = ownership.definitions.findLast(
          (definition) =>
            definition.end <= start &&
            /^[ \t]*(?:\r\n|\r|\n)[ \t]*$/.test(text.slice(definition.end, start)),
        );
        // A synthetic blank after a definition would turn adjacent indented prose into code.
        if (adjacentDefinition) {
          start = text.lastIndexOf("\n", adjacentDefinition.start - 1) + 1;
        }
      }
      const completeEnd = text.lastIndexOf("\n") + 1;
      if (
        !/\r(?!\n)/.test(text) &&
        ownership.regions.some((region) => region.block && region.start === retain)
      ) {
        const fence = scanFenceSpans(text.slice(start, completeEnd)).state.open;
        if (fence) {
          return {
            offset: completeEnd,
            context: fence.marker + "\n",
            definitions: ownership.definitions,
          };
        }
      }
      return { offset: start, context: "", definitions: ownership.definitions };
    }
    lastLineStart = cursor;
    cursor = end + 1;
    closedFence = inFence && !state.fenceChar;
  }
  if (state.fenceChar) {
    // Only the proven top-level fence is carried; its settled body is never parsed again.
    return { offset: cursor, context: state.fenceChar.repeat(state.fenceLength) + "\n" };
  }
  return { offset: closedFence ? cursor : lastLineStart, context: "" };
}

/** Reuse a parsed prefix only when an append cannot change Markdown ownership. */
export function canReuseMarkdownOwnership(
  previousText: string,
  nextText: string,
  ownership?: ReturnType<typeof findCodeOwnership>,
): boolean {
  if (!nextText.startsWith(previousText)) {
    return false;
  }
  return canReuseMarkdownOwnershipForAppend(
    previousText,
    nextText.slice(previousText.length),
    ownership,
  );
}

/** Reuse a parsed prefix only when appending `appended` cannot change Markdown ownership. */
export function canReuseMarkdownOwnershipForAppend(
  previousText: string,
  appended: string,
  ownership?: ReturnType<typeof findCodeOwnership>,
): boolean {
  if (!appended) {
    return true;
  }
  const previousBoundary = previousText.slice(-4);
  const boundary = previousBoundary + appended;
  if (
    /[`~\t|]| {4}/u.test(boundary) ||
    (/-{3,}/u.test(boundary) && !/-{3,}/u.test(previousBoundary)) ||
    /(?:-{1,2}:|:-{1,2}|:-{1,2}:)(?=[ \t]*(?:\||\r?\n|\r|$))/u.test(boundary) ||
    (/[-:][ \t]*$/u.test(previousBoundary) && /\S/u.test(appended))
  ) {
    return false;
  }
  if (!ownership) {
    return true;
  }
  if (ownership.regions.length === 0 && ownership.unsettledDefinitionStarts.length === 0) {
    return true;
  }
  if (ownership.unsettledParagraph) {
    // Plain continuation lines cannot settle this paragraph or close its pending syntax.
    return (
      !/[[\]()<>'":=*+#_\\-]/u.test(appended) &&
      !/(?:\r\n|\r(?!\n)|\n)[ \t]*[\r\n]/u.test(boundary) &&
      !/\d\.[ \t]/u.test(boundary)
    );
  }
  if (ownership.unsettledDefinitionStarts.length > 0) {
    return false;
  }
  // Only ordinary prose can extend an owned prefix unchanged. Structural bytes
  // invalidate it directly instead of rescanning old link/reference candidates.
  return !/[\r\n[\]()<>'":=*+\\-]/u.test(appended);
}
