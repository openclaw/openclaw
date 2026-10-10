// Leaf diff renderers shared by tool cards and the session diff panel.
// Kept dependency-light (no chat-sidebar/chat-tool-cards imports) so both
// consumers can use them without creating an import cycle.
import { html, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { t } from "../../../i18n/index.ts";
import type { ToolCardOutcome } from "../../../lib/chat/chat-types.ts";
import type { DiffFilePaths, DiffLine, DiffStat } from "../../../lib/chat/tool-call-diff.ts";
import { renderHighlightedDiff } from "./chat-diff-highlight.ts";

export function renderDiffStatChips(stat: DiffStat & { modified?: number }) {
  const showZeros = stat.modified === undefined;
  if (!showZeros && stat.added === 0 && stat.removed === 0 && !stat.modified) {
    return nothing;
  }
  return keyed(
    showZeros,
    html`<span class="chat-diffstat">
      ${showZeros || stat.added > 0 ? html`<span class="chat-diffstat__add">+${stat.added}</span>` : nothing}
      ${showZeros || stat.removed > 0 ? html`<span class="chat-diffstat__del">-${stat.removed}</span>` : nothing}
      ${(stat.modified ?? 0) > 0 ? html`<span class="chat-diffstat__mod">~${stat.modified}</span>` : nothing}
    </span>`,
  );
}

export function renderDiffBlock(
  lines: readonly DiffLine[],
  outcome: ToolCardOutcome = "succeeded",
  renderSkip?: (line: DiffLine) => unknown,
  file: DiffFilePaths = { path: "" },
): ReturnType<typeof renderHighlightedDiff> {
  const hasLineNumbers = lines.some((line) => line.lineNo !== undefined);
  return renderHighlightedDiff(
    lines,
    file,
    (renderLine) => html`
      <div
        class="chat-diff code-highlight"
        role="figure"
        aria-label=${t(
          outcome === "succeeded"
            ? "chat.toolCards.fileChanges"
            : "chat.toolCards.attemptedChanges",
        )}
      >
        ${lines.map((line) => {
          const skip = line.kind === "skip";
          const kindClass = line.kind === "ctx" ? "" : `chat-diff__row--${line.kind}`;
          const sign = line.kind === "add" ? "+" : line.kind === "del" ? "-" : "";
          return html`<div class="chat-diff__row ${kindClass}">
            ${
              hasLineNumbers
                ? html`<span class="chat-diff__gutter">${skip ? "" : (line.lineNo ?? "")}</span>`
                : nothing
            }
            <span class="chat-diff__sign">${sign}</span>
            <span class="chat-diff__text"
              >${skip ? (renderSkip?.(line) ?? line.text) || "⋯" : renderLine(line)}</span
            >
          </div>`;
        })}
      </div>
    `,
  );
}
