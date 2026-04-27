import { parseFenceSpans } from "./fences.js";
export function createInlineCodeState() {
    return { open: false, ticks: 0 };
}
export function buildCodeSpanIndex(text, inlineState) {
    const fenceSpans = parseFenceSpans(text);
    const startState = inlineState
        ? { open: inlineState.open, ticks: inlineState.ticks }
        : createInlineCodeState();
    const { spans: inlineSpans, state: nextInlineState } = parseInlineCodeSpans(text, fenceSpans, startState);
    return {
        inlineState: nextInlineState,
        isInside: (index) => isInsideFenceSpan(index, fenceSpans) || isInsideInlineSpan(index, inlineSpans),
    };
}
function parseInlineCodeSpans(text, fenceSpans, initialState) {
    const spans = [];
    let open = initialState.open;
    let ticks = initialState.ticks;
    let openStart = open ? 0 : -1;
    let i = 0;
    while (i < text.length) {
        const fence = findFenceSpanAtInclusive(fenceSpans, i);
        if (fence) {
            i = fence.end;
            continue;
        }
        if (text[i] !== "`") {
            i += 1;
            continue;
        }
        const runStart = i;
        let runLength = 0;
        while (i < text.length && text[i] === "`") {
            runLength += 1;
            i += 1;
        }
        if (!open) {
            open = true;
            ticks = runLength;
            openStart = runStart;
            continue;
        }
        if (runLength === ticks) {
            spans.push([openStart, i]);
            open = false;
            ticks = 0;
            openStart = -1;
        }
    }
    if (open) {
        spans.push([openStart, text.length]);
    }
    return {
        spans,
        state: { open, ticks },
    };
}
function findFenceSpanAtInclusive(spans, index) {
    return spans.find((span) => index >= span.start && index < span.end);
}
function isInsideFenceSpan(index, spans) {
    return spans.some((span) => index >= span.start && index < span.end);
}
function isInsideInlineSpan(index, spans) {
    return spans.some(([start, end]) => index >= start && index < end);
}
