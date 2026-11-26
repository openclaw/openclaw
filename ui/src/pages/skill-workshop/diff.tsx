import { createMemo, For, Show } from "solid-js";
import { extractFrontmatterBlock } from "../../../../packages/markdown-core/src/frontmatter.js";
import { MarkdownHtml } from "../../components/solid/markdown-html.tsx";
import { SettingsEmpty, SettingsStatus } from "../../components/solid/settings-ui.tsx";
import { formatUiError } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { visitTextDiff } from "../../lib/text-diff.ts";

export function LoadState(props: { error?: unknown }) {
  return (
    <>
      {props.error !== undefined ? (
        <div role="alert">
          <SettingsStatus kind="danger" label={formatUiError(props.error)} carapace />
        </div>
      ) : (
        <SettingsEmpty message={t("skillWorkshop.viewer.loading")} />
      )}
    </>
  );
}

/** Line diff from `before` to `after`; falls back to rendering `before` when they match. */
export function Diff(props: {
  before: string;
  after: string;
  beforeLabel: string;
  afterLabel: string;
  tooLargeText?: string;
  /** Which side to show when there is no line diff; `before` unless set. */
  fallbackSide?: "before" | "after";
}) {
  const lines = createMemo(() => diffLines(props.before, props.after));
  return (
    <Show
      when={lines() && !lines()!.every((line) => line.kind === "same")}
      fallback={
        <div class="sw-well">
          <p class="sw-diff__same">
            {lines() === null
              ? (props.tooLargeText ?? t("skillWorkshop.viewer.diffTooLarge"))
              : t("skillWorkshop.viewer.noDiff")}
          </p>
          <MarkdownHtml
            class="sw-markdown chat-text"
            markdown={
              splitFrontmatter(props.fallbackSide === "after" ? props.after : props.before).body
            }
            options={{ mode: "document" }}
          />
        </div>
      }
    >
      <div class="sw-diff">
        <div class="sw-diff__legend">
          <span class="sw-diff__key sw-diff__key--remove">{props.beforeLabel}</span>
          <span class="sw-diff__key sw-diff__key--add">{props.afterLabel}</span>
        </div>
        <div class="sw-diff__lines" role="table">
          <For each={lines() ?? []}>
            {(line) => (
              <div class={["sw-diff__line", `sw-diff__line--${line.kind}`]} role="row">
                <span class="sw-diff__sign" aria-hidden="true">
                  {line.kind === "add" ? "+" : line.kind === "remove" ? "−" : ""}
                </span>
                <span class="sw-diff__text">{line.text}</span>
              </div>
            )}
          </For>
        </div>
      </div>
    </Show>
  );
}
/** SKILL.md frontmatter is shown as the header; the body renders as markdown. */
export function splitFrontmatter(content: string): { body: string } {
  return { body: extractFrontmatterBlock(content)?.body ?? content };
}

type DiffLine = { kind: "same" | "add" | "remove"; text: string };

/** Added and removed line counts of a loaded comparison; null when too large to compare. */
export function diffCounts(before: string, after: string): { add: number; remove: number } | null {
  const lines = diffLines(before, after);
  if (!lines) {
    return null;
  }
  let add = 0;
  let remove = 0;
  for (const line of lines) {
    add += line.kind === "add" ? 1 : 0;
    remove += line.kind === "remove" ? 1 : 0;
  }
  return { add, remove };
}

// Skills cap at 200 KB, which can mean tens of thousands of lines; the LCS table is quadratic.
const MAX_DIFF_CELLS = 2_000_000;

/** Line diff (LCS over the lines between the common prefix and suffix); null when too large. */
function diffLines(before: string, after: string): DiffLine[] | null {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start += 1;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if ((midA.length + 1) * (midB.length + 1) > MAX_DIFF_CELLS) {
    return null;
  }
  const lines: DiffLine[] = a.slice(0, start).map((text) => ({ kind: "same", text }));
  visitTextDiff(midA, midB, (kind, text) => {
    lines.push({ kind: kind === "ctx" ? "same" : kind === "del" ? "remove" : "add", text });
  });
  for (const text of a.slice(endA)) {
    lines.push({ kind: "same", text });
  }
  return lines;
}
