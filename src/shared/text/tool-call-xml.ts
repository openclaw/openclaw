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
      let scanTail = "";
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
      let transformed = false;
      const transform = (text: string) => {
        transformed = true;
        retained = undefined;
        codeRegions = undefined;
        projection = { appendSafe: false, resolveCodeOwnership: findCodeOwnership };
        if (heldPrefix !== undefined) {
          // The caller hides the unfinished tag; returning `text` keeps whole-reply
          // prefix comparisons out of the per-delta path.
          return text;
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
        if (delta !== null && scanTail === "" && !appended.includes("<")) {
          return false;
        }
        // Scan carried bytes plus the append instead of the whole reply; searching the
        // accumulated string here would copy it once per delta on non-flat ropes.
        const window = delta === null ? text : scanTail + appended;
        const windowStart = text.length - window.length;
        let deferredStart: number | undefined;
        for (let relative = window.indexOf("<"); relative !== -1;) {
          const nextRelative = window.indexOf("<", relative + 1);
          const start = windowStart + relative;
          const candidate = window.slice(
            relative,
            nextRelative === -1 ? window.length : nextRelative,
          );
          // Markdown ownership can only matter for a candidate that could begin a
          // tool-call tag; ordinary markup must not re-parse the whole reply.
          const quickCandidate = TOOL_CALL_QUICK_RE.test(candidate);
          const prefixCandidate = isToolCallTagPrefix(candidate, 0);
          if (quickCandidate || prefixCandidate) {
            const onCurrentLine = candidate.length <= protectionScan.partialLine.length;
            if (nextRelative === -1 && onCurrentLine && prefixCandidate && !quickCandidate) {
              // Only the unfinished candidate line can be classified from the carried tail.
              const completed = { ...protectionScan };
              advanceProtectionScanState(completed, "\n");
              if (!completed.paragraphAmbiguous && !completed.structuralUnknown) {
                if (completed.fenceChar) {
                  deferredStart = start;
                  relative = nextRelative;
                  continue;
                }
                if (streaming) {
                  heldPrefix = start;
                  scanTail = window.slice(relative);
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
              scanTail = window.slice(relative);
              return true;
            }
          }
          relative = nextRelative;
        }
        scanTail = deferredStart === undefined ? "" : window.slice(deferredStart - windowStart);
        codeRegions = undefined;
        return false;
      });
      let releasedHold = false;
      let withheld = "";
      // Published text is a source prefix and `withheld` carries the rest only while
      // no earlier transform has suppressed bytes.
      let synced = true;
      const render: TextProjector = (input) => {
        if (!active) {
          transformed = false;
          const result = project(input);
          source = input.text;
          if (heldPrefix !== undefined) {
            // Replacements and earlier transforms resynchronize once before the
            // incremental prefix path can resume, including the withheld suffix.
            if (input.delta === null || !synced) {
              const text = input.text.slice(0, heldPrefix);
              const delta =
                input.delta === null
                  ? null
                  : text.startsWith(output)
                    ? text.slice(output.length)
                    : null;
              output = text;
              withheld = input.text.slice(heldPrefix);
              synced = true;
              releasedHold = true;
              return { text, delta };
            }
            const appendStart = input.text.length - input.delta.length;
            const pending = withheld + input.delta;
            const visibleLength =
              heldPrefix > appendStart ? Math.max(0, heldPrefix - output.length) : 0;
            const visible = pending.slice(0, visibleLength);
            withheld = pending.slice(visible.length);
            output += visible;
            releasedHold = true;
            return { text: output, delta: visible };
          }
          if (releasedHold && input.delta !== null) {
            const text = result.text;
            const pending = withheld + input.delta;
            // Without a transform the appended source is exactly the published prefix
            // plus the pending bytes; anything else must prove its prefix first.
            const delta =
              !transformed && synced
                ? pending
                : text.length >= output.length && text.startsWith(output)
                  ? text.slice(output.length)
                  : null;
            output = text;
            withheld = "";
            synced = input.delta === "" ? synced : !transformed;
            releasedHold = false;
            return { text, delta, ...(result.retained ? { retained: result.retained } : {}) };
          }
          withheld = "";
          releasedHold = false;
          // Empty appends reuse a cached projection that may still suppress source bytes.
          synced = input.delta === "" ? synced : !transformed;
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
