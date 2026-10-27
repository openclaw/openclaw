import type { JSX } from "@solidjs/web";
import { For, Show } from "solid-js";
import type {
  SessionDiffFile,
  SessionsDiffResult,
} from "../../../../../packages/gateway-protocol/src/index.js";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { registerChatToolLabelsEnglish } from "../../../i18n/locales/en-chat-tool-labels.ts";
import type { ParsedFilePatch } from "../../../lib/chat/session-diff.ts";
import type { DiffLine } from "../../../lib/chat/tool-call-diff.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import {
  DiffBlock,
  DiffFoldToggle,
  DiffFoldPlaceholder,
  type DiffPresentation,
} from "./chat-diff-render.solid.tsx";

registerEnglishCatalog(registerChatToolLabelsEnglish);

registerEnglishCatalog(registerChatSessionEnglish);

function SplitSide(props: {
  line: DiffLine | undefined;
  side: "left" | "right";
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
      <span class="session-diff-split__text">
        {props.line ? props.presentation.renderLine(props.line) : ""}
      </span>
    </div>
  );
}

function SessionSplitDiff(props: {
  renderSkip: (line: DiffLine) => JSX.Element;
  presentation: DiffPresentation;
}) {
  return (
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
                <SplitSide line={row.left} side="left" presentation={props.presentation} />
                <SplitSide line={row.right} side="right" presentation={props.presentation} />
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
                <span class="session-diff-split__text">
                  {props.presentation.renderLine(row.line)}
                </span>
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
        <SessionSplitDiff presentation={props.presentation} renderSkip={props.renderSkip} />
      </Show>
      {props.parsed?.truncated && (
        <div class="session-diff__note">{t("chat.sessionDiff.truncatedFile")}</div>
      )}
    </Show>
  );
}
