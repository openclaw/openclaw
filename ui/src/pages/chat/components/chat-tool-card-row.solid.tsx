import { dynamic } from "@solidjs/web";
import { createMemo, For, Match, Show, Switch } from "solid-js";
import { unwrapToolCallForDisplay } from "../../../../../src/agents/tool-display-call.js";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatToolLabelsEnglish } from "../../../i18n/locales/en-chat-tool-labels.ts";
import type { ToolCard, ToolCardOutcome } from "../../../lib/chat/chat-types.ts";
import { resolveToolCallView, type ToolCallView } from "../../../lib/chat/tool-call-view.ts";
import {
  formatDistinctCollapsedToolSummaryText as distinctSummaryText,
  formatCollapsedToolPreviewText,
  formatCollapsedToolSummaryText,
  resolveToolCardOutcome,
  type ToolCardOutput,
} from "../../../lib/chat/tool-cards.ts";
import { resolveToolDisplayIdentity } from "../../../lib/chat/tool-display-identity.ts";
import { resolveToolDisplay } from "../../../lib/chat/tool-display.ts";
import { formatDurationCompact } from "../../../lib/format-duration.ts";
import { pathDisplayName } from "../../../lib/path-display.ts";
import { t, registerEnglishCatalog } from "../../../lib/reactive/i18n.ts";
import {
  resolveSessionLaunchPresentation,
  resolveSpawnedSubagent,
  type SpawnedSubagent,
} from "../chat-spawned-subagent.ts";
import { HighlightedCommand } from "./chat-command-highlight.solid.tsx";
import { DiffStatChips } from "./chat-diff-stat.solid.tsx";
import type { GroupedMessageOptions } from "./chat-message-bubble-options.ts";
import type { GroupedMessagePresentation } from "./chat-message-bubble-presentation.ts";
import { ExpandedToolCardContent } from "./chat-message-deferred.tsx";
import { ChatToolIcon, ToolIcon, syncToolDisclosureOverflow } from "./chat-tool-card-chrome.tsx";
import type { ToolCardProps } from "./chat-tool-card-types.ts";
import { ToolOutcomeSummary } from "./chat-tool-outcome-summary.solid.tsx";
import { toolWorkspacePath, type ToolRenderOptions } from "./chat-tool-render-model.ts";
import {
  commandPreview,
  resolveToolOperationLabel,
  resolveToolRowVerb,
} from "./chat-tool-row-presentation.ts";

registerEnglishCatalog(registerChatToolLabelsEnglish);

const TOOL_ROW_ICONS: Partial<Record<ToolCallView["kind"], string>> = {
  command: "squareTerminal",
  read: "fileText",
  edit: "pencil",
  write: "fileCode",
  search: "search",
  fetch: "globe",
};

function resolveCollapsedToolDetail(card: ToolCard, displayDetail: string | undefined) {
  if (displayDetail?.trim()) {
    return displayDetail;
  }
  return typeof card.args === "string"
    ? formatCollapsedToolPreviewText(card.inputText?.trim() ? card.inputText : card.args)
    : undefined;
}

function resolveToolRowText(card: ToolCard, view: ToolCallView, outcome: ToolCardOutcome): string {
  const verb = resolveToolRowVerb(view, outcome);
  return verb && view.target ? `${verb} ${view.target}` : resolveToolOperationLabel(card, outcome);
}

function ToolRowLink(props: {
  kind: "file" | "subagent";
  label: string;
  onOpen: () => void;
  openLabel?: string;
}) {
  return (
    <button
      class={`chat-tool-row__${props.kind}-link`}
      type="button"
      title={
        props.openLabel ??
        t(props.kind === "file" ? "chat.toolCards.openFile" : "chat.toolCards.openSubagent")
      }
      onClick={(event) => {
        event.stopPropagation();
        props.onOpen();
      }}
    >
      {props.label}
    </button>
  );
}

function ToolRowContent(props: {
  card: ToolCard;
  view: ToolCallView;
  outcome: ToolCardOutcome;
  running: boolean;
  workspaceFilePath: string | null;
  onOpenWorkspaceFile?: ToolRenderOptions["onOpenWorkspaceFile"];
}) {
  const verb = () => resolveToolRowVerb(props.view, props.outcome);
  const target = () =>
    props.view.kind === "edit" || props.view.kind === "write"
      ? pathDisplayName(props.view.target!)
      : props.view.target;
  const stat = () =>
    props.outcome === "succeeded"
      ? props.view.stat
      : props.outcome === "running" && (props.view.kind === "edit" || props.view.kind === "write")
        ? props.card.liveDiffStat
        : undefined;
  return (
    <Switch
      fallback={
        <span class={["chat-tool-row__title", { "text-shimmer": props.running }]}>
          {resolveToolOperationLabel(props.card, props.outcome)}
        </span>
      }
    >
      <Match when={props.view.kind === "command" && props.view.command}>
        <span class="chat-tool-row__prompt" aria-hidden="true">
          $
        </span>
        <code class={["chat-tool-row__cmd", { "text-shimmer": props.running }]}>
          <HighlightedCommand command={commandPreview(props.view.command!)} />
        </code>
      </Match>
      <Match when={verb() && props.view.target}>
        <span class={["chat-tool-row__verb", { "text-shimmer": props.running }]}>{verb()}</span>
        <Show
          when={props.workspaceFilePath && props.onOpenWorkspaceFile}
          fallback={<span class="chat-tool-row__target">{target()}</span>}
        >
          <ToolRowLink
            kind="file"
            label={target()!}
            onOpen={() => props.onOpenWorkspaceFile?.({ path: props.workspaceFilePath! })}
          />
        </Show>
        <Show when={stat()}>{(value) => <DiffStatChips stat={value()} />}</Show>
        <Show
          when={
            !props.workspaceFilePath &&
            props.view.targetDetail &&
            props.view.kind !== "edit" &&
            props.view.kind !== "write"
          }
        >
          <span class="chat-tool-row__detail">{props.view.targetDetail}</span>
        </Show>
      </Match>
    </Switch>
  );
}

function SessionLaunchRowContent(props: {
  launch: NonNullable<ReturnType<typeof resolveSessionLaunchPresentation>>;
  subagent: SpawnedSubagent | null;
  onOpen?: () => void;
}) {
  const state = () =>
    props.subagent?.session?.running
      ? t("chat.toolCards.subagentRunning")
      : props.subagent?.session?.ended === "failed"
        ? t("chat.toolCards.failed")
        : props.subagent?.session?.ended === "stopped"
          ? t("chat.toolCards.subagentStopped")
          : formatDurationCompact(props.subagent?.session?.runtimeMs);
  return (
    <>
      <span class="chat-tool-row__verb">
        {t(`chat.toolCards.launch.${props.launch.kind}.${props.launch.phase}`)}
      </span>
      <Show when={props.launch.label}>
        <Show
          when={props.onOpen}
          fallback={<span class="chat-tool-row__title">{props.launch.label}</span>}
        >
          <ToolRowLink
            kind="subagent"
            label={props.launch.label!}
            openLabel={t(
              props.launch.kind === "chat"
                ? "chat.toolCards.openChildChat"
                : "chat.toolCards.openSubagent",
            )}
            onOpen={() => props.onOpen?.()}
          />
        </Show>
      </Show>
      <Show when={state()}>
        <span
          class={[
            "chat-tool-row__subagent-state",
            {
              "chat-tool-row__subagent-state--failed": props.subagent?.session?.ended === "failed",
            },
          ]}
        >
          {state()}
        </span>
      </Show>
    </>
  );
}

export function ToolCardRow(props: ToolCardProps) {
  let disclosureContent: HTMLSpanElement | undefined;
  const syncOverflow = (event: Event) => syncToolDisclosureOverflow(event, disclosureContent);
  const card = () => props.card;
  const inline = () =>
    props.options.inlineCommands &&
    (view().kind === "command" || view().kind === "read" || view().kind === "search");
  const outcome = () => resolveToolCardOutcome(card(), props.options.runActive);
  const view = createMemo(() =>
    resolveToolCallView({ name: card().name, args: card().args, details: card().details }),
  );
  const display = createMemo(() =>
    resolveToolDisplayIdentity(unwrapToolCallForDisplay(card()).name),
  );
  const activityCards = () => props.options.activityCards ?? [card()];
  const running = () =>
    activityCards().some(
      (item) => resolveToolCardOutcome(item, props.options.runActive) === "running",
    );
  const workspaceFilePath = () => toolWorkspacePath(card(), view());
  const subagent = createMemo(() =>
    resolveSpawnedSubagent(card(), props.options.subagents?.subagentSessions),
  );
  const launch = createMemo(() =>
    resolveSessionLaunchPresentation(card(), outcome(), props.options.subagents?.subagentSessions),
  );
  const onOpenSubagent = () =>
    (subagent()?.session?.listed && props.options.subagents?.onOpenSubagent) ||
    props.options.subagents?.onOpenSession;
  const canOpenSubagent = () => Boolean(launch()?.childKey && onOpenSubagent());
  const handleOpenSubagent = () => {
    const childKey = launch()?.childKey;
    if (childKey) {
      onOpenSubagent()?.(childKey);
    }
  };
  const linkedRow = () => (workspaceFilePath() ? "file" : canOpenSubagent() ? "subagent" : null);
  const Row = dynamic(() => (linkedRow() ? "div" : "button"));
  const toggle = () => props.options.onToggleExpanded(card().id);
  const rowContent = () => (
    <>
      <span
        class="chat-tool-msg-summary__icon"
        role="img"
        aria-label={display().name}
        title={display().name}
      >
        <ToolIcon
          name={TOOL_ROW_ICONS[view().kind] ?? display().icon}
          tool={{ toolName: display().name, pluginToolIcons: props.options.pluginToolIcons }}
        />
      </span>
      <span ref={(element) => (disclosureContent = element)} class="chat-tool-disclosure__content">
        <Show
          when={launch()}
          fallback={
            <ToolRowContent
              card={card()}
              view={view()}
              outcome={outcome()}
              running={running()}
              workspaceFilePath={workspaceFilePath()}
              onOpenWorkspaceFile={props.options.onOpenWorkspaceFile}
            />
          }
        >
          {(spawned) => (
            <SessionLaunchRowContent
              launch={spawned()}
              subagent={subagent()}
              onOpen={canOpenSubagent() ? handleOpenSubagent : undefined}
            />
          )}
        </Show>
      </span>
      <Show when={inline() && outcome() !== "failed" && outcome() !== "skipped"}>
        <span class="chat-command-trail__status" role="status">
          {t(
            outcome() === "running"
              ? "chat.toolCards.running"
              : outcome() === "succeeded"
                ? "chat.toolCards.completed"
                : outcome() === "blocked"
                  ? "chat.toolCards.blocked"
                  : "chat.toolCards.outcomeUnknown",
          )}
        </span>
      </Show>
      <Show when={!props.options.expanded}>
        <ToolOutcomeSummary card={card()} />
      </Show>
      <span class="chat-tool-row__chevron" aria-hidden="true">
        <Icon name="chevronRight" />
      </span>
    </>
  );
  return (
    <Row
      class={[
        "chat-inline-disclosure chat-tool-msg-summary chat-tool-row",
        {
          "chat-tool-row--running": running(),
          [`chat-tool-row--${linkedRow()}`]: Boolean(linkedRow()),
        },
      ]}
      type={linkedRow() ? undefined : "button"}
      aria-expanded={linkedRow() ? undefined : props.options.expanded ? "true" : "false"}
      onPointerEnter={syncOverflow}
      onFocus={linkedRow() ? undefined : syncOverflow}
      onFocusIn={linkedRow() ? syncOverflow : undefined}
      onClick={linkedRow() ? undefined : toggle}
    >
      <Show when={linkedRow()}>
        <button
          class="chat-tool-row__toggle"
          type="button"
          aria-expanded={props.options.expanded ? "true" : "false"}
          aria-label={resolveToolRowText(card(), view(), outcome())}
          onClick={toggle}
        />
      </Show>
      {rowContent()}
    </Row>
  );
}

export function ToolMessageSummary(props: {
  state: GroupedMessagePresentation;
  options: GroupedMessageOptions;
}) {
  let disclosureContent: HTMLSpanElement | undefined;
  const syncOverflow = (event: Event) => syncToolDisclosureOverflow(event, disclosureContent);
  const summary = createMemo(() => {
    const { singleToolCard, toolCards, markdown, images, isStandaloneToolMessage } = props.state;
    const hasImages = images.length > 0;
    const toolNames = [...new Set(toolCards.map((card) => card.name))];
    const singleToolDisplay = singleToolCard
      ? resolveToolDisplay({
          name: singleToolCard.name,
          args: singleToolCard.args,
          detailMode: "explain",
        })
      : null;
    const singleToolDisplayDetail =
      singleToolCard && singleToolDisplay
        ? resolveCollapsedToolDetail(singleToolCard, singleToolDisplay.detail)
        : undefined;
    const toolSummaryLabelRaw = singleToolDisplayDetail
      ? !markdown || hasImages
        ? singleToolDisplayDetail
        : singleToolCard?.outputText?.trim()
          ? "output"
          : undefined
      : toolNames.length <= 3
        ? toolNames.join(", ")
        : `${toolNames.slice(0, 2).join(", ")} +${toolNames.length - 2} more`;
    const toolPreview =
      isStandaloneToolMessage && markdown ? (formatCollapsedToolPreviewText(markdown) ?? "") : "";
    const toolMessageLabelRaw =
      singleToolDisplay && (!markdown || hasImages)
        ? singleToolDisplay.label
        : t("chat.toolCards.toolOutput");
    const toolMessageLabel =
      formatCollapsedToolSummaryText(toolMessageLabelRaw) ?? toolMessageLabelRaw;
    const toolSummaryLabel = distinctSummaryText(toolSummaryLabelRaw, toolMessageLabel);
    return { singleToolDisplay, toolMessageLabel, toolSummaryLabel, toolPreview };
  });
  return (
    <button
      class="chat-inline-disclosure chat-tool-msg-summary"
      type="button"
      aria-expanded={props.state.toolMessageExpanded ? "true" : "false"}
      onPointerEnter={syncOverflow}
      onFocus={syncOverflow}
      onClick={() =>
        props.options.onToggleToolMessageExpanded?.(
          props.state.toolMessageDisclosureId,
          props.state.toolMessageExpanded,
        )
      }
    >
      <span class="chat-tool-msg-summary__icon">
        <Show when={summary().singleToolDisplay} fallback={<Icon name="zap" />}>
          <ChatToolIcon
            name={summary().singleToolDisplay!.icon}
            tool={{
              toolName: summary().singleToolDisplay!.name,
              pluginToolIcons: props.options.pluginToolIcons,
            }}
            style={{ display: "contents" }}
          />
        </Show>
      </span>
      <span ref={(element) => (disclosureContent = element)} class="chat-tool-disclosure__content">
        <span class="chat-tool-msg-summary__label">{summary().toolMessageLabel}</span>
        <Show
          when={summary().toolSummaryLabel}
          fallback={
            <Show when={summary().toolPreview}>
              <span class="chat-tool-msg-summary__preview">{summary().toolPreview}</span>
            </Show>
          }
        >
          <span class="chat-tool-msg-summary__names">{summary().toolSummaryLabel}</span>
        </Show>
      </span>
      <span class="chat-tool-row__chevron" aria-hidden="true">
        <Icon name="chevronRight" />
      </span>
    </button>
  );
}

/** The existing row import also supplies its ordinary card body. */
export function ToolCardBody(
  props: ToolCardProps & { displayCard: ToolCard; output?: ToolCardOutput },
) {
  const InlineToolPreview = dynamic(() => props.options.inlineCommands?.InlineToolPreview);
  return (
    <>
      <ToolCardRow
        card={props.displayCard}
        options={props.options}
        hasChildren={props.hasChildren}
      />
      <Show when={props.options.inlineCommands && !props.options.expanded && !props.hasChildren}>
        <InlineToolPreview card={props.displayCard} output={props.output} options={props.options} />
      </Show>
      <Show when={props.options.expanded}>
        <Show
          when={props.hasChildren}
          fallback={
            <div class="chat-tool-msg-body">
              <ExpandedToolCardContent
                card={props.card}
                output={props.output}
                options={props.options}
                commandInRow
              />
            </div>
          }
        >
          <div class="chat-tool-children">
            {props.children}
            <details class="chat-tool-wrapper-details">
              <summary>{t("chat.toolCards.toolInput")}</summary>
              <div class="chat-tool-msg-body">
                <ExpandedToolCardContent
                  card={props.card}
                  output={props.output}
                  options={props.options}
                />
              </div>
            </details>
          </div>
        </Show>
        <Show when={props.options.executionCards?.length}>
          <For each={props.options.executionCards}>
            {(execution) => (
              <Show
                when={props.options.onOpenSidebar}
                fallback={
                  <details class="chat-tool-wrapper-details">
                    <summary>{t("chat.toolCards.executionDetails")}</summary>
                    <div class="chat-tool-msg-body">
                      <ExpandedToolCardContent card={execution} options={props.options} />
                    </div>
                  </details>
                }
              >
                <button
                  class="btn btn--sm"
                  type="button"
                  onClick={() =>
                    props.options.onOpenSidebar?.({
                      kind: "tool-output",
                      card: execution,
                      sessionKey: props.options.sessionKey,
                      agentId: props.options.agentId,
                    })
                  }
                >
                  {t("chat.toolCards.executionDetails")}
                </button>
              </Show>
            )}
          </For>
        </Show>
      </Show>
    </>
  );
}
