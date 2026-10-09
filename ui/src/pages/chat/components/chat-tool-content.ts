import { asNullableRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { html, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { ref } from "lit/directives/ref.js";
import { renderCopyButton } from "../../../components/copy-button.ts";
import { icons } from "../../../components/icons.ts";
import { isMarkdownBlockArtText } from "../../../components/markdown-text.ts";
import "../../../components/tooltip.ts";
import { syncTabGroupLabel } from "../../../components/web-awesome-tabs.ts";
import { t } from "../../../i18n/index.ts";
import type { ToolCard, ToolCardOutcome } from "../../../lib/chat/chat-types.ts";
import type { DiffFilePaths } from "../../../lib/chat/tool-call-diff.ts";
import { resolveToolCallView, type ToolCallView } from "../../../lib/chat/tool-call-view.ts";
import {
  isToolCardError,
  resolveToolCardDisplay,
  resolveToolCardOutcome,
} from "../../../lib/chat/tool-cards.ts";
import { formatToolDetail, resolveToolDisplay } from "../../../lib/chat/tool-display.ts";
import {
  isLegacyToolOutputUnavailable,
  TOOL_OUTPUT_PREVIEW_CHARS,
  formatToolOutput,
} from "../../../lib/chat/tool-output.ts";
import type { SubagentRowContext } from "../chat-spawned-subagent.ts";
import type { PluginToolIcons } from "../chat-tool-icon-controller.ts";
import { renderHighlightedCommand } from "./chat-command-highlight.ts";
import { renderDiffBlock } from "./chat-diff-render.ts";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";

function handleRawDetailsToggle(event: Event) {
  // SAFETY: This handler is attached only to the raw-details button below.
  const button = event.currentTarget as HTMLButtonElement | null;
  const root = button?.closest(".chat-tool-card__raw");
  const body = root?.querySelector<HTMLElement>(".chat-tool-card__raw-body");
  if (!button || !body) {
    return;
  }
  const expanded = button.getAttribute("aria-expanded") === "true";
  button.setAttribute("aria-expanded", String(!expanded));
  body.hidden = expanded;
}

export function renderRawOutputToggle(text: string) {
  return html`
    <div class="chat-tool-card__raw">
      <button
        class="chat-inline-disclosure chat-tool-card__raw-toggle"
        type="button"
        aria-expanded="false"
        @click=${handleRawDetailsToggle}
      >
        <span>${t("chat.toolCards.rawDetails")}</span>
        <span class="chat-inline-disclosure__chevron" aria-hidden="true">${icons.chevronDown}</span>
      </button>
      <div class="chat-tool-card__raw-body" hidden>${renderToolDataBlock({ text })}</div>
    </div>
  `;
}

// Plain tool output is the block's default content, so it carries no header;
// only input/error blocks need a label to stay distinguishable.
function renderToolDataBlock(params: { label?: string; text: string }) {
  const { label, text } = params;
  const codeClass = isMarkdownBlockArtText(text) ? "markdown-block-art" : "";
  return html`
    <div class="chat-tool-card__block">
      ${
        label
          ? html`<div class="chat-tool-card__block-header">
              <span class="chat-tool-card__block-icon">${icons.zap}</span>
              <span class="chat-tool-card__block-label">${label}</span>
            </div>`
          : nothing
      }
      <pre class="chat-tool-card__block-content"><code class=${codeClass}>${text}</code></pre>
    </div>
  `;
}

const KV_MAX_KEYS = 12;
const KV_MAX_VALUE_CHARS = 400;

function formatKeyValue(value: unknown): string {
  if (typeof value === "string") {
    return truncateUtf16Safe(value, KV_MAX_VALUE_CHARS);
  }
  if (
    value == null ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  try {
    return truncateUtf16Safe(JSON.stringify(value), KV_MAX_VALUE_CHARS);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function renderArgsKeyValueList(args: readonly [string, unknown][]) {
  return html`
    <div class="chat-tool-kv">
      ${args.map(
        ([key, value]) => html`
          <div class="chat-tool-kv__row">
            <span class="chat-tool-kv__key">${key}:</span>
            <span class="chat-tool-kv__value">${formatKeyValue(value)}</span>
          </div>
        `,
      )}
    </div>
  `;
}

// Args already represented in the collapsed row / header detail for kinds that
// summarize their primary target; everything else stays auditable on expand.
const ROW_SUMMARIZED_ARG_KEYS: Partial<Record<ToolCallView["kind"], ReadonlySet<string>>> = {
  read: new Set(["path", "file_path", "filePath", "notebook_path"]),
  search: new Set(["pattern", "query", "glob", "path"]),
  fetch: new Set(["url"]),
};

export function toolWorkspacePath(card: ToolCard, view: ToolCallView): string | null {
  if (view.kind !== "read" && view.kind !== "edit" && view.kind !== "write") {
    return null;
  }
  const singleOperation = view.fileOperations?.length === 1 ? view.fileOperations[0] : undefined;
  // A delete removes its own target, so the workspace loader would always
  // report "Failed to load"; the row keeps its disclosure but no file action.
  if (singleOperation?.operation === "delete") {
    return null;
  }
  const args = asNullableRecord(card.args);
  if (args) {
    for (const key of ["path", "file_path", "filePath", "notebook_path"]) {
      const value = args[key];
      if (typeof value === "string" && value.trim()) {
        return value;
      }
    }
  }
  const fallback = `${view.targetDetail ? `${view.targetDetail}/` : ""}${view.target ?? ""}`;
  const fallbackPath = fallback.trim();
  // Aggregate patch labels ("2 files", "a.ts → b.ts") name no single file, so
  // only a recorded operation matching the rendered path stays navigable.
  if (view.fileOperations) {
    return singleOperation?.path === fallbackPath ? singleOperation.path : null;
  }
  return fallbackPath || null;
}

function renderToolWorkspaceFilePath(
  label: string,
  path: string | null,
  onOpenWorkspaceFile?: (target: { path: string; line?: number | null }) => void,
) {
  return path && onOpenWorkspaceFile
    ? html`
        <button
          class="chat-tool-card__detail chat-tool-card__detail-link"
          type="button"
          title=${t("chat.toolCards.openFile")}
          @click=${() => onOpenWorkspaceFile({ path })}
        >
          ${label}
        </button>
      `
    : html`<div class="chat-tool-card__detail">${label}</div>`;
}

/** Neutral end-state line every expanded tool surface closes with. */
export function renderToolOutcome(outcome: ToolCardOutcome, exitCode?: number) {
  const key =
    outcome === "succeeded" ? "completed" : outcome === "unknown" ? "outcomeUnknown" : outcome;
  const label =
    outcome === "failed" && exitCode !== undefined
      ? t("chat.toolCards.exitCode", { code: String(exitCode) })
      : t(`chat.toolCards.${key}`);
  return html`<div class="chat-tool-card__outcome">${label}</div>`;
}

function renderTerminalBlock(command: string, output: string | undefined) {
  return html`
    <div class="chat-tool-term">
      <div class="chat-tool-term__cmd">
        <span class="chat-tool-term__prompt">$</span
        ><code>${renderHighlightedCommand(command)}</code>
      </div>
      ${
        output !== undefined
          ? html`<pre class="chat-tool-term__out"><code>${output}</code></pre>`
          : nothing
      }
    </div>
  `;
}

function renderToolCardModes(
  card: ToolCard,
  messageKey: string,
  diff: NonNullable<ToolCallView["diff"]>,
  outcome: ToolCardOutcome,
  isError: boolean,
  file: DiffFilePaths,
) {
  // Call IDs repeat across messages; scope DOM identity without copying source cards.
  // Web Awesome links ARIA references in later observer callbacks; initial render needs them too.
  const id = `${messageKey}:${card.id}`;
  const active = isError || outcome === "skipped" ? "raw" : "diff";
  const modeLabel = t("chat.toolCards.viewMode");
  const modes = [
    ["diff", "chat.toolCards.diff", renderDiffBlock(diff, outcome, undefined, file)],
    [
      "raw",
      "chat.toolCards.raw",
      renderToolDataBlock({
        ...(isError ? { label: t("chat.toolCards.toolError") } : {}),
        text: card.outputText!,
      }),
    ],
  ] as const;
  return html`
    <wa-tab-group
      class="chat-tool-card__modes"
      aria-label=${modeLabel}
      .active=${active}
      activation="auto"
      without-scroll-controls
      ${ref((element) => syncTabGroupLabel(element, modeLabel))}
    >
      ${modes.map(
        ([mode, label]) => html`<wa-tab
          slot="nav"
          id=${`${id}-${mode}-tab`}
          aria-controls=${`${id}-${mode}-panel`}
          panel=${mode}
          ?active=${active === mode}
        >
          ${t(label)}
        </wa-tab>`,
      )}
      ${modes.map(
        ([mode, , content]) => html`<wa-tab-panel
          id=${`${id}-${mode}-panel`}
          aria-labelledby=${`${id}-${mode}-tab`}
          name=${mode}
          ?active=${active === mode}
        >
          ${content}
        </wa-tab-panel>`,
      )}
    </wa-tab-group>
  `;
}

function serializeDiff(lines: readonly { kind: string; text: string }[]): string {
  return lines
    .map((line) => `${line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}${line.text}`)
    .join("\n");
}

export type ToolRenderOptions = {
  pluginToolIcons?: PluginToolIcons;
  messageKey: string;
  sessionKey?: string;
  agentId?: string;
  presented?: boolean;
  runActive?: boolean;
  onOpenSidebar?: (content: SidebarContent) => void;
  onOpenWorkspaceFile?: (target: { path: string; line?: number | null }) => void;
  /** Lets a subagent's launch row show its session's state and open it. */
  subagents?: SubagentRowContext;
};

export function renderExpandedToolCardContent(
  originalCard: ToolCard,
  {
    messageKey,
    sessionKey,
    agentId,
    onOpenSidebar,
    runActive,
    onOpenWorkspaceFile,
  }: ToolRenderOptions,
) {
  const outputDetails: SidebarContent = {
    kind: "tool-output",
    card: originalCard,
    sessionKey,
    agentId,
  };
  const displayCard = resolveToolCardDisplay(originalCard);
  const unavailable = isLegacyToolOutputUnavailable(originalCard);
  const outputText = formatToolOutput(displayCard);
  const outputIsLong =
    Math.max(outputText?.length ?? 0, originalCard.outputText?.length ?? 0) >
    TOOL_OUTPUT_PREVIEW_CHARS;
  const card = {
    ...displayCard,
    outputText:
      outputIsLong && onOpenSidebar && !unavailable
        ? truncateUtf16Safe(outputText ?? "", TOOL_OUTPUT_PREVIEW_CHARS)
        : outputText,
  };
  const outputFooter = html`
    ${
      outputText !== originalCard.outputText &&
      originalCard.outputText !== undefined &&
      !(outputIsLong && onOpenSidebar)
        ? renderRawOutputToggle(originalCard.outputText)
        : nothing
    }
    ${
      unavailable
        ? html`<p role="status">${t("chat.toolCards.fullOutputUnavailable")}</p>`
        : (outputIsLong || card.outputTruncated) && onOpenSidebar
          ? html`<button
              class="btn btn--sm"
              type="button"
              @click=${() => onOpenSidebar(outputDetails)}
            >
              ${t("chat.toolCards.showFullOutput")}
            </button>`
          : nothing
    }
  `;
  const view = resolveToolCallView({ name: card.name, args: card.args, details: card.details });
  const display = resolveToolDisplay({ name: card.name, args: card.args });
  // File/search rows already carry their target; the "with …" connector only
  // reads well for generic tools ("with query …"), not "with from sessions.ts".
  const summarizedKind = view.kind === "read" || view.kind === "search" || view.kind === "fetch";
  const detail = summarizedKind ? display.detail : formatToolDetail(display);
  const hasOutput = card.outputText !== undefined;
  const hasInput = Boolean(card.inputText?.trim());
  const isError = isToolCardError(card);
  const outcome = resolveToolCardOutcome(card, runActive);
  const workspaceFilePath = toolWorkspacePath(card, view);
  const canOpenSidebar = Boolean(onOpenSidebar);
  const preview = card.preview;
  const sidebarActionContent: SidebarContent =
    preview?.kind === "canvas" && preview.render === "url" && preview.viewId && preview.url
      ? {
          kind: "canvas",
          docId: preview.viewId,
          entryUrl: preview.url,
          ...(preview.title ? { title: preview.title } : {}),
          ...(preview.preferredHeight ? { preferredHeight: preview.preferredHeight } : {}),
          // Preserve the preview's sandbox ceiling when opening its sidebar.
          ...(preview.sandbox ? { sandbox: preview.sandbox } : {}),
          ...(card.outputText ? { rawText: card.outputText } : {}),
        }
      : outputDetails;
  const sidebarAction = canOpenSidebar
    ? html`
        <openclaw-tooltip content=${t("chat.toolCards.openDetails")}>
          <button
            class="chat-tool-card__action-btn"
            type="button"
            @click=${() => onOpenSidebar?.(sidebarActionContent)}
            aria-label=${t("chat.toolCards.openDetails")}
          >
            <span class="chat-tool-card__action-icon">${icons.panelRightOpen}</span>
          </button>
        </openclaw-tooltip>
      `
    : nothing;
  const diffCopyAction =
    view.diff && view.diff.length > 0
      ? renderCopyButton(serializeDiff(view.diff), t("common.copy"))
      : nothing;
  const variant =
    view.kind === "command" && (view.command || view.code) && !card.preview
      ? "command"
      : (view.kind === "edit" || view.kind === "write") && view.diff?.length
        ? "diff"
        : "generic";
  let body: ReturnType<typeof html> | ReturnType<typeof renderDiffBlock>;

  // Code-mode hooks pair code/command aliases; code selects plain source.
  // Source stays visible before serialized inputText arrives, and only the
  // rendered field leaves the remaining execution-context arguments.
  if (variant === "command") {
    const argsRecord = asNullableRecord(card.args);
    const sourceKey = view.code ? (argsRecord?.code === view.code ? "code" : "input") : "command";
    const extraArgs = Object.entries(argsRecord ?? {}).filter(([key]) => key !== sourceKey);
    body = html`
      ${
        view.code
          ? sourceKey === "input"
            ? html`${hasOutput ? renderToolDataBlock({ text: card.outputText! }) : nothing}
                <details class="chat-tool-card__input">
                  <summary>${t("chat.toolCards.toolInput")}</summary>
                  ${renderToolDataBlock({ text: view.code })}
                </details>`
            : html`${renderToolDataBlock({ label: t("chat.toolCards.toolInput"), text: view.code })}
              ${hasOutput ? renderToolDataBlock({ text: card.outputText! }) : nothing}`
          : renderTerminalBlock(view.command!, card.outputText)
      }
      ${extraArgs.length > 0 ? renderArgsKeyValueList(extraArgs) : nothing}
    `;
  } else if (variant === "diff" && view.diff) {
    // Raw output and the diff retain the shared tab primitive's view semantics.
    const file = view.fileOperations?.[0] ?? { path: view.target ?? "" };
    body = hasOutput
      ? renderToolCardModes(card, messageKey, view.diff, outcome, isError, file)
      : renderDiffBlock(view.diff, outcome, undefined, file);
  } else {
    // Summarized targets stay in the row; remaining arguments stay inspectable.
    const inputArgs = isRecord(card.args)
      ? Object.entries(card.args).filter(([key]) => !ROW_SUMMARIZED_ARG_KEYS[view.kind]?.has(key))
      : null;
    const showInputBlock = hasInput && (!summarizedKind || Boolean(inputArgs?.length));
    body = html`
      ${
        showInputBlock
          ? inputArgs && inputArgs.length > 0 && inputArgs.length <= KV_MAX_KEYS
            ? renderArgsKeyValueList(inputArgs)
            : renderToolDataBlock({
                label: t("chat.toolCards.toolInput"),
                text: card.inputText!,
              })
          : nothing
      }
      ${
        hasOutput && card.preview?.kind === "canvas"
          ? renderRawOutputToggle(card.outputText!)
          : hasOutput || isError
            ? renderToolDataBlock({
                ...(isError ? { label: t("chat.toolCards.toolError") } : {}),
                text: hasOutput ? card.outputText! : t("chat.toolCards.noOutputFailed"),
              })
            : nothing
      }
    `;
  }
  // A tool changing presentation still replaces its prior card and native controls.
  return keyed(
    variant,
    html` <div
      class="chat-tool-card ${variant === "command" ? "chat-tool-card--flush " : ""}${isError ? "chat-tool-card--error" : ""}"
    >
      ${
        variant === "command"
          ? html`<div class="chat-tool-card__actions">${sidebarAction}</div>`
          : variant === "diff" || detail || canOpenSidebar
            ? html`<div class="chat-tool-card__header">
                ${
                  variant === "diff" || (detail && view.kind === "read")
                    ? renderToolWorkspaceFilePath(
                        variant === "diff" ? (workspaceFilePath ?? view.target ?? "") : detail!,
                        workspaceFilePath,
                        onOpenWorkspaceFile,
                      )
                    : detail
                      ? html`<div class="chat-tool-card__detail">${detail}</div>`
                      : nothing
                }
                <div class="chat-tool-card__actions">
                  ${variant === "diff" ? diffCopyAction : nothing}${sidebarAction}
                </div>
              </div>`
            : nothing
      }
      ${body} ${outputFooter} ${renderToolOutcome(outcome, card.exitCode)}
    </div>`,
  );
}
