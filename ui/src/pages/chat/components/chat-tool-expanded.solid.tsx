import { asNullableRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { For, Show, createMemo, createSignal } from "solid-js";
import { CopyButton } from "../../../components/solid/copy-button.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import { TabPanel, Tabs } from "../../../components/solid/tabs.tsx";
import "../../../components/tooltip.ts";
import { registerChatToolContentEnglish } from "../../../i18n/locales/en-chat-tool-content.ts";
import type { ToolCard, ToolCardOutcome } from "../../../lib/chat/chat-types.ts";
import type { DiffFilePaths } from "../../../lib/chat/tool-call-diff.ts";
import { resolveToolCallView, type ToolCallView } from "../../../lib/chat/tool-call-view.ts";
import {
  isToolCardError,
  resolveToolCardDisplay,
  resolveToolCardOutcome,
  type ToolCardOutput,
} from "../../../lib/chat/tool-cards.ts";
import { formatToolDetail, resolveToolDisplay } from "../../../lib/chat/tool-display.ts";
import { isLegacyToolOutputUnavailable } from "../../../lib/chat/tool-output-text.ts";
import { TOOL_OUTPUT_PREVIEW_CHARS, formatToolOutput } from "../../../lib/chat/tool-output.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { HighlightedCommand } from "./chat-command-highlight.solid.tsx";
import { DiffBlock } from "./chat-diff-render.solid.tsx";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";
import type { ToolCardContentProps } from "./chat-tool-card-types.ts";
import { RawOutputToggle, ToolDataBlock } from "./chat-tool-content.solid.tsx";
import { toolWorkspacePath, type ToolRenderOptions } from "./chat-tool-render-model.ts";

registerEnglishCatalog(registerChatToolContentEnglish);

function ToolOutcome(props: { outcome: ToolCardOutcome; exitCode?: number }) {
  const label = () =>
    props.outcome === "failed" && props.exitCode !== undefined && props.exitCode !== 0
      ? t("chat.toolCards.exitCode", { code: String(props.exitCode) })
      : t(
          `chat.toolCards.${props.outcome === "succeeded" ? "completed" : props.outcome === "unknown" ? "outcomeUnknown" : props.outcome === "unrecorded" ? "noResult" : props.outcome}`,
        );
  return <div class="chat-tool-card__outcome">{label()}</div>;
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
  outputText: string;
  messageKey: string;
  diff: NonNullable<ToolCallView["diff"]>;
  outcome: ToolCardOutcome;
  isError: boolean;
  file: DiffFilePaths;
}) {
  const modes = ["diff", "raw"] as const;
  // Tool call IDs repeat across messages, so every tab and panel includes its message key.
  const id = () => `${props.messageKey}:${props.card.id}`;
  const initialMode = createMemo(() =>
    props.isError || props.outcome === "skipped" ? "raw" : "diff",
  );
  const [active, setActive] = createSignal<string>(initialMode);
  // Keep prepared syntax and reader scroll on revisits without mounting unseen tabs.
  const [visited, setVisited] = createSignal<readonly string[]>(() => [initialMode()]);
  return (
    <div class="chat-tool-card__modes">
      <Tabs
        ariaLabel={t("chat.toolCards.viewMode")}
        active={active()}
        activation="auto"
        onSelect={(value) => {
          setVisited((previous) => (previous.includes(value) ? previous : [...previous, value]));
          setActive(value);
        }}
        items={modes.map((mode) => ({
          value: mode,
          label: t(`chat.toolCards.${mode}`),
          id: `${id()}-${mode}-tab`,
          panelId: `${id()}-${mode}-panel`,
        }))}
      />
      <For each={modes}>
        {(mode) => (
          <TabPanel
            id={`${id()}-${mode}-panel`}
            tabId={`${id()}-${mode}-tab`}
            active={active() === mode}
          >
            <Show when={visited().includes(mode)}>
              {mode === "diff" ? (
                <DiffBlock lines={props.diff} outcome={props.outcome} file={props.file} />
              ) : (
                <ToolDataBlock
                  label={props.isError ? t("chat.toolCards.toolError") : undefined}
                  text={props.outputText}
                />
              )}
            </Show>
          </TabPanel>
        )}
      </For>
    </div>
  );
}

function serializeDiff(lines: readonly { kind: string; text: string }[]): string {
  return lines
    .map((line) => `${line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}${line.text}`)
    .join("\n");
}

function prepareContent(originalCard: ToolCard) {
  const card = resolveToolCardDisplay(originalCard);
  const view = resolveToolCallView({ name: card.name, args: card.args, details: card.details });
  const display = resolveToolDisplay({ name: card.name, args: card.args });
  const summarizedKind = view.kind === "read" || view.kind === "search" || view.kind === "fetch";
  const variant =
    view.kind === "command" && (view.command || view.code) && !card.preview
      ? "command"
      : (view.kind === "edit" || view.kind === "write") && view.diff?.length
        ? "diff"
        : "generic";
  return {
    card,
    view,
    detail: summarizedKind ? display.detail : formatToolDetail(display),
    summarizedKind,
    variant,
    workspaceFilePath: toolWorkspacePath(card, view),
  };
}

function prepareOutput(
  originalCard: ToolCard,
  displayCard: ToolCard,
  output: ToolCardOutput | undefined,
  options: ToolRenderOptions,
) {
  // Only output consumers adopt the live text; structural display stays independent.
  const current = output
    ? { ...originalCard, outputText: output.outputText, liveOutput: output.liveOutput }
    : originalCard;
  const outputDetails: SidebarContent = {
    kind: "tool-output",
    card: current,
    sessionKey: options.sessionKey,
    agentId: options.agentId,
  };
  const unavailable = isLegacyToolOutputUnavailable(current);
  const outputText = formatToolOutput(
    output ? { ...displayCard, outputText: output.outputText } : displayCard,
  );
  const outputIsLong =
    Math.max(outputText?.length ?? 0, current.outputText?.length ?? 0) > TOOL_OUTPUT_PREVIEW_CHARS;
  const text =
    outputIsLong && options.onOpenSidebar && !unavailable
      ? truncateUtf16Safe(outputText ?? "", TOOL_OUTPUT_PREVIEW_CHARS)
      : outputText;
  const displayed = { ...displayCard, outputText: text };
  const preview = displayCard.preview;
  const sidebarActionContent: SidebarContent =
    preview?.kind === "canvas" && preview.render === "url" && preview.viewId && preview.url
      ? {
          kind: "canvas",
          docId: preview.viewId,
          entryUrl: preview.url,
          ...(preview.title ? { title: preview.title } : {}),
          ...(preview.preferredHeight ? { preferredHeight: preview.preferredHeight } : {}),
          ...(preview.sandbox ? { sandbox: preview.sandbox } : {}),
          ...(text ? { rawText: text } : {}),
        }
      : outputDetails;
  return {
    text,
    rawText: current.outputText,
    outputText,
    outputIsLong,
    unavailable,
    sidebarActionContent,
    outputDetails,
    isError: isToolCardError(displayed),
    outcome: resolveToolCardOutcome(displayed, options.runActive),
  };
}
type ContentState = ReturnType<typeof prepareContent>;

function CommandBody(props: { state: ContentState; output?: string }) {
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
        fallback={<TerminalBlock command={props.state.view.command!} output={props.output} />}
      >
        <Show when={sourceKey() !== "input"}>
          <ToolDataBlock label={t("chat.toolCards.toolInput")} text={props.state.view.code!} />
        </Show>
        <Show when={props.output !== undefined}>
          <ToolDataBlock text={props.output!} />
        </Show>
        <Show when={sourceKey() === "input"}>
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

function GenericBody(props: { state: ContentState; output?: string; isError: boolean }) {
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
        when={props.output !== undefined && props.state.card.preview?.kind === "canvas"}
        fallback={
          <Show when={props.output !== undefined || props.isError}>
            <ToolDataBlock
              label={props.isError ? t("chat.toolCards.toolError") : undefined}
              text={props.output ?? t("chat.toolCards.noOutputFailed")}
            />
          </Show>
        }
      >
        <RawOutputToggle text={props.output!} />
      </Show>
    </>
  );
}

export function ExpandedToolCardContent(props: ToolCardContentProps) {
  const state = createMemo(() => prepareContent(props.card));
  const output = createMemo(() =>
    prepareOutput(props.card, state().card, props.output, props.options),
  );
  const isError = () => output().isError;
  const outcome = () => output().outcome;
  const sidebarAction = () => (
    <Show when={props.options.onOpenSidebar}>
      <openclaw-tooltip prop:content={t("chat.toolCards.openDetails")}>
        <button
          class="chat-tool-card__action-btn"
          type="button"
          onClick={() => props.options.onOpenSidebar?.(output().sidebarActionContent)}
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
              "chat-tool-card--error": isError(),
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
            <CommandBody state={state()} output={output().text} />
          ) : variant === "diff" ? (
            <Show
              when={output().text !== undefined}
              fallback={
                <DiffBlock
                  lines={state().view.diff!}
                  outcome={outcome()}
                  file={state().view.fileOperations?.[0] ?? { path: state().view.target ?? "" }}
                />
              }
            >
              <ToolCardModes
                card={state().card}
                outputText={output().text!}
                messageKey={props.options.messageKey}
                diff={state().view.diff!}
                outcome={outcome()}
                isError={isError()}
                file={state().view.fileOperations?.[0] ?? { path: state().view.target ?? "" }}
              />
            </Show>
          ) : (
            <GenericBody state={state()} output={output().text} isError={isError()} />
          )}
          <Show
            when={
              output().outputText !== output().rawText &&
              output().rawText !== undefined &&
              !(output().outputIsLong && props.options.onOpenSidebar)
            }
          >
            <RawOutputToggle text={output().rawText!} />
          </Show>
          <Show
            when={output().unavailable}
            fallback={
              <Show
                when={
                  (output().outputIsLong || state().card.outputTruncated) &&
                  props.options.onOpenSidebar
                }
              >
                <button
                  class="btn btn--sm"
                  type="button"
                  onClick={() => props.options.onOpenSidebar?.(output().outputDetails)}
                >
                  {t("chat.toolCards.showFullOutput")}
                </button>
              </Show>
            }
          >
            <p role="status">{t("chat.toolCards.fullOutputUnavailable")}</p>
          </Show>
          <Show when={state().card.catalogTruncated}>
            <p role="status">{t("chat.catalogOutputTruncated")}</p>
          </Show>
          <ToolOutcome outcome={outcome()} exitCode={state().card.exitCode} />
        </div>
      )}
    </Show>
  );
}
