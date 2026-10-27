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
import {
  createConditionalTextProjector,
  type TextFilter,
  type TextProjector,
} from "./text-projection.js";
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
      let retained: { prefix: string; tail: string } | undefined;
      let projection: ToolCallXmlProjection = {
        appendSafe: false,
        resolveCodeOwnership: findCodeOwnership,
      };
      const transform = (text: string) => {
        retained = undefined;
        codeRegions = undefined;
        projection = { appendSafe: false, resolveCodeOwnership: findCodeOwnership };
        if (heldPrefix !== undefined) {
          return text.slice(0, heldPrefix);
        }
        ownership = /[`~\t]| {4}/u.test(text) ? findCodeOwnership(text) : undefined;
        sourceTail = text.slice(-4);
        projection.appendSafe = true;
        const visible = stripToolCallXmlTagsInternal(
          text,
          options,
          streaming,
          () => ownership?.regions ?? [],
          projection,
        );
        if (ownership) {
          // Inline code can become image or link-title text after later Markdown arrives.
          const prefix = visible === text ? text.slice(0, ownership.retainStart).trimEnd() : "";
          retained = { prefix, tail: visible.slice(prefix.length) };
        }
        return visible;
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
            if (!codeRegions) {
              const parsed =
                protectionScan.structuralUnknown && /[`~\t]| {4}/u.test(text)
                  ? findCodeOwnership(text)
                  : undefined;
              codeRegions = parsed?.regions ?? findCodeRegions(text);
              if (parsed) {
                const block = parsed.regions.at(-1);
                if (
                  block?.block &&
                  block.start === parsed.retainStart &&
                  block.end === text.length
                ) {
                  const lineStart = text.lastIndexOf("\n", block.start - 1) + 1;
                  if (/^ {0,3}$/.test(text.slice(lineStart, block.start))) {
                    // The canonical retained block can restore known fence state after
                    // earlier ambiguous syntax; containers and references retain earlier source.
                    const recovered = createProtectionScanState();
                    advanceProtectionScanState(recovered, text.slice(block.start));
                    if (recovered.fenceChar && !recovered.structuralUnknown) {
                      Object.assign(protectionScan, recovered);
                    }
                  }
                }
              }
            }
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
      const render: TextProjector = (input) => {
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
          if (retained) {
            retained = { prefix: retained.prefix, tail: retained.tail + delta };
          }
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
      return (input) => {
        const result = render(input);
        const upstream =
          result.retained ?? (input.retained ? { prefix: "", tail: result.text } : undefined);
        const settled =
          retained && (!upstream || retained.prefix.length < upstream.prefix.length)
            ? retained
            : upstream;
        return settled ? { ...result, retained: settled } : result;
      };
    },
  };
}
