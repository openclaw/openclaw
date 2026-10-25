import {
  advanceProtectionScanState,
  createProtectionScanState,
} from "../../../packages/tool-call-repair/src/protection-fast-path.js";
import {
  canReuseMarkdownOwnership,
  findCodeOwnership,
  findCodeRegions,
  isInsideSettledBlockCode,
} from "./code-regions.js";
import { createConditionalTextProjector, type TextFilter } from "./text-projection.js";
import {
  isToolCallTagPrefix,
  stripToolCallXmlTagsInternal,
  TOOL_CALL_QUICK_RE,
  type ToolCallXmlProjection,
  type StripToolCallXmlOptions,
} from "./tool-call-xml-transform.js";
export { stripToolCallXmlTags } from "./tool-call-xml-transform.js";

export function toolCallXmlTextFilter(
  options: StripToolCallXmlOptions = {},
  streaming = false,
): TextFilter {
  return {
    transform: (text) => stripToolCallXmlTagsInternal(text, options, streaming),
    create: () => {
      let scannedThrough = 0;
      let active = false;
      let codeRegions: ReturnType<typeof findCodeRegions> | undefined;
      const protectionScan = createProtectionScanState();
      let heldPrefix: number | undefined;
      let source = "";
      let sourceTail = "";
      let output = "";
      let ownership: ReturnType<typeof findCodeOwnership> | undefined;
      let projection: ToolCallXmlProjection = {
        appendSafe: false,
        resolveCodeOwnership: findCodeOwnership,
      };
      const transform = (text: string) => {
        codeRegions = undefined;
        projection = { appendSafe: false, resolveCodeOwnership: findCodeOwnership };
        if (heldPrefix !== undefined) {
          return text.slice(0, heldPrefix);
        }
        ownership = /[`~\t]| {4}/u.test(text) ? findCodeOwnership(text) : undefined;
        sourceTail = text.slice(-4);
        projection.appendSafe = true;
        return stripToolCallXmlTagsInternal(
          text,
          options,
          streaming,
          () => ownership?.regions ?? [],
          projection,
        );
      };
      const project = createConditionalTextProjector(transform, ({ text, delta }) => {
        heldPrefix = undefined;
        const appended = delta ?? text;
        advanceProtectionScanState(protectionScan, appended);
        if (scannedThrough === text.length - appended.length && !appended.includes("<")) {
          scannedThrough = text.length;
          return false;
        }
        let deferredStart: number | undefined;
        for (let start = text.indexOf("<", scannedThrough); start !== -1;) {
          const next = text.indexOf("<", start + 1);
          const candidate = text.slice(start, next === -1 ? text.length : next);
          // Markdown ownership can only matter for a candidate that could begin a
          // tool-call tag; ordinary markup must not re-parse the whole reply.
          const quickCandidate = TOOL_CALL_QUICK_RE.test(candidate);
          const prefixCandidate = isToolCallTagPrefix(candidate, 0);
          if (quickCandidate || prefixCandidate) {
            const onCurrentLine = candidate.length <= protectionScan.partialLine.length;
            if (next === -1 && onCurrentLine && prefixCandidate && !quickCandidate) {
              // Only the unfinished candidate line can be classified from the carried tail.
              const completed = { ...protectionScan };
              advanceProtectionScanState(completed, "\n");
              if (!completed.paragraphAmbiguous && !completed.structuralUnknown) {
                if (completed.fenceChar) {
                  deferredStart = start;
                  start = next;
                  continue;
                }
                if (streaming) {
                  heldPrefix = start;
                  scannedThrough = start;
                  return true;
                }
              }
            }
            codeRegions ??= findCodeRegions(text);
            const protectedBlock = isInsideSettledBlockCode(start, text, codeRegions);
            if (!protectedBlock && quickCandidate) {
              active = true;
              return true;
            }
            if (!protectedBlock && prefixCandidate) {
              scannedThrough = start;
              return true;
            }
          }
          start = next;
        }
        scannedThrough = deferredStart ?? text.length;
        codeRegions = undefined;
        return false;
      });
      return (input) => {
        if (!active) {
          const result = project(input);
          source = input.text;
          output = result.text;
          return result;
        }
        const delta = input.delta;
        const parameterText = projection.parameterText;
        if (
          delta !== null &&
          projection.appendSafe &&
          !delta.includes("<") &&
          // With no code markers in the source, only their append boundary can create code.
          canReuseMarkdownOwnership(
            ownership ? source : sourceTail,
            ownership ? input.text : sourceTail + delta,
            ownership,
          ) &&
          (parameterText === undefined ||
            canReuseMarkdownOwnership(
              parameterText,
              parameterText + delta,
              projection.parameterOwnership,
            ))
        ) {
          if (parameterText !== undefined) {
            const next = parameterText + delta;
            projection.parameterText = projection.parameterOwnership ? next : next.slice(-4);
          }
          source = input.text;
          sourceTail = (sourceTail + delta).slice(-4);
          output += delta;
          return { text: output, delta };
        }
        // Refresh the canonical result when XML or Markdown can revise earlier text.
        const previous = output;
        heldPrefix = undefined;
        output = transform(input.text);
        source = input.text;
        return {
          text: output,
          delta:
            delta === null
              ? null
              : output.startsWith(previous)
                ? output.slice(previous.length)
                : null,
        };
      };
    },
  };
}
