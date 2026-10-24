import type { ProgressCardStep } from "@openclaw/gateway-protocol";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { For, Show, createMemo, lazy } from "solid-js";
import { readNodePermissionRequest } from "../../../../../packages/gateway-protocol/src/node-permissions.js";
import { unwrapToolCallForDisplay } from "../../../../../src/agents/tool-display-call.js";
import { browserTabKey } from "../../../components/browser/browser-target.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatToolLabelsEnglish } from "../../../i18n/locales/en-chat-tool-labels.ts";
import type { ToolCard, ToolCardOutcome } from "../../../lib/chat/chat-types.ts";
import { readToolApprovalReviews } from "../../../lib/chat/tool-approval-reviews.ts";
import { resolveToolCallInput } from "../../../lib/chat/tool-call-input.ts";
import { resolveToolCardDisplay, resolveToolCardOutcome } from "../../../lib/chat/tool-cards.ts";
import { resolveToolDisplayIdentity } from "../../../lib/chat/tool-display-identity.ts";
import { pathDisplayName } from "../../../lib/path-display.ts";
import { t, registerEnglishCatalog } from "../../../lib/reactive/i18n.ts";
import { PluginSurface } from "../../../plugins/control-ui-view.solid.tsx";
import { BrowserTabCardHost } from "./browser-tab-card.tsx";
import { DiffStatChips } from "./chat-diff-stat.solid.tsx";
import { ChatImportBoundary } from "./chat-import-boundary.tsx";
import { ChatPermissionCard } from "./chat-permission-card.tsx";
import { ToolIcon } from "./chat-tool-card-chrome.tsx";
import type { ToolCardProps } from "./chat-tool-card-types.ts";
import type { BrowserTabPreview } from "./chat-tool-cards.ts";
import { ExpandedToolCardContent } from "./chat-tool-content.solid.tsx";
import { ToolOutcomeSummary } from "./chat-tool-outcome-summary.solid.tsx";
import { toolResultSurfaceProps } from "./chat-tool-render-model.ts";
import { resolveToolRowVerb } from "./chat-tool-row-presentation.ts";

registerEnglishCatalog(registerChatToolLabelsEnglish);

const ToolCardRow = lazy(() => import("./chat-tool-card-row.solid.tsx"), { export: "ToolCardRow" });

export function BrowserTabPreviews(props: {
  previews: readonly BrowserTabPreview[] | undefined;
  mediaReadAllowed?: boolean;
}) {
  return (
    <For
      each={props.mediaReadAllowed === false ? undefined : props.previews}
      keyed={(item) => browserTabKey(item.preview)}
    >
      {(item) => (
        <BrowserTabCardHost
          preview={item().preview}
          revision={item().revision}
          latest={item().latest}
        />
      )}
    </For>
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

function ToolCardRowPlaceholder(props: ToolCardProps) {
  const display = () => resolveToolDisplayIdentity(unwrapToolCallForDisplay(props.card).name);
  const input = createMemo(() => {
    const call = unwrapToolCallForDisplay(props.card);
    return resolveToolCallInput(call.name, asNullableRecord(call.args));
  });
  const outcome = () => resolveToolCardOutcome(props.card, props.options.runActive);
  const verb = () => resolveToolRowVerb(input(), outcome());
  const stat = () =>
    outcome() === "running" && (input().kind === "edit" || input().kind === "write")
      ? props.card.liveDiffStat
      : undefined;
  const activityCards = () => props.options.activityCards ?? [props.card];
  const running = () =>
    activityCards().some(
      (item) => resolveToolCardOutcome(item, props.options.runActive) === "running",
    );
  return (
    <button
      class={[
        "chat-inline-disclosure chat-tool-msg-summary chat-tool-row",
        { "chat-tool-row--running": running() },
      ]}
      type="button"
      disabled
      aria-busy="true"
    >
      <span
        class="chat-tool-msg-summary__icon"
        role="img"
        aria-label={display().name}
        title={display().name}
      >
        <ToolIcon
          name={display().icon}
          tool={{ toolName: display().name, pluginToolIcons: props.options.pluginToolIcons }}
        />
      </span>
      <span class="chat-tool-disclosure__content">
        <Show
          when={verb() && input().path}
          fallback={<span class="chat-tool-msg-summary__label">{display().label}</span>}
        >
          <span class="chat-tool-row__verb">{verb()}</span>
          <span class="chat-tool-row__target">{pathDisplayName(input().path!)}</span>
          <Show when={stat()}>{(value) => <DiffStatChips stat={value()} />}</Show>
        </Show>
      </span>
      <Show when={!props.options.expanded}>
        <ToolOutcomeSummary cards={activityCards()} includeCount={Boolean(props.hasChildren)} />
      </Show>
      <span class="chat-tool-row__chevron" aria-hidden="true">
        <Icon name="chevronRight" />
      </span>
    </button>
  );
}

function ToolCardView(props: ToolCardProps) {
  let host: HTMLDivElement | undefined;
  const card = createMemo(() => resolveToolCardDisplay(props.card), { equals: false });
  const permission = () =>
    readNodePermissionRequest(asNullableRecord(card().details)?.permissionMissing);
  const outcome = () => resolveToolCardOutcome(card(), props.options.runActive);
  return (
    <Show
      when={permission()}
      fallback={
        <Show
          when={card().name.trim().toLowerCase() === "progress_card" && !props.hasChildren}
          fallback={
            <div
              ref={(element) => (host = element)}
              class={[
                "chat-tool-msg-collapse chat-tool-msg-collapse--manual",
                { "is-open": props.options.expanded },
              ]}
            >
              <ChatImportBoundary
                identity={[props.options.sessionKey, props.options.messageKey, card().id]}
                connected={() => Boolean(host?.isConnected)}
                fallback={() => (
                  <ToolCardRowPlaceholder
                    card={card()}
                    options={props.options}
                    hasChildren={props.hasChildren}
                  />
                )}
              >
                <ToolCardRow
                  card={card()}
                  options={props.options}
                  hasChildren={props.hasChildren}
                />
              </ChatImportBoundary>
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
      }
    >
      {(request) => (
        <ChatPermissionCard request={request()} onRetry={props.options.onPermissionRetry} />
      )}
    </Show>
  );
}

export function ChatToolCard(props: ToolCardProps) {
  return (
    <PluginSurface
      surface="tool-result"
      props={toolResultSurfaceProps(props.card, props.options)}
      presented={props.options.presented ?? true}
      enabled={props.options.mediaReadAllowed !== false}
      renderDefault={() => (
        <openclaw-chat-tool-card style={{ display: "contents" }}>
          <ToolCardView
            card={props.card}
            options={props.options}
            hasChildren={props.hasChildren ?? Boolean(props.children)}
          >
            {props.children}
          </ToolCardView>
        </openclaw-chat-tool-card>
      )}
    />
  );
}
