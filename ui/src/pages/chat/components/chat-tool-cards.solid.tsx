import type { ProgressCardStep } from "@openclaw/gateway-protocol";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { JSX } from "@solidjs/web";
import { For, Match, Show, Switch, createMemo } from "solid-js";
import { stripShellPreamble } from "../../../../../src/agents/tool-display-exec-shell.js";
import { iconData } from "../../../components/icon-data.ts";
import { Icon, type IconName } from "../../../components/solid/icon.tsx";
import type { ToolCard, ToolCardOutcome } from "../../../lib/chat/chat-types.ts";
import { readToolApprovalReviews } from "../../../lib/chat/tool-approval-reviews.ts";
import { resolveToolCallView, type ToolCallView } from "../../../lib/chat/tool-call-view.ts";
import {
  formatDistinctCollapsedToolSummaryText as distinctSummaryText,
  formatCollapsedToolPreviewText,
  formatCollapsedToolSummaryText,
  resolveCollapsedToolArgumentPreview as toolArgumentPreview,
  resolveToolCardDisplay,
  resolveToolCardOutcome,
} from "../../../lib/chat/tool-cards.ts";
import { resolveToolDisplay } from "../../../lib/chat/tool-display.ts";
import { formatDurationCompact } from "../../../lib/format-duration.ts";
import { pathDisplayName } from "../../../lib/path-display.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { defineSolidBridge } from "../../../lit/solid-bridge.ts";
import { resolveSpawnedSubagent, type SpawnedSubagent } from "../chat-spawned-subagent.ts";
import type { PluginToolIcons } from "../chat-tool-icon-controller.ts";
import { HighlightedCommand } from "./chat-command-highlight.solid.tsx";
import { DiffStatChips } from "./chat-diff-render.solid.tsx";
import { ExpandedToolCardContent } from "./chat-tool-content.solid.tsx";
import { ToolOutcomeSummary } from "./chat-tool-outcome-summary.solid.tsx";
import { toolWorkspacePath, type ToolRenderOptions } from "./chat-tool-render-model.ts";

const TOOL_ROW_VERB_KEYS: Partial<Record<ToolCallView["kind"], string>> = {
  read: "chat.toolCards.verbs.read",
  search: "chat.toolCards.verbs.searched",
  fetch: "chat.toolCards.verbs.fetched",
};

const MUTATION_VERB_KEYS = {
  update: ["editing", "edited", "edit"],
  add: ["creating", "created", "create"],
  delete: ["deleting", "deleted", "delete"],
  mixed: ["changing", "changed", "change"],
  write: ["writing", "wrote", "write"],
} as const;

function resolveMutationVerbKind(view: ToolCallView): keyof typeof MUTATION_VERB_KEYS | undefined {
  if (view.kind === "write") {
    return "write";
  }
  if (view.kind !== "edit") {
    return undefined;
  }
  const operations = new Set(view.fileOperations?.map(({ operation }) => operation));
  return operations.size > 1 ? "mixed" : (operations.values().next().value ?? "update");
}

function resolveToolRowVerb(view: ToolCallView, outcome: ToolCardOutcome): string | undefined {
  const mutation = resolveMutationVerbKind(view);
  if (mutation) {
    const [running, succeeded, fallback] = MUTATION_VERB_KEYS[mutation];
    return t(
      `chat.toolCards.verbs.${outcome === "running" ? running : outcome === "succeeded" ? succeeded : fallback}`,
    );
  }
  const key = TOOL_ROW_VERB_KEYS[view.kind];
  return key ? t(key) : undefined;
}

const TOOL_ROW_ICONS: Partial<Record<ToolCallView["kind"], string>> = {
  command: "squareTerminal",
  read: "fileText",
  edit: "pencil",
  write: "fileCode",
  search: "search",
  fetch: "globe",
};

function commandPreview(command: string): string {
  return truncateUtf16Safe(
    (stripShellPreamble(command).command || command).replace(/\s+/gu, " ").trim(),
    200,
  );
}

export function syncToolDisclosureOverflow(event: Event): void {
  const disclosure = event.currentTarget;
  if (!(disclosure instanceof HTMLElement)) {
    return;
  }
  const content = disclosure.querySelector<HTMLElement>(".chat-tool-disclosure__content");
  disclosure.classList.toggle(
    "chat-tool-disclosure--overflowing",
    Boolean(content && content.scrollWidth > content.clientWidth),
  );
}

function progressReceiptSteps(value: unknown): ProgressCardStep[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    const step = asNullableRecord(entry);
    if (
      typeof step?.step !== "string" ||
      (step.status !== "pending" && step.status !== "in_progress" && step.status !== "completed")
    ) {
      return [];
    }
    return [{ step: step.step, status: step.status }];
  });
}

export function resolveCollapsedToolDetail(card: ToolCard, displayDetail: string | undefined) {
  if (displayDetail?.trim()) {
    return displayDetail;
  }
  return typeof card.args === "string"
    ? formatCollapsedToolPreviewText(card.inputText?.trim() ? card.inputText : card.args)
    : undefined;
}

function resolveCollapsedToolSummaryParts(card: ToolCard): { label: string; name?: string } {
  const display = resolveToolDisplay({ name: card.name, args: card.args, detailMode: "explain" });
  const displayDetail = display.detail?.trim();
  // Message captions belong to the canonical publication, not the original tool input.
  if (card.name.trim().toLowerCase() === "message") {
    return { label: display.label, name: displayDetail || undefined };
  }
  const name = toolArgumentPreview(card.args) || displayDetail;
  if (name) {
    return { label: display.label, name };
  }

  return {
    label: resolveCollapsedToolDetail(card, undefined) ?? display.label,
  };
}

function resolveToolRowText(card: ToolCard, view: ToolCallView, outcome: ToolCardOutcome): string {
  if (view.title) {
    return view.title;
  }
  if (view.kind === "command" && view.command) {
    return `$ ${commandPreview(view.command)}`;
  }
  const verb = resolveToolRowVerb(view, outcome);
  if (verb && view.target) {
    return `${verb} ${view.target}`;
  }
  const summary = resolveCollapsedToolSummaryParts(card);
  return [summary.label, summary.name].filter(Boolean).join(" ");
}

export function ToolIcon(props: {
  name: string;
  tool?: { toolName: string; pluginToolIcons?: PluginToolIcons };
}) {
  const activityIcon = () => props.tool?.pluginToolIcons?.get(props.tool.toolName);
  const fallbackIcon = () => {
    // SAFETY: Own icon-data keys are the IconName union; unknown names use its puzzle entry.
    return (Object.hasOwn(iconData, props.name) ? props.name : "puzzle") as IconName;
  };
  return (
    <Show when={activityIcon()} fallback={<Icon name={fallbackIcon()} />}>
      {(icon) => (
        <span
          class="chat-tool-activity-icon"
          aria-hidden="true"
          style={{ "mask-image": `url("${icon().url}")` }}
        >
          <img hidden src={icon().url} alt="" onError={() => icon().onError()} />
        </span>
      )}
    </Show>
  );
}

function ToolRowLink(props: { kind: "file" | "subagent"; label: string; onOpen: () => void }) {
  return (
    <button
      class={`chat-tool-row__${props.kind}-link`}
      type="button"
      title={t(props.kind === "file" ? "chat.toolCards.openFile" : "chat.toolCards.openSubagent")}
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
  toolLabel: string;
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
  const summary = createMemo(() => resolveCollapsedToolSummaryParts(props.card));
  const displayLabel = () => formatCollapsedToolSummaryText(summary().label) ?? summary().label;
  const displayName = () => distinctSummaryText(summary().name, displayLabel());
  return (
    <Switch
      fallback={
        <>
          <Show when={!displayName() || summary().label !== props.toolLabel}>
            <span class="chat-tool-msg-summary__label">{displayLabel()}</span>
          </Show>
          <Show when={displayName()}>
            <span class="chat-tool-msg-summary__names">{displayName()}</span>
          </Show>
        </>
      }
    >
      <Match when={props.view.title}>
        <span class="chat-tool-row__title">{props.view.title}</span>
      </Match>
      <Match when={props.view.kind === "command" && props.view.command}>
        <span class="chat-tool-row__prompt" aria-hidden="true">
          $
        </span>
        <code class="chat-tool-row__cmd">
          <HighlightedCommand command={commandPreview(props.view.command!)} />
        </code>
      </Match>
      <Match when={verb() && props.view.target}>
        <span class="chat-tool-row__verb">{verb()}</span>
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

function SubagentRowContent(props: { subagent: SpawnedSubagent; onOpen?: () => void }) {
  const state = () =>
    props.subagent.session?.running
      ? t("chat.toolCards.subagentRunning")
      : props.subagent.session?.ended === "failed"
        ? t("chat.toolCards.failed")
        : props.subagent.session?.ended === "stopped"
          ? t("chat.toolCards.subagentStopped")
          : formatDurationCompact(props.subagent.session?.runtimeMs);
  return (
    <>
      <Show
        when={props.onOpen}
        fallback={<span class="chat-tool-row__title">{props.subagent.label}</span>}
      >
        <ToolRowLink kind="subagent" label={props.subagent.label} onOpen={() => props.onOpen?.()} />
      </Show>
      <Show when={state()}>
        <span
          class={[
            "chat-tool-row__subagent-state",
            { "chat-tool-row__subagent-state--failed": props.subagent.session?.ended === "failed" },
          ]}
        >
          {state()}
        </span>
      </Show>
    </>
  );
}

function progressReceiptLabel(card: ToolCard, outcome: ToolCardOutcome) {
  const args = asNullableRecord(card.args);
  const steps = progressReceiptSteps(args?.plan);
  const markdown = typeof args?.markdown === "string" ? args.markdown.trim() : "";
  const completed = steps.filter((step) => step.status === "completed").length;
  const current =
    steps.find((step) => step.status === "in_progress") ??
    steps.find((step) => step.status === "pending") ??
    steps.findLast((step) => step.status === "completed");
  return outcome === "skipped"
    ? t("sessionProgressCard.receipt.skipped")
    : outcome === "failed"
      ? t("sessionProgressCard.receipt.failed")
      : outcome === "running"
        ? t("sessionProgressCard.receipt.updating")
        : steps.length > 0
          ? t("sessionProgressCard.receipt.updated", {
              completed: String(completed),
              current: current?.step ?? "",
              total: String(steps.length),
            })
          : markdown
            ? t("sessionProgressCard.receipt.noteUpdated")
            : t("sessionProgressCard.receipt.cleared");
}

export function ToolApprovalReviews(props: { card: ToolCard }) {
  const reviews = createMemo(() => readToolApprovalReviews(props.card.details));
  return (
    <Show when={reviews().length > 0}>
      <div class="chat-tool-reviews">
        <For each={reviews()}>
          {(review) => {
            const adverse = ["denied", "timed_out", "aborted"].includes(review.status);
            const key =
              review.status === "in_progress"
                ? "reviewing"
                : review.status === "timed_out"
                  ? "timedOut"
                  : review.status;
            return (
              <div class="chat-tool-review" data-review-status={review.status}>
                <div class="chat-tool-review__header">
                  <span class="chat-tool-review__icon">
                    <Icon name={adverse ? "shieldX" : "shieldCheck"} />
                  </span>
                  <span class="chat-tool-review__label">
                    {t(`chat.toolCards.review.${key}`, { reviewer: review.label })}
                  </span>
                  <For
                    each={[
                      { kind: "risk", level: review.riskLevel },
                      { kind: "authorization", level: review.userAuthorization },
                    ]}
                  >
                    {(chip) => (
                      <Show when={chip.level}>
                        <span class="chat-tool-review__chip">
                          {t(`chat.toolCards.review.${chip.kind}`, { level: chip.level! })}
                        </span>
                      </Show>
                    )}
                  </For>
                </div>
                <Show when={review.status !== "in_progress"}>
                  <div class="chat-tool-review__rationale">
                    {review.rationale ?? t("chat.toolCards.review.noRationale")}
                  </div>
                </Show>
              </div>
            );
          }}
        </For>
      </div>
    </Show>
  );
}

export type ToolCardOptions = ToolRenderOptions & {
  expanded: boolean;
  onToggleExpanded: (id: string) => void;
  showApprovalReviews?: boolean;
  activityCards?: readonly ToolCard[];
};
type ToolCardProps = {
  card: ToolCard;
  options: ToolCardOptions;
  hasChildren?: boolean;
  children?: JSX.Element;
};

export function ToolCardView(props: ToolCardProps) {
  const card = createMemo(() => resolveToolCardDisplay(props.card), { equals: false });
  const outcome = () => resolveToolCardOutcome(card(), props.options.runActive);
  const view = createMemo(() =>
    resolveToolCallView({ name: card().name, args: card().args, details: card().details }),
  );
  const display = createMemo(() =>
    resolveToolDisplay({ name: card().name, args: card().args, detailMode: "explain" }),
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
  const onOpenSubagent = () =>
    (subagent()?.session?.listed && props.options.subagents?.onOpenSubagent) ||
    props.options.subagents?.onOpenSession;
  const canOpenSubagent = () => Boolean(subagent()?.session && onOpenSubagent());
  const handleOpenSubagent = () => {
    const session = subagent()?.session;
    if (session) {
      onOpenSubagent()?.(session.key);
    }
  };
  const linkedRow = () => (workspaceFilePath() ? "file" : canOpenSubagent() ? "subagent" : null);
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
      <span class="chat-tool-disclosure__content">
        <Show
          when={subagent()}
          fallback={
            <ToolRowContent
              card={card()}
              view={view()}
              outcome={outcome()}
              toolLabel={display().label}
              workspaceFilePath={workspaceFilePath()}
              onOpenWorkspaceFile={props.options.onOpenWorkspaceFile}
            />
          }
        >
          {(spawned) => (
            <SubagentRowContent
              subagent={spawned()}
              onOpen={canOpenSubagent() ? handleOpenSubagent : undefined}
            />
          )}
        </Show>
      </span>
      <Show when={!props.options.expanded}>
        <ToolOutcomeSummary cards={activityCards()} includeCount={Boolean(props.hasChildren)} />
      </Show>
      <span class="chat-tool-row__chevron" aria-hidden="true">
        <Icon name="chevronRight" />
      </span>
    </>
  );
  return (
    <Show
      when={card().name.trim().toLowerCase() === "progress_card" && !props.hasChildren}
      fallback={
        <div
          class={[
            "chat-tool-msg-collapse chat-tool-msg-collapse--manual",
            { "is-open": props.options.expanded },
          ]}
        >
          <Show
            when={linkedRow()}
            fallback={
              <button
                class={[
                  "chat-inline-disclosure chat-tool-msg-summary chat-tool-row",
                  { "chat-tool-row--running": running() },
                ]}
                type="button"
                aria-expanded={props.options.expanded ? "true" : "false"}
                onPointerEnter={syncToolDisclosureOverflow}
                onFocus={syncToolDisclosureOverflow}
                onClick={() => props.options.onToggleExpanded(card().id)}
              >
                {rowContent()}
              </button>
            }
          >
            <div
              class={[
                `chat-inline-disclosure chat-tool-msg-summary chat-tool-row chat-tool-row--${linkedRow()}`,
                { "chat-tool-row--running": running() },
              ]}
              onPointerEnter={syncToolDisclosureOverflow}
              onFocusIn={syncToolDisclosureOverflow}
            >
              <button
                class="chat-tool-row__toggle"
                type="button"
                aria-expanded={props.options.expanded ? "true" : "false"}
                aria-label={
                  subagent()
                    ? `${display().label} ${subagent()!.label}`
                    : resolveToolRowText(card(), view(), outcome())
                }
                onClick={() => props.options.onToggleExpanded(card().id)}
              />
              {rowContent()}
            </div>
          </Show>
          <Show when={props.options.expanded}>
            <Show
              when={props.hasChildren}
              fallback={
                <div class="chat-tool-msg-body">
                  <ExpandedToolCardContent card={props.card} options={props.options} />
                </div>
              }
            >
              <div class="chat-tool-children">
                {props.children}
                <details class="chat-tool-wrapper-details">
                  <summary>{t("chat.toolCards.toolInput")}</summary>
                  <div class="chat-tool-msg-body">
                    <ExpandedToolCardContent card={props.card} options={props.options} />
                  </div>
                </details>
              </div>
            </Show>
          </Show>
          <Show when={props.options.showApprovalReviews !== false}>
            <ToolApprovalReviews card={card()} />
          </Show>
        </div>
      }
    >
      <div class="chat-tool-msg-collapse chat-progress-card-receipt">
        <div class="chat-tool-msg-summary chat-tool-row" role="status">
          <span class="chat-tool-msg-summary__icon">
            <ToolIcon name="listChecks" />
          </span>
          <span class="chat-progress-card-receipt__text">
            {progressReceiptLabel(card(), outcome())}
          </span>
        </div>
      </div>
    </Show>
  );
}

export const ToolCardHost = defineSolidBridge<{
  card: ToolCard | null;
  options: ToolCardOptions;
  hasChildren: boolean;
}>(
  "openclaw-chat-tool-card",
  (props) => (
    <Show when={props.card}>
      {(card) => (
        <ToolCardView card={card()} options={props.options} hasChildren={props.hasChildren}>
          {props.children}
        </ToolCardView>
      )}
    </Show>
  ),
  {
    properties: {
      card: { default: null, attribute: false },
      options: {
        default: { messageKey: "", expanded: false, onToggleExpanded: () => {} },
        attribute: false,
      },
      hasChildren: { default: false, attribute: false },
    },
  },
);
export const ToolIconHost = defineSolidBridge<{
  name: string;
  tool?: { toolName: string; pluginToolIcons?: PluginToolIcons };
}>("openclaw-chat-tool-icon", (props) => <ToolIcon name={props.name} tool={props.tool} />, {
  properties: {
    name: { default: "puzzle", attribute: false },
    tool: { default: undefined, attribute: false },
  },
});
export const ToolReviewsHost = defineSolidBridge<{ card: ToolCard | null }>(
  "openclaw-chat-tool-reviews",
  (props) => <Show when={props.card}>{(card) => <ToolApprovalReviews card={card()} />}</Show>,
  { properties: { card: { default: null, attribute: false } } },
);
