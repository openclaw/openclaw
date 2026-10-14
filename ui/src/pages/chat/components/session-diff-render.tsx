import type { JSX } from "@solidjs/web";
import { For, Show } from "solid-js";
import type {
  SessionDiffFile,
  SessionsDiffResult,
} from "../../../../../packages/gateway-protocol/src/index.js";
import type { SessionSplitDiffRow } from "../../../lib/chat/session-diff-split.ts";
import type { ParsedFilePatch } from "../../../lib/chat/session-diff.ts";
import type { DiffFilePaths, DiffLine } from "../../../lib/chat/tool-call-diff.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import {
  DiffBlock,
  DiffFoldToggle,
  DiffFoldPlaceholder,
  type DiffPresentation,
} from "./chat-diff-render.solid.tsx";

function SplitSide(props: {
  line: DiffLine | undefined;
  side: "left" | "right";
  renderLine: (line: DiffLine) => JSX.Element;
  presentation: DiffPresentation;
}) {
  return (
    <div
      class={[
        "session-diff-split__side",
        `session-diff-split__side--${props.side}`,
        { "session-diff-split__side--filled": Boolean(props.line) },
      ]}
    >
      <span class="session-diff-split__gutter">
        {props.line && <DiffFoldToggle line={props.line} presentation={props.presentation} />}
        {props.line?.lineNo ?? ""}
      </span>
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
  rows: readonly SessionSplitDiffRow[];
  presentation: DiffPresentation;
}) {
  const renderLine = (line: DiffLine) => props.presentation.renderLine(line);
  return (
    <>
      <div
        class="session-diff-split code-highlight"
        role="figure"
        aria-label={t("chat.toolCards.fileChanges")}
      >
        <For each={props.presentation.visibility().rows}>
          {(row) => (
            <>
              {row.kind === "pair" ? (
                <div class="session-diff-split__row session-diff-split__row--pair">
                  <SplitSide
                    line={row.left}
                    side="left"
                    renderLine={renderLine}
                    presentation={props.presentation}
                  />
                  <SplitSide
                    line={row.right}
                    side="right"
                    renderLine={renderLine}
                    presentation={props.presentation}
                  />
                </div>
              ) : row.line.kind === "skip" ? (
                <div class="session-diff-split__row session-diff-split__row--skip">
                  {(props.renderSkip(row.line) ?? row.line.text) || "⋯"}
                </div>
              ) : (
                <div class="session-diff-split__row session-diff-split__row--context">
                  <span class="session-diff-split__gutter">
                    <DiffFoldToggle line={row.line} presentation={props.presentation} />
                    {row.line.lineNo ?? ""}
                  </span>
                  <span class="session-diff-split__sign" />
                  <span class="session-diff-split__text">{renderLine(row.line)}</span>
                </div>
              )}
              {props.presentation.visibility().rowPlaceholders.get(row) && (
                <DiffFoldPlaceholder
                  fold={props.presentation.visibility().rowPlaceholders.get(row)!}
                  presentation={props.presentation}
                />
              )}
            </>
          )}
        </For>
      </div>
    </>
  );
}

export function SessionDiffFileBody(props: {
  file: SessionDiffFile;
  parsed: ParsedFilePatch | null;
  unavailableReason: SessionsDiffResult["unavailableReason"];
  split: boolean;
  presentation: DiffPresentation;
  renderSkip: (line: DiffLine) => JSX.Element;
}) {
  return (
    <Show
      when={props.file.binary !== true && props.parsed}
      fallback={
        <div class="session-diff__note">
          {t(
            props.file.binary === true
              ? "chat.sessionDiff.binaryFile"
              : props.unavailableReason === "workspace_stopped"
                ? "chat.sessionDiff.workspaceStoppedFile"
                : "chat.sessionDiff.previewUnavailable",
          )}
        </div>
      }
    >
      <Show
        when={props.split}
        fallback={
          <DiffBlock
            presentation={props.presentation}
            lines={props.parsed?.lines ?? []}
            renderSkip={props.renderSkip}
            file={props.file}
          />
        }
      >
        <SessionSplitDiff
          presentation={props.presentation}
          lines={props.parsed?.lines ?? []}
          renderSkip={props.renderSkip}
          file={props.file}
          rows={props.presentation.rows()}
        />
      </Show>
      {props.parsed?.truncated && (
        <div class="session-diff__note">{t("chat.sessionDiff.truncatedFile")}</div>
      )}
    </Show>
  );
}
