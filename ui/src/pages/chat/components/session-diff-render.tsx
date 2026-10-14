import type { JSX } from "@solidjs/web";
import { For } from "solid-js";
import { pairSessionDiffLines } from "../../../lib/chat/session-diff-split.ts";
import type { DiffFilePaths, DiffLine } from "../../../lib/chat/tool-call-diff.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { HighlightedDiff } from "./chat-diff-render.solid.tsx";

function SplitSide(props: {
  line: DiffLine | undefined;
  side: "left" | "right";
  renderLine: (line: DiffLine) => JSX.Element;
}) {
  return (
    <div
      class={[
        "session-diff-split__side",
        `session-diff-split__side--${props.side}`,
        { "session-diff-split__side--filled": Boolean(props.line) },
      ]}
    >
      <span class="session-diff-split__gutter">{props.line?.lineNo ?? ""}</span>
      <span class="session-diff-split__sign">
        {props.line ? (props.side === "left" ? "-" : "+") : ""}
      </span>
      <span class="session-diff-split__text">{props.line ? props.renderLine(props.line) : ""}</span>
    </div>
  );
}

export function SessionSplitDiff(props: {
  lines: readonly DiffLine[];
  renderSkip: (line: DiffLine) => JSX.Element;
  file: DiffFilePaths;
}) {
  return (
    <HighlightedDiff lines={props.lines} file={props.file}>
      {(renderLine) => (
        <div
          class="session-diff-split code-highlight"
          role="figure"
          aria-label={t("chat.toolCards.fileChanges")}
        >
          <For each={pairSessionDiffLines(props.lines)}>
            {(row) => (
              <>
                {row.kind === "pair" ? (
                  <div class="session-diff-split__row session-diff-split__row--pair">
                    <SplitSide line={row.left} side="left" renderLine={renderLine} />
                    <SplitSide line={row.right} side="right" renderLine={renderLine} />
                  </div>
                ) : row.line.kind === "skip" ? (
                  <div class="session-diff-split__row session-diff-split__row--skip">
                    {(props.renderSkip(row.line) ?? row.line.text) || "⋯"}
                  </div>
                ) : (
                  <div class="session-diff-split__row session-diff-split__row--context">
                    <span class="session-diff-split__gutter">{row.line.lineNo ?? ""}</span>
                    <span class="session-diff-split__sign" />
                    <span class="session-diff-split__text">{renderLine(row.line)}</span>
                  </div>
                )}
              </>
            )}
          </For>
        </div>
      )}
    </HighlightedDiff>
  );
}
