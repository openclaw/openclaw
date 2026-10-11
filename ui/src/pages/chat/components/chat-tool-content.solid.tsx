import { asNullableRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { For, Show, createEffect, createMemo } from "solid-js";
import { isMarkdownBlockArtText } from "../../../components/markdown-text.ts";
import { CopyButton } from "../../../components/solid/copy-button.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import "../../../components/tooltip.ts";
import { syncTabGroupLabel } from "../../../components/web-awesome-tabs.ts";
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
import { t } from "../../../lib/reactive/i18n.ts";
import { defineSolidBridge } from "../../../lit/solid-bridge.ts";
import { HighlightedCommand } from "./chat-command-highlight.solid.tsx";
import { DiffBlock } from "./chat-diff-render.solid.tsx";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";
import { toolWorkspacePath, type ToolRenderOptions } from "./chat-tool-render-model.ts";

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "wa-tab-group": HTMLAttributes<HTMLElement> & {
        "prop:active": string;
        activation: "auto";
        "without-scroll-controls": boolean;
      };
      "wa-tab": HTMLAttributes<HTMLElement> & { panel: string; "prop:active": boolean };
      "wa-tab-panel": HTMLAttributes<HTMLElement> & { name: string; "prop:active": boolean };
    }
  }
}

function handleRawDetailsToggle(event: Event) {
  // SAFETY: Only the raw-details HTML button installs this handler.
  const button = event.currentTarget as HTMLButtonElement;
  const body = button
    .closest(".chat-tool-card__raw")
    ?.querySelector<HTMLElement>(".chat-tool-card__raw-body");
  if (!body) {
    return;
  }
  const expanded = button.getAttribute("aria-expanded") === "true";
  button.setAttribute("aria-expanded", String(!expanded));
  body.hidden = expanded;
}

export function RawOutputToggle(props: { text: string }) {
  return (
    <div class="chat-tool-card__raw">
      <button
        class="chat-inline-disclosure chat-tool-card__raw-toggle"
        type="button"
        aria-expanded="false"
        onClick={handleRawDetailsToggle}
      >
        <span>{t("chat.toolCards.rawDetails")}</span>
        <span class="chat-inline-disclosure__chevron" aria-hidden="true">
          <Icon name="chevronDown" />
        </span>
      </button>
      <div class="chat-tool-card__raw-body" hidden>
        <ToolDataBlock text={props.text} />
      </div>
    </div>
  );
}

function ToolDataBlock(props: { label?: string; text: string }) {
  return (
    <div class="chat-tool-card__block">
      <Show when={props.label}>
        <div class="chat-tool-card__block-header">
          <span class="chat-tool-card__block-icon">
            <Icon name="zap" />
          </span>
          <span class="chat-tool-card__block-label">{props.label}</span>
        </div>
      </Show>
      <pre class="chat-tool-card__block-content">
        <code class={isMarkdownBlockArtText(props.text) ? "markdown-block-art" : ""}>
          {props.text}
        </code>
      </pre>
    </div>
  );
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

function ArgsKeyValueList(props: { args: readonly [string, unknown][] }) {
  return (
    <div class="chat-tool-kv">
      <For each={props.args}>
        {(entry) => (
          <div class="chat-tool-kv__row">
            <span class="chat-tool-kv__key">{entry[0]}:</span>
            <span class="chat-tool-kv__value">{formatKeyValue(entry[1])}</span>
          </div>
        )}
      </For>
    </div>
  );
}

const ROW_SUMMARIZED_ARG_KEYS: Partial<Record<ToolCallView["kind"], ReadonlySet<string>>> = {
  read: new Set(["path", "file_path", "filePath", "notebook_path"]),
  search: new Set(["pattern", "query", "glob", "path"]),
  fetch: new Set(["url"]),
};

function WorkspaceFilePath(props: {
  label: string;
  path: string | null;
  onOpen?: ToolRenderOptions["onOpenWorkspaceFile"];
}) {
  return (
    <Show
      when={props.path && props.onOpen}
      fallback={<div class="chat-tool-card__detail">{props.label}</div>}
    >
      <button
        class="chat-tool-card__detail chat-tool-card__detail-link"
        type="button"
        title={t("chat.toolCards.openFile")}
        onClick={() => props.path && props.onOpen?.({ path: props.path })}
      >
        {props.label}
      </button>
    </Show>
  );
}

export function ToolOutcome(props: { outcome: ToolCardOutcome; exitCode?: number }) {
  const label = () =>
    props.outcome === "failed" && props.exitCode !== undefined
      ? t("chat.toolCards.exitCode", { code: String(props.exitCode) })
      : t(
          `chat.toolCards.${props.outcome === "succeeded" ? "completed" : props.outcome === "unknown" ? "outcomeUnknown" : props.outcome}`,
        );
  return <div class="chat-tool-card__outcome">{label()}</div>;
}

function TerminalBlock(props: { command: string; output?: string }) {
  return (
    <div class="chat-tool-term">
      <div class="chat-tool-term__cmd">
        <span class="chat-tool-term__prompt">$</span>
        <code>
          <HighlightedCommand command={props.command} />
        </code>
      </div>
      <Show when={props.output !== undefined}>
        <pre class="chat-tool-term__out">
          <code>{props.output}</code>
        </pre>
      </Show>
    </div>
  );
}

function ToolCardModes(props: {
  card: ToolCard;
  messageKey: string;
  diff: NonNullable<ToolCallView["diff"]>;
  outcome: ToolCardOutcome;
  isError: boolean;
  file: DiffFilePaths;
}) {
  const modes = ["diff", "raw"] as const;
  // Tool call IDs repeat across messages, so every tab and panel includes its message key.
  const id = () => `${props.messageKey}:${props.card.id}`;
  const active = () => (props.isError || props.outcome === "skipped" ? "raw" : "diff");
  const modeLabel = () => t("chat.toolCards.viewMode");
  let group: HTMLElement | undefined;
  createEffect(
    () => [props.card, modeLabel()] as const,
    ([, label]) => syncTabGroupLabel(group, label),
  );
  return (
    <wa-tab-group
      class="chat-tool-card__modes"
      aria-label={modeLabel()}
      prop:active={active()}
      activation="auto"
      without-scroll-controls
      ref={(element) => {
        group = element;
      }}
    >
      <For each={modes}>
        {(mode) => (
          <wa-tab
            slot="nav"
            id={`${id()}-${mode}-tab`}
            aria-controls={`${id()}-${mode}-panel`}
            panel={mode}
            prop:active={active() === mode}
          >
            {t(`chat.toolCards.${mode}`)}
          </wa-tab>
        )}
      </For>
      <For each={modes}>
        {(mode) => (
          <wa-tab-panel
            id={`${id()}-${mode}-panel`}
            aria-labelledby={`${id()}-${mode}-tab`}
            name={mode}
            prop:active={active() === mode}
          >
            {mode === "diff" ? (
              <DiffBlock lines={props.diff} outcome={props.outcome} file={props.file} />
            ) : (
              <ToolDataBlock
                label={props.isError ? t("chat.toolCards.toolError") : undefined}
                text={props.card.outputText!}
              />
            )}
          </wa-tab-panel>
        )}
      </For>
    </wa-tab-group>
  );
}

function serializeDiff(lines: readonly { kind: string; text: string }[]): string {
  return lines
    .map((line) => `${line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}${line.text}`)
    .join("\n");
}

function prepareContent(originalCard: ToolCard, options: ToolRenderOptions) {
  const outputDetails: SidebarContent = {
    kind: "tool-output",
    card: originalCard,
    sessionKey: options.sessionKey,
    agentId: options.agentId,
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
      outputIsLong && options.onOpenSidebar && !unavailable
        ? truncateUtf16Safe(outputText ?? "", TOOL_OUTPUT_PREVIEW_CHARS)
        : outputText,
  };
  const view = resolveToolCallView({ name: card.name, args: card.args, details: card.details });
  const display = resolveToolDisplay({ name: card.name, args: card.args });
  const summarizedKind = view.kind === "read" || view.kind === "search" || view.kind === "fetch";
  const detail = summarizedKind ? display.detail : formatToolDetail(display);
  const preview = card.preview;
  const sidebarActionContent: SidebarContent =
    preview?.kind === "canvas" && preview.render === "url" && preview.viewId && preview.url
      ? {
          kind: "canvas",
          docId: preview.viewId,
          entryUrl: preview.url,
          ...(preview.title ? { title: preview.title } : {}),
          ...(preview.preferredHeight ? { preferredHeight: preview.preferredHeight } : {}),
          ...(preview.sandbox ? { sandbox: preview.sandbox } : {}),
          ...(card.outputText ? { rawText: card.outputText } : {}),
        }
      : outputDetails;
  const variant =
    view.kind === "command" && (view.command || view.code) && !card.preview
      ? "command"
      : (view.kind === "edit" || view.kind === "write") && view.diff?.length
        ? "diff"
        : "generic";
  return {
    card,
    view,
    outputText,
    outputIsLong,
    unavailable,
    detail,
    summarizedKind,
    sidebarActionContent,
    outputDetails,
    variant,
    isError: isToolCardError(card),
    outcome: resolveToolCardOutcome(card, options.runActive),
    workspaceFilePath: toolWorkspacePath(card, view),
  };
}
type ContentState = ReturnType<typeof prepareContent>;

function CommandBody(props: { state: ContentState }) {
  const sourceKey = () =>
    props.state.view.code
      ? asNullableRecord(props.state.card.args)?.code === props.state.view.code
        ? "code"
        : "input"
      : "command";
  const extraArgs = createMemo(() =>
    Object.entries(asNullableRecord(props.state.card.args) ?? {}).filter(
      ([key]) => key !== sourceKey(),
    ),
  );
  return (
    <>
      <Show
        when={props.state.view.code}
        fallback={
          <TerminalBlock command={props.state.view.command!} output={props.state.card.outputText} />
        }
      >
        <Show
          when={sourceKey() === "input"}
          fallback={
            <>
              <ToolDataBlock label={t("chat.toolCards.toolInput")} text={props.state.view.code!} />
              <Show when={props.state.card.outputText !== undefined}>
                <ToolDataBlock text={props.state.card.outputText!} />
              </Show>
            </>
          }
        >
          <Show when={props.state.card.outputText !== undefined}>
            <ToolDataBlock text={props.state.card.outputText!} />
          </Show>
          <details class="chat-tool-card__input">
            <summary>{t("chat.toolCards.toolInput")}</summary>
            <ToolDataBlock text={props.state.view.code!} />
          </details>
        </Show>
      </Show>
      <Show when={extraArgs().length > 0}>
        <ArgsKeyValueList args={extraArgs()} />
      </Show>
    </>
  );
}

function GenericBody(props: { state: ContentState }) {
  const inputArgs = createMemo(() =>
    isRecord(props.state.card.args)
      ? Object.entries(props.state.card.args).filter(
          ([key]) => !ROW_SUMMARIZED_ARG_KEYS[props.state.view.kind]?.has(key),
        )
      : null,
  );
  return (
    <>
      <Show
        when={
          Boolean(props.state.card.inputText?.trim()) &&
          (!props.state.summarizedKind || Boolean(inputArgs()?.length))
        }
      >
        <Show
          when={inputArgs() && inputArgs()!.length > 0 && inputArgs()!.length <= KV_MAX_KEYS}
          fallback={
            <ToolDataBlock
              label={t("chat.toolCards.toolInput")}
              text={props.state.card.inputText!}
            />
          }
        >
          <ArgsKeyValueList args={inputArgs()!} />
        </Show>
      </Show>
      <Show
        when={
          props.state.card.outputText !== undefined && props.state.card.preview?.kind === "canvas"
        }
        fallback={
          <Show when={props.state.card.outputText !== undefined || props.state.isError}>
            <ToolDataBlock
              label={props.state.isError ? t("chat.toolCards.toolError") : undefined}
              text={props.state.card.outputText ?? t("chat.toolCards.noOutputFailed")}
            />
          </Show>
        }
      >
        <RawOutputToggle text={props.state.card.outputText!} />
      </Show>
    </>
  );
}

export function ExpandedToolCardContent(props: { card: ToolCard; options: ToolRenderOptions }) {
  const state = createMemo(() => prepareContent(props.card, props.options));
  const sidebarAction = () => (
    <Show when={props.options.onOpenSidebar}>
      <openclaw-tooltip prop:content={t("chat.toolCards.openDetails")}>
        <button
          class="chat-tool-card__action-btn"
          type="button"
          onClick={() => props.options.onOpenSidebar?.(state().sidebarActionContent)}
          aria-label={t("chat.toolCards.openDetails")}
        >
          <span class="chat-tool-card__action-icon">
            <Icon name="panelRightOpen" />
          </span>
        </button>
      </openclaw-tooltip>
    </Show>
  );
  return (
    <Show when={state().variant} keyed>
      {(variant) => (
        <div
          class={[
            "chat-tool-card",
            {
              "chat-tool-card--flush": variant === "command",
              "chat-tool-card--error": state().isError,
            },
          ]}
        >
          <Show
            when={variant === "command"}
            fallback={
              <Show when={variant === "diff" || state().detail || props.options.onOpenSidebar}>
                <div class="chat-tool-card__header">
                  <Show
                    when={variant === "diff" || (state().detail && state().view.kind === "read")}
                    fallback={
                      <Show when={state().detail}>
                        <div class="chat-tool-card__detail">{state().detail}</div>
                      </Show>
                    }
                  >
                    <WorkspaceFilePath
                      label={
                        variant === "diff"
                          ? (state().workspaceFilePath ?? state().view.target ?? "")
                          : state().detail!
                      }
                      path={state().workspaceFilePath}
                      onOpen={props.options.onOpenWorkspaceFile}
                    />
                  </Show>
                  <div class="chat-tool-card__actions">
                    <Show when={variant === "diff" && state().view.diff?.length}>
                      <CopyButton
                        text={serializeDiff(state().view.diff!)}
                        idleLabel={t("common.copy")}
                      />
                    </Show>
                    {sidebarAction()}
                  </div>
                </div>
              </Show>
            }
          >
            <div class="chat-tool-card__actions">{sidebarAction()}</div>
          </Show>
          {variant === "command" ? (
            <CommandBody state={state()} />
          ) : variant === "diff" ? (
            <Show
              when={state().card.outputText !== undefined}
              fallback={
                <DiffBlock
                  lines={state().view.diff!}
                  outcome={state().outcome}
                  file={state().view.fileOperations?.[0] ?? { path: state().view.target ?? "" }}
                />
              }
            >
              <ToolCardModes
                card={state().card}
                messageKey={props.options.messageKey}
                diff={state().view.diff!}
                outcome={state().outcome}
                isError={state().isError}
                file={state().view.fileOperations?.[0] ?? { path: state().view.target ?? "" }}
              />
            </Show>
          ) : (
            <GenericBody state={state()} />
          )}
          <Show
            when={
              state().outputText !== props.card.outputText &&
              props.card.outputText !== undefined &&
              !(state().outputIsLong && props.options.onOpenSidebar)
            }
          >
            <RawOutputToggle text={props.card.outputText!} />
          </Show>
          <Show
            when={state().unavailable}
            fallback={
              <Show
                when={
                  (state().outputIsLong || state().card.outputTruncated) &&
                  props.options.onOpenSidebar
                }
              >
                <button
                  class="btn btn--sm"
                  type="button"
                  onClick={() => props.options.onOpenSidebar?.(state().outputDetails)}
                >
                  {t("chat.toolCards.showFullOutput")}
                </button>
              </Show>
            }
          >
            <p role="status">{t("chat.toolCards.fullOutputUnavailable")}</p>
          </Show>
          <ToolOutcome outcome={state().outcome} exitCode={state().card.exitCode} />
        </div>
      )}
    </Show>
  );
}

const defaults: ToolRenderOptions = { messageKey: "" };
export const ToolContentHost = defineSolidBridge<{
  card: ToolCard | null;
  options: ToolRenderOptions;
}>(
  "openclaw-chat-tool-content",
  (props) => (
    <Show when={props.card}>
      {(card) => <ExpandedToolCardContent card={card()} options={props.options} />}
    </Show>
  ),
  {
    properties: {
      card: { default: null, attribute: false },
      options: { default: defaults, attribute: false },
    },
  },
);
export const RawOutputHost = defineSolidBridge<{ text: string }>(
  "openclaw-chat-tool-raw",
  (props) => <RawOutputToggle text={props.text} />,
  { properties: { text: { default: "", attribute: false } } },
);
export const ToolOutcomeHost = defineSolidBridge<{ outcome: ToolCardOutcome; exitCode?: number }>(
  "openclaw-chat-tool-outcome",
  (props) => <ToolOutcome outcome={props.outcome} exitCode={props.exitCode} />,
  {
    properties: {
      outcome: { default: "unknown", attribute: false },
      exitCode: { default: undefined, attribute: false },
    },
  },
);
