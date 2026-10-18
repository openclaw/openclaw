import type { JSX } from "@solidjs/web";
import { createEffect, createMemo, createSignal, For, onCleanup, untrack } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import type { ToolCardOutcome } from "../../../lib/chat/chat-types.ts";
import {
  projectDiffCodeFolds,
  type DiffSyntaxFold,
  type DiffCodeFold,
} from "../../../lib/chat/session-diff-folds.ts";
import {
  diffLineChangeRanges,
  pairSessionDiffLines,
  type SessionSplitDiffRow,
} from "../../../lib/chat/session-diff-split.ts";
import type { DiffFilePaths, DiffLine } from "../../../lib/chat/tool-call-diff.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import type { DiffHighlightToken } from "./chat-diff-highlight.runtime.ts";
import { DiffStatChips } from "./chat-diff-stat.solid.tsx";

export function createDiffPresentation(props: {
  active?: boolean;
  lines: readonly DiffLine[];
  file: DiffFilePaths;
  rows?: readonly SessionSplitDiffRow[];
}) {
  const [highlighted, setHighlighted] = createSignal<ReadonlyMap<DiffLine, DiffHighlightToken[]>>(
    new Map(),
  );
  const [syntaxFolds, setSyntaxFolds] = createSignal<readonly DiffSyntaxFold[]>([]);
  const sourceLines = createMemo(() => props.lines);
  // Gap expansion retains original line objects; preserve their manual folds,
  // while every newly discovered region starts open. A new patch has a new owner.
  const [closed, setClosed] = createSignal<ReadonlySet<DiffLine>>((previous) => {
    const present = new Set(sourceLines());
    return new Set([...(previous ?? [])].filter((line) => present.has(line)));
  });
  const rows = createMemo(() => props.rows ?? pairSessionDiffLines(props.lines));
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
  const syntaxSource = createMemo(
    () => ({
      lines: sourceLines(),
      path: props.file.path,
      oldPath: props.file.oldPath ?? props.file.path,
    }),
    {
      equals: (previous, next) =>
        previous.lines === next.lines &&
        previous.path === next.path &&
        previous.oldPath === next.oldPath,
    },
  );
  const syntaxTarget = createMemo(() => (props.active === false ? null : syntaxSource()));
  let prepared: ReturnType<typeof syntaxSource> | null = null;
  createEffect(syntaxTarget, (target) => {
    const request = ++generation;
    // Disclosure parks prepared syntax and manual folds without doing hidden work.
    if (!target || prepared === target) {
      return;
    }
    const { lines, path, oldPath } = target;
    setHighlighted(new Map());
    setSyntaxFolds([]);
    void import("./chat-diff-highlight.runtime.ts")
      .then(({ analyzeDiffSyntax }) =>
        generation === request ? analyzeDiffSyntax(lines, path, oldPath) : null,
      )
      .then((result) => {
        if (result && generation === request) {
          prepared = target;
          setHighlighted(result.highlighted);
          setSyntaxFolds(result.folds);
        }
      })
      .catch(() => {
        /* Optional highlighting leaves escaped source readable. */
      });
  });
  const folds = createMemo(() => projectDiffCodeFolds(rows(), syntaxFolds()));
  const visibility = createMemo(() => {
    const hidden = new Set<DiffLine>();
    const starts = new Map<DiffLine, DiffCodeFold>();
    const placeholders = new Map<DiffLine, DiffCodeFold>();
    const indices = new Map(props.lines.map((line, index) => [line, index]));
    const visibleRows: SessionSplitDiffRow[] = [];
    const rowPlaceholders = new Map<SessionSplitDiffRow, DiffCodeFold>();
    let end = -1;
    let cursor = 0;
    for (let index = 0; index < rows().length; index++) {
      const row = rows()[index]!;
      const rowLines =
        row.kind === "span"
          ? [row.line]
          : [row.left, row.right].filter((line): line is DiffLine => Boolean(line));
      while (cursor < folds().length && folds()[cursor]!.from < index) {
        cursor++;
      }
      const fold = folds()[cursor]?.from === index ? folds()[cursor] : undefined;
      if (index <= end) {
        rowLines.forEach((line) => hidden.add(line));
        continue;
      }
      visibleRows.push(row);
      if (!fold) {
        continue;
      }
      rowLines.forEach((line) => starts.set(line, fold));
      if (closed().has(fold.key)) {
        end = fold.to;
        const last = rowLines.reduce((a, b) => (indices.get(a)! > indices.get(b)! ? a : b));
        placeholders.set(last, fold);
        rowPlaceholders.set(row, fold);
      }
    }
    return {
      lines: props.lines.filter((line) => !hidden.has(line)),
      rows: visibleRows,
      starts,
      placeholders,
      rowPlaceholders,
    };
  });
  const toggle = (fold: DiffCodeFold) =>
    setClosed((previous) => {
      const next = new Set(previous);
      if (next.has(fold.key)) {
        next.delete(fold.key);
      } else {
        next.add(fold.key);
      }
      return next;
    });
  return {
    rows,
    visibility,
    closed,
    toggle,
    collapse: (functionsOnly: boolean) =>
      setClosed(
        new Set(
          folds()
            .filter((fold) => !functionsOnly || fold.function)
            .map((fold) => fold.key),
        ),
      ),
    expand: () => setClosed(new Set<DiffLine>()),
    renderLine: (line: DiffLine) => (
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
  };
}
export type DiffPresentation = ReturnType<typeof createDiffPresentation>;

export function DiffFoldToggle(props: { line: DiffLine; presentation: DiffPresentation }) {
  const fold = () => props.presentation.visibility().starts.get(props.line);
  return (
    <>
      {fold() && (
        <button
          type="button"
          class="session-diff__code-toggle"
          aria-label={t(
            props.presentation.closed().has(fold()!.key)
              ? "chat.sessionDiff.expandCodeRegion"
              : "chat.sessionDiff.collapseCodeRegion",
            { line: String(props.line.lineNo ?? "") },
          )}
          aria-expanded={props.presentation.closed().has(fold()!.key) ? "false" : "true"}
          onClick={() => props.presentation.toggle(fold()!)}
        >
          <Icon
            name={props.presentation.closed().has(fold()!.key) ? "chevronRight" : "chevronDown"}
          />
        </button>
      )}
    </>
  );
}
export function DiffFoldPlaceholder(props: { fold: DiffCodeFold; presentation: DiffPresentation }) {
  return (
    <button
      type="button"
      class="session-diff__code-placeholder"
      onClick={() => props.presentation.toggle(props.fold)}
    >
      <Icon name="chevronRight" />
      <span>{t("chat.sessionDiff.foldedLines", { count: String(props.fold.count) })}</span>
      <DiffStatChips stat={{ added: props.fold.added, removed: props.fold.removed }} />
    </button>
  );
}

export function DiffBlock(props: {
  lines: readonly DiffLine[];
  outcome?: ToolCardOutcome;
  renderSkip?: (line: DiffLine) => JSX.Element;
  file?: DiffFilePaths;
  rows?: readonly SessionSplitDiffRow[];
  presentation?: DiffPresentation;
}) {
  const presentation =
    untrack(() => props.presentation) ??
    createDiffPresentation({
      get lines() {
        return props.lines;
      },
      get file() {
        return props.file ?? { path: "" };
      },
      get rows() {
        return props.rows;
      },
    });
  const renderLine = presentation.renderLine;
  const hasLineNumbers = () => props.lines.some((line) => line.lineNo !== undefined);
  return (
    <>
      <div
        class="chat-diff code-highlight"
        role="figure"
        aria-label={t(
          (props.outcome ?? "succeeded") === "succeeded"
            ? "chat.toolCards.fileChanges"
            : "chat.toolCards.attemptedChanges",
        )}
      >
        <For each={presentation.visibility().lines}>
          {(line) => (
            <>
              <div
                class={["chat-diff__row", line.kind !== "ctx" && `chat-diff__row--${line.kind}`]}
              >
                {hasLineNumbers() && (
                  <span class="chat-diff__gutter">
                    {props.presentation && line.kind !== "skip" && (
                      <DiffFoldToggle line={line} presentation={presentation} />
                    )}
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
              {presentation.visibility().placeholders.get(line) && (
                <DiffFoldPlaceholder
                  fold={presentation.visibility().placeholders.get(line)!}
                  presentation={presentation}
                />
              )}
            </>
          )}
        </For>
      </div>
    </>
  );
}
