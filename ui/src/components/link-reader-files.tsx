import { createMemo, For, Show } from "solid-js";
import type { ControlUiLinkReaderDocument } from "../../../src/shared/control-ui-link-reader.js";
import { elementRef } from "../lib/reactive/element-ref.ts";
import { t } from "../lib/reactive/i18n.ts";
import { Icon } from "./solid/icon.tsx";

type ReaderFile = NonNullable<ControlUiLinkReaderDocument["files"]>[number];
type DiffRow = {
  kind: "add" | "delete" | "hunk" | "context";
  text: string;
  /** New-file line for added and unchanged rows, old-file line for removed rows. */
  line?: number;
};

// Unified hunks carry their own coordinates; rows before the first hunk stay unnumbered.
function diffRows(patch: string): DiffRow[] {
  let oldLine: number | undefined;
  let newLine: number | undefined;
  const lines = patch.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines.map((text) => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(text);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      return { kind: "hunk", text };
    }
    if (text.startsWith("+")) {
      return { kind: "add", text, line: newLine === undefined ? undefined : newLine++ };
    }
    if (text.startsWith("-")) {
      return { kind: "delete", text, line: oldLine === undefined ? undefined : oldLine++ };
    }
    if (text.startsWith("\\") || newLine === undefined || oldLine === undefined) {
      return { kind: "context", text };
    }
    oldLine++;
    return { kind: "context", text, line: newLine++ };
  });
}

export function Diff(props: {
  patch: string;
  filename: string;
  onScrollPortRef?: (element: HTMLElement) => void | (() => void);
}) {
  const rows = createMemo(() => diffRows(props.patch));
  const gutter = () => String(Math.max(0, ...rows().map((row) => row.line ?? 0))).length;
  return (
    <pre
      ref={[elementRef(props.onScrollPortRef)]}
      class="lr-diff"
      style={{ "--lr-diff-gutter": gutter() + "ch" }}
      tabindex={0}
      aria-label={t("linkReader.diffLabel", { filename: props.filename })}
    >
      <code>
        <For each={rows()}>
          {(row) => (
            // Line numbers render from the attribute, so copied text stays a valid patch.
            <span class={["lr-diff-line", `lr-diff-line--${row.kind}`]} data-line={row.line}>
              {row.text}
            </span>
          )}
        </For>
      </code>
    </pre>
  );
}

export function FileContent(props: {
  file: ReaderFile;
  expanded: boolean;
  onScrollPortRef?: (element: HTMLElement) => void | (() => void);
}) {
  // Preserve native toggles until the document changes its expansion preference.
  const expanded = createMemo(() => props.expanded);
  const name = () => props.file.path.slice(props.file.path.lastIndexOf("/") + 1);
  const directory = () => props.file.path.slice(0, -name().length).replace(/\/$/u, "");
  return (
    <details class="lr-file" open={expanded()}>
      <summary>
        <span class="lr-file-chevron" aria-hidden="true">
          <Icon name="chevronRight" />
        </span>
        {/* Name first: the directory gives way when the row runs out of room. */}
        <span class="lr-filename" title={props.file.path}>
          <span class="lr-file-name">{name()}</span>
          <Show when={directory()}>
            <span class="lr-file-directory">{directory()}</span>
          </Show>
        </span>
        <Show when={props.file.status !== "modified" && props.file.status}>
          {(status) => (
            <span class={["lr-file-status", `lr-file-status--${status()}`]}>{status()}</span>
          )}
        </Show>
        <span class="lr-stats">
          <span class="lr-add">+{props.file.additions}</span>
          <span class="lr-delete">−{props.file.deletions}</span>
        </span>
      </summary>
      <Show when={props.file.previousPath}>
        {(path) => <p class="lr-file-note">{t("linkReader.renamedFrom", { filename: path() })}</p>}
      </Show>
      <Show
        when={props.file.patch}
        fallback={<p class="lr-file-note">{t("linkReader.patchUnavailable")}</p>}
      >
        {(patch) => (
          <Diff
            patch={patch()}
            filename={props.file.path}
            onScrollPortRef={props.onScrollPortRef}
          />
        )}
      </Show>
      <Show when={props.file.patch && props.file.patchTruncated}>
        <p class="lr-file-note">{t("linkReader.patchTruncated")}</p>
      </Show>
    </details>
  );
}
