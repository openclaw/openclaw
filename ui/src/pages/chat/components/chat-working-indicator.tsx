import { createMemo, Show } from "solid-js";
import type {
  ThemeBranding,
  ThemeMascot,
  ThemeWorkingIndicator,
} from "../../../../../packages/gateway-protocol/src/theme.ts";
import { currentThemeBranding, subscribeThemeBranding } from "../../../app/theme-branding.ts";
import "../../../components/elapsed-time.tsx";
import "../../../components/working-phrase.ts";
import "./chat-retry-status.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import { ThemeBrandIcon } from "../../../components/theme-brand-icon.tsx";
import type { ChatItem } from "../../../lib/chat/chat-types.ts";
import { formatDurationLong } from "../../../lib/format-duration.ts";
import { formatCompactTokenCount } from "../../../lib/format.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { projectSource } from "../../../lib/reactive/projection.ts";
import { LitContent } from "../../../lit/solid-content.tsx";
import type { TurnRecap } from "../chat-progress.ts";
import type { ChatSubagentWait } from "../chat-subagent-wait.ts";
import { selectWorkingClawSurprise } from "./chat-working-indicator-surprise.ts";

type ChatWorkingIndicatorOptions = {
  bubbleMode?: boolean;
  mascot?: ThemeMascot;
  workingIndicator?: ThemeWorkingIndicator;
  workingPhrases?: readonly string[];
  waitingApproval?: boolean;
  waitingSubagents?: ChatSubagentWait;
  /** Unfinished subagents to mention while the session itself is still working. */
  runningSubagents?: number;
  subagentActivity?: unknown;
  /** Shows the session's subagents; without it their count is plain text. */
  onOpenSubagents?: () => void;
  startupLabel?: string;
  retryAt?: number;
  outputTokens?: number | null;
  presentation?: "standalone" | "continuation";
};

type WorkingProps = {
  part: Extract<ChatItem, { kind: "reading-indicator" }>;
  options?: ChatWorkingIndicatorOptions;
};

// 0 is valid; only null/undefined means "unknown".
function outputTokensLabel(outputTokens: number): string {
  return outputTokens === 1
    ? t("chat.turnRecap.tokensOne")
    : t("chat.turnRecap.tokens", { count: formatCompactTokenCount(outputTokens) });
}

function WorkingBrandIcon(props: { branding: ThemeBranding; claw: "claw" | "lobster" }) {
  return (
    <Show when={props.branding.brandIcon !== "claw"} fallback={<Icon name={props.claw} />}>
      <Show when={props.branding.brandIcon !== "mark"} fallback={<Icon name="mark" />}>
        <ThemeBrandIcon branding={props.branding} />
      </Show>
    </Show>
  );
}

function WorkingContent(props: WorkingProps) {
  const options = () => props.options ?? {};
  const branding = projectSource(null, {
    read: currentThemeBranding,
    subscribe: (_source, notify) => subscribeThemeBranding(notify),
    equality: Object.is,
  });
  const indicator = () =>
    options().workingIndicator ??
    (options().mascot !== undefined
      ? options().mascot === "none"
        ? "dots"
        : "claw"
      : branding.read().workingIndicator);
  const continuation = () => options().presentation === "continuation";
  const working = () => !options().waitingApproval && !options().startupLabel;
  const hasOutputTokens = () => options().outputTokens != null;
  const statusLabelHidden = () => working() && !continuation() && indicator() !== "none";
  const runningSubagents = () => options().runningSubagents ?? 0;
  const runningLabel = () =>
    runningSubagents() === 1
      ? t("chat.subagentsRunningOne")
      : t("chat.subagentsRunning", { count: String(runningSubagents()) });
  const statusLabel = () =>
    options().waitingApproval
      ? t("chat.waitingForApproval")
      : options().startupLabel || t("common.working");
  const bubbleClass = () =>
    indicator() === "dots"
      ? "chat-reading-indicator--neutral"
      : indicator() === "brand"
        ? "chat-reading-indicator--brand"
        : selectWorkingClawSurprise(props.part.key, { eligible: working() });
  return (
    <>
      <div
        class={[
          "chat-working-indicator",
          { "chat-working-indicator--continuation": continuation() },
        ]}
        role="status"
        aria-live="off"
      >
        <Show when={!continuation() && indicator() !== "none"}>
          <div class={["chat-bubble", "chat-reading-indicator", bubbleClass()]} aria-hidden="true">
            <Show
              when={indicator() !== "dots"}
              fallback={
                <>
                  <span />
                  <span />
                  <span />
                </>
              }
            >
              <Show when={indicator() === "brand"} fallback={<Icon name="claw" />}>
                <WorkingBrandIcon branding={branding.read()} claw="lobster" />
              </Show>
            </Show>
          </div>
        </Show>
        <span class="chat-working-indicator__status">
          <span class={statusLabelHidden() ? "sr-only" : ""}>
            <Show
              when={!options().waitingApproval && options().retryAt !== undefined}
              fallback={statusLabel()}
            >
              <openclaw-chat-retry-status prop:retryAt={options().retryAt ?? null} />
            </Show>
          </span>
          <Show when={hasOutputTokens()}>
            <Show when={!statusLabelHidden()}>
              <span aria-hidden="true">·</span>
            </Show>
            <span class="chat-working-indicator__tokens">
              {outputTokensLabel(options().outputTokens!)}
            </span>
          </Show>
          <Show when={!options().waitingApproval}>
            <Show when={options().startupLabel || hasOutputTokens()}>
              <span aria-hidden="true">·</span>
            </Show>
            <openclaw-elapsed-time
              class="chat-working-indicator__elapsed"
              prop:startMs={props.part.startedAt}
            />
          </Show>
          <Show when={!hasOutputTokens() && working()}>
            <openclaw-working-phrase
              aria-hidden="true"
              prop:startMs={props.part.startedAt}
              prop:seed={props.part.key}
              prop:phrases={options().workingPhrases}
            />
          </Show>
          <Show when={runningSubagents() > 0}>
            <span aria-hidden="true">·</span>
            <Show
              when={options().onOpenSubagents}
              fallback={<span class="chat-working-indicator__subagents">{runningLabel()}</span>}
            >
              <button
                class="chat-working-indicator__subagents"
                type="button"
                onClick={() => options().onOpenSubagents?.()}
              >
                {runningLabel()}
              </button>
            </Show>
          </Show>
        </span>
      </div>
      <LitContent value={options().subagentActivity} />
    </>
  );
}

export function ChatWorkingIndicator(props: WorkingProps) {
  const options = () => props.options ?? {};
  const bubble = () =>
    options().bubbleMode &&
    !options().waitingApproval &&
    !options().startupLabel &&
    (options().runningSubagents ?? 0) === 0;
  return (
    <Show
      when={!(options().waitingSubagents && options().subagentActivity !== undefined)}
      fallback={<LitContent value={options().subagentActivity} />}
    >
      <Show when={bubble()} fallback={<WorkingContent part={props.part} options={props.options} />}>
        <details class="chat-bubble-activity chat-bubble-activity--working">
          <summary
            class="chat-bubble-activity__summary"
            aria-label={t("chat.view.workingDetails")}
            title={t("chat.view.activityDetails")}
          >
            <span class="chat-bubble-dots chat-bubble-dots--working" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
          </summary>
          <div class="chat-bubble-activity__details">
            <WorkingContent part={props.part} options={props.options} />
          </div>
        </details>
      </Show>
    </Show>
  );
}

/** Post-turn recap row, retained until the next run replaces it. */
export function TurnRecapRow(props: {
  recap: TurnRecap;
  presentation?: "standalone" | "continuation";
}) {
  const branding = projectSource(null, {
    read: currentThemeBranding,
    subscribe: (_source, notify) => subscribeThemeBranding(notify),
    equality: Object.is,
  });
  // Sub-second turns still read as one second; terminal recaps favor full words.
  const duration = createMemo(
    () => formatDurationLong(Math.max(1, Math.round(props.recap.runtimeMs / 1_000)) * 1_000) ?? "",
  );
  const tokens = () =>
    typeof props.recap.outputTokens === "number"
      ? outputTokensLabel(props.recap.outputTokens)
      : null;
  return (
    <div
      class={[
        "chat-turn-recap",
        { "chat-turn-recap--continuation": props.presentation === "continuation" },
      ]}
      role="status"
    >
      <Show when={props.presentation !== "continuation"}>
        <span class="chat-turn-recap__claw" aria-hidden="true">
          <WorkingBrandIcon branding={branding.read()} claw="claw" />
        </span>
      </Show>
      <Show when={tokens() !== null}>
        <span>{tokens()}</span>
        <span class="chat-turn-recap__sep" aria-hidden="true">
          ·
        </span>
      </Show>
      <span>{t("chat.turnRecap.doneIn", { duration: duration() })}</span>
    </div>
  );
}
