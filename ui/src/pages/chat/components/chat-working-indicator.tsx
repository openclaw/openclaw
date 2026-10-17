import { Show } from "solid-js";
import type {
  ThemeBranding,
  ThemeMascot,
  ThemeWorkingIndicator,
} from "../../../../../packages/gateway-protocol/src/theme.ts";
import { currentThemeBranding, subscribeThemeBranding } from "../../../app/theme-branding.ts";
import "../../../components/elapsed-time.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import { ThemeBrandIcon } from "../../../components/theme-brand-icon.tsx";
import "../../../components/working-phrase.ts";
import type { ChatItem } from "../../../lib/chat/chat-types.ts";
import { formatDurationLong } from "../../../lib/format-duration.ts";
import { formatCompactTokenCount } from "../../../lib/format.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { projectSource } from "../../../lib/reactive/projection.ts";
import type { TurnRecap } from "../chat-progress.ts";
import type { ChatSubagentWait } from "../chat-subagent-wait.ts";
import { ChatSubagentActivity } from "./chat-subagent-activity-live.ts";
import type { SubagentActivityProps } from "./chat-subagent-activity.ts";
import "./chat-retry-status.tsx";
import { selectWorkingClawSurprise } from "./chat-working-indicator-surprise.ts";

type ReadingIndicator = Extract<ChatItem, { kind: "reading-indicator" }>;
type ChatWorkingIndicatorOptions = {
  bubbleMode?: boolean;
  mascot?: ThemeMascot;
  workingIndicator?: ThemeWorkingIndicator;
  workingPhrases?: readonly string[];
  waitingApproval?: boolean;
  waitingSubagents?: ChatSubagentWait;
  runningSubagents?: number;
  subagentActivity?: SubagentActivityProps;
  onOpenSubagents?: () => void;
  startupLabel?: string;
  retryAt?: number;
  outputTokens?: number | null;
  presentation?: "standalone" | "continuation";
};

type WorkingProps = { part: ReadingIndicator; options: ChatWorkingIndicatorOptions };

function projectBranding() {
  return projectSource(undefined, {
    read: currentThemeBranding,
    subscribe: (_, notify) => subscribeThemeBranding(notify),
    equality: Object.is,
  });
}

function BrandGlyph(props: { branding: ThemeBranding; claw: "claw" | "lobster" }) {
  return (
    <Show
      when={props.branding.brandIcon === "claw" || props.branding.brandIcon === "mark"}
      fallback={<ThemeBrandIcon branding={props.branding} />}
    >
      <Icon name={props.branding.brandIcon === "claw" ? props.claw : "mark"} />
    </Show>
  );
}

function outputTokensLabel(outputTokens: number): string {
  return outputTokens === 1
    ? t("chat.turnRecap.tokensOne")
    : t("chat.turnRecap.tokens", { count: formatCompactTokenCount(outputTokens) });
}

function WorkingStatus(props: WorkingProps & { branding: ThemeBranding }) {
  const waitingApproval = () => props.options.waitingApproval === true;
  const working = () => !waitingApproval() && !props.options.startupLabel;
  const continuation = () => props.options.presentation === "continuation";
  const indicator = () =>
    props.options.workingIndicator ??
    (props.options.mascot !== undefined
      ? props.options.mascot === "none"
        ? "dots"
        : "claw"
      : props.branding.workingIndicator);
  const runningSubagents = () => props.options.runningSubagents ?? 0;
  const runningLabel = () =>
    runningSubagents() === 1
      ? t("chat.subagentsRunningOne")
      : t("chat.subagentsRunning", { count: String(runningSubagents()) });
  const statusLabel = () =>
    waitingApproval()
      ? t("chat.waitingForApproval")
      : props.options.startupLabel || t("common.working");
  return (
    <div
      class={[
        "chat-working-indicator",
        {
          "chat-working-indicator--continuation": continuation(),
          "chat-working-indicator--supporting": props.options.subagentActivity !== undefined,
        },
      ]}
      role="status"
      aria-live="off"
    >
      <Show
        when={
          !continuation() && props.options.subagentActivity === undefined && indicator() !== "none"
        }
      >
        <div
          class={[
            "chat-bubble chat-reading-indicator",
            {
              "chat-reading-indicator--neutral": indicator() === "dots",
              "chat-reading-indicator--brand": indicator() === "brand",
            },
            indicator() === "claw"
              ? selectWorkingClawSurprise(props.part.key, { eligible: working() })
              : "",
          ]}
          aria-hidden="true"
        >
          <Show
            when={indicator() === "dots"}
            fallback={
              <Show when={indicator() === "brand"} fallback={<Icon name="claw" />}>
                <BrandGlyph branding={props.branding} claw="lobster" />
              </Show>
            }
          >
            <span />
            <span />
            <span />
          </Show>
        </div>
      </Show>
      <span class="chat-working-indicator__status">
        <span class={{ "sr-only": working() && !continuation() && indicator() !== "none" }}>
          <Show
            when={!waitingApproval() && props.options.retryAt !== undefined}
            fallback={statusLabel()}
          >
            <openclaw-chat-retry-status prop:retryAt={props.options.retryAt} />
          </Show>
        </span>
        <Show
          when={props.options.outputTokens !== null && props.options.outputTokens !== undefined}
        >
          <Show when={!working() || continuation() || indicator() === "none"}>
            <span aria-hidden="true">·</span>
          </Show>
          <span class="chat-working-indicator__tokens">
            {outputTokensLabel(props.options.outputTokens!)}
          </span>
        </Show>
        <Show when={!waitingApproval()}>
          <Show when={props.options.startupLabel || props.options.outputTokens != null}>
            <span aria-hidden="true">·</span>
          </Show>
          <openclaw-elapsed-time
            class="chat-working-indicator__elapsed"
            prop:startMs={props.part.startedAt}
          />
        </Show>
        <Show when={props.options.outputTokens == null && working()}>
          <openclaw-working-phrase
            aria-hidden="true"
            prop:startMs={props.part.startedAt}
            prop:seed={props.part.key}
            prop:phrases={props.options.workingPhrases ?? props.branding.workingPhrases}
          />
        </Show>
        <Show when={runningSubagents() > 0}>
          <span aria-hidden="true">·</span>
          <Show
            when={props.options.onOpenSubagents}
            fallback={<span class="chat-working-indicator__subagents">{runningLabel()}</span>}
          >
            <button
              class="chat-working-indicator__subagents"
              type="button"
              onClick={() => props.options.onOpenSubagents?.()}
            >
              {runningLabel()}
            </button>
          </Show>
        </Show>
      </span>
    </div>
  );
}

export function ChatWorkingIndicator(props: WorkingProps) {
  const branding = projectBranding();
  const working = () => !props.options.waitingApproval && !props.options.startupLabel;
  return (
    <Show
      when={props.options.waitingSubagents && props.options.subagentActivity !== undefined}
      fallback={
        <Show
          when={props.options.bubbleMode && working() && !(props.options.runningSubagents ?? 0)}
          fallback={
            <>
              <Show when={props.options.subagentActivity !== undefined}>
                <ChatSubagentActivity {...props.options.subagentActivity!} />
              </Show>
              <WorkingStatus {...props} branding={branding.read()} />
            </>
          }
        >
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
              <Show when={props.options.subagentActivity !== undefined}>
                <ChatSubagentActivity {...props.options.subagentActivity!} />
              </Show>
              <WorkingStatus {...props} branding={branding.read()} />
            </div>
          </details>
        </Show>
      }
    >
      <ChatSubagentActivity {...props.options.subagentActivity!} />
    </Show>
  );
}

export function TurnRecapRow(props: {
  recap: TurnRecap;
  presentation?: "standalone" | "continuation";
}) {
  const branding = projectBranding();
  const duration = () =>
    formatDurationLong(Math.max(1, Math.round(props.recap.runtimeMs / 1_000)) * 1_000) ?? "";
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
          <BrandGlyph branding={branding.read()} claw="claw" />
        </span>
      </Show>
      <Show when={typeof props.recap.outputTokens === "number"}>
        <span>{outputTokensLabel(props.recap.outputTokens!)}</span>{" "}
        <span class="chat-turn-recap__sep" aria-hidden="true">
          ·
        </span>{" "}
      </Show>
      <span>{t("chat.turnRecap.doneIn", { duration: duration() })}</span>
    </div>
  );
}
