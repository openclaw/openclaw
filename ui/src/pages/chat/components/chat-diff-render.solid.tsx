import type { JSX } from "@solidjs/web";
import { createEffect, createMemo, createSignal, For, onCleanup } from "solid-js";
import type { ToolCardOutcome } from "../../../lib/chat/chat-types.ts";
import {
  diffLineChangeRanges,
  pairSessionDiffLines,
  type SessionSplitDiffRow,
} from "../../../lib/chat/session-diff-split.ts";
import type { DiffFilePaths, DiffLine, DiffStat } from "../../../lib/chat/tool-call-diff.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import type { DiffHighlightToken } from "./chat-diff-highlight.runtime.ts";

export function DiffStatChips(props: { stat: DiffStat & { modified?: number } }) {
  const showZeros = () => props.stat.modified === undefined;
  return (
    <>
      {showZeros() || props.stat.added || props.stat.removed || props.stat.modified ? (
        <span class="chat-diffstat">
          {(showZeros() || props.stat.added > 0) && (
            <span class="chat-diffstat__add">+{props.stat.added}</span>
          )}
          {(showZeros() || props.stat.removed > 0) && (
            <span class="chat-diffstat__del">-{props.stat.removed}</span>
          )}
          {(props.stat.modified ?? 0) > 0 && (
            <span class="chat-diffstat__mod">~{props.stat.modified}</span>
          )}
        </span>
      ) : null}
    </>
  );
}

export function HighlightedDiff(props: {
  lines: readonly DiffLine[];
  file: DiffFilePaths;
  children: (
    renderLine: (line: DiffLine) => JSX.Element,
    rows: readonly SessionSplitDiffRow[],
  ) => JSX.Element;
}) {
  const [highlighted, setHighlighted] = createSignal<ReadonlyMap<DiffLine, DiffHighlightToken[]>>(
    new Map(),
  );
  const rows = createMemo(() => pairSessionDiffLines(props.lines));
  const changes = createMemo(() => diffLineChangeRanges(rows()));
  const rendered = createMemo(() => {
    const result = new Map(highlighted());
    for (const [line, ranges] of changes()) {
      const parts: DiffHighlightToken[] = [];
      let offset = 0;
      let rangeIndex = 0;
      for (const token of highlighted().get(line) ?? [{ text: line.text, classes: "" }]) {
        const end = offset + token.text.length;
        let start = offset;
        while (start < end) {
          const range = ranges[rangeIndex];
          if (range && range.to <= start) {
            rangeIndex++;
            continue;
          }
          const changed = range && range.from <= start;
          const next = Math.min(end, range ? (changed ? range.to : range.from) : end);
          parts.push({
            text: token.text.slice(start - offset, next - offset),
            classes: [token.classes, changed ? "chat-diff__change--" + line.kind : ""]
              .filter(Boolean)
              .join(" "),
          });
          start = next;
        }
        offset = end;
      }
      result.set(line, parts);
    }
    return result;
  });
  let generation = 0;
  onCleanup(() => {
    generation += 1;
  });
  createEffect(
    () => ({
      lines: props.lines,
      path: props.file.path,
      oldPath: props.file.oldPath ?? props.file.path,
    }),
    ({ lines, path, oldPath }) => {
      const request = ++generation;
      setHighlighted(new Map());
      void import("./chat-diff-highlight.runtime.ts")
        .then(({ highlightDiffTokens }) => highlightDiffTokens(lines, path, oldPath))
        .then((tokens) => {
          if (generation === request) {
            setHighlighted(tokens);
          }
        })
        .catch(() => {
          /* Optional highlighting leaves escaped source readable. */
        });
    },
  );
  return (
    <>
      {props.children(
        (line) => (
          <>
            {rendered().has(line) ? (
              <For each={rendered().get(line)}>
                {(token) =>
                  token.classes ? <span class={token.classes}>{token.text}</span> : token.text
                }
              </For>
            ) : (
              line.text
            )}
          </>
        ),
        rows(),
      )}
    </>
  );
}

export function DiffBlock(props: {
  lines: readonly DiffLine[];
  outcome?: ToolCardOutcome;
  renderSkip?: (line: DiffLine) => JSX.Element;
  file?: DiffFilePaths;
}) {
  const hasLineNumbers = () => props.lines.some((line) => line.lineNo !== undefined);
  return (
    <HighlightedDiff lines={props.lines} file={props.file ?? { path: "" }}>
      {(renderLine) => (
        <div
          class="chat-diff code-highlight"
          role="figure"
          aria-label={t(
            (props.outcome ?? "succeeded") === "succeeded"
              ? "chat.toolCards.fileChanges"
              : "chat.toolCards.attemptedChanges",
          )}
        >
          <For each={props.lines}>
            {(line) => (
              <div
                class={["chat-diff__row", line.kind !== "ctx" && `chat-diff__row--${line.kind}`]}
              >
                {hasLineNumbers() && (
                  <span class="chat-diff__gutter">
                    {line.kind === "skip" ? "" : (line.lineNo ?? "")}
                  </span>
                )}
                <span class="chat-diff__sign">
                  {line.kind === "add" ? "+" : line.kind === "del" ? "-" : ""}
                </span>
                <span class="chat-diff__text">
                  {line.kind === "skip"
                    ? (props.renderSkip?.(line) ?? line.text) || "⋯"
                    : renderLine(line)}
                </span>
              </div>
            )}
          </For>
        </div>
      )}
    </HighlightedDiff>
  );
}
