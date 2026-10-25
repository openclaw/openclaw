import { onSettled, Show } from "solid-js";
import type {
  ThemeBranding,
  ThemeMascot,
  ThemeWorkingIndicator,
} from "../../../../../packages/gateway-protocol/src/theme.ts";
import { currentThemeBranding, subscribeThemeBranding } from "../../../app/theme-branding.ts";
import { ElapsedTime } from "../../../components/elapsed-time.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import { ThemeBrandIcon } from "../../../components/theme-brand-icon.tsx";
import "../../../components/working-phrase-solid.tsx";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import type { ChatItem } from "../../../lib/chat/chat-types.ts";
import { formatDurationLong } from "../../../lib/format-duration.ts";
import { formatCompactTokenCount } from "../../../lib/format.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { projectSource } from "../../../lib/reactive/projection.ts";
import type { TurnRecap } from "../chat-progress.ts";
import type { ChatSubagentWait } from "../chat-subagent-wait.ts";
import { ChatRetryStatus } from "./chat-retry-status.tsx";
import { selectWorkingClawSurprise } from "./chat-working-indicator-surprise.ts";

registerEnglishCatalog(registerChatSessionEnglish);

type ReadingIndicator = Extract<ChatItem, { kind: "reading-indicator" }>;
type ChatWorkingIndicatorOptions = {
  bubbleMode?: boolean;
  bubbleActivityActive?: boolean;
  mascot?: ThemeMascot;
  workingIndicator?: ThemeWorkingIndicator;
  workingPhrases?: readonly string[];
  waitingApproval?: boolean;
  waitingSubagents?: ChatSubagentWait;
  runningSubagents?: number;
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

// The New Session preview hands its claw to Chat, and keyed rerenders replace
// it in place. A claw that mounts right after another retired continues that
// work instead of popping in again.
const CONTINUED_CLAW_WINDOW_MS = 400;
let clawRetiredAt = Number.NEGATIVE_INFINITY;

function WorkingStatus(props: WorkingProps & { branding: ThemeBranding }) {
  const continued = performance.now() - clawRetiredAt < CONTINUED_CLAW_WINDOW_MS;
  onSettled(() => () => {
    clawRetiredAt = performance.now();
  });
  const waitingApproval = () => props.options.waitingApproval === true;
  const waitingSubagents = () => (props.options.waitingSubagents?.runningCount ?? 0) > 0;
  const working = () => !waitingApproval() && !waitingSubagents() && !props.options.startupLabel;
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
      : waitingSubagents()
        ? t("chat.waitingOnSubagents")
        : props.options.startupLabel || t("common.working");
  return (
    <div
      class={[
        "chat-working-indicator",
        {
          "chat-working-indicator--continued": continued,
          "chat-working-indicator--continuation": continuation(),
        },
      ]}
      role="status"
      aria-live="off"
    >
      <Show
        when={
          !props.options.bubbleMode &&
          !continuation() &&
          !waitingSubagents() &&
          indicator() !== "none"
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
        <span
          class={{
            "sr-only":
              waitingSubagents() || (working() && !continuation() && indicator() !== "none"),
          }}
        >
          <Show
            when={!waitingApproval() && props.options.retryAt !== undefined}
            fallback={statusLabel()}
          >
            <ChatRetryStatus retryAt={props.options.retryAt ?? null} />
          </Show>
        </span>
        <Show
          when={props.options.outputTokens !== null && props.options.outputTokens !== undefined}
        >
          <Show
            when={(!working() && !waitingSubagents()) || continuation() || indicator() === "none"}
          >
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
          <ElapsedTime
            class="chat-working-indicator__elapsed"
            startMs={props.options.waitingSubagents?.startedAt ?? props.part.startedAt}
          />
        </Show>
        <Show when={props.options.outputTokens == null && working() && !props.options.bubbleMode}>
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
  const attention = () => props.options.waitingApproval || props.options.retryAt !== undefined;
  return (
    <Show
      when={props.options.bubbleMode && !props.options.waitingSubagents?.runningCount}
      fallback={<WorkingStatus {...props} branding={branding.read()} />}
    >
      <Show when={!props.options.bubbleActivityActive}>
        <details class="chat-bubble-activity chat-bubble-activity--working">
          <summary
            class="chat-bubble-activity__summary"
            aria-label={
              props.options.waitingApproval
                ? t("chat.waitingForApproval")
                : t("chat.view.workingDetails")
            }
            title={t("chat.view.activityDetails")}
          >
            <Show when={!attention()}>
              <span class="chat-bubble-dots chat-bubble-dots--working" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
            </Show>
            <Show when={attention()}>
              <span class="chat-activity-group__label chat-activity-group__label--live">
                <Show
                  when={props.options.waitingApproval}
                  fallback={<ChatRetryStatus retryAt={props.options.retryAt ?? null} />}
                >
                  {t("chat.waitingForApproval")}
                </Show>
              </span>
            </Show>
          </summary>
          <div class="chat-bubble-activity__details">
            <WorkingStatus {...props} branding={branding.read()} />
          </div>
        </details>
      </Show>
    </Show>
  );
}

export function TurnRecapRow(props: {
  recap: TurnRecap;
  hideDuration?: boolean;
  presentation?: "standalone" | "continuation";
}) {
  const branding = projectBranding();
  const duration = () =>
    formatDurationLong(Math.max(1, Math.round(props.recap.runtimeMs / 1_000)) * 1_000) ?? "";
  return (
    <Show when={!props.hideDuration || typeof props.recap.outputTokens === "number"}>
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
          <span>{outputTokensLabel(props.recap.outputTokens!)}</span>
          <Show when={!props.hideDuration}>
            <span class="chat-turn-recap__sep" aria-hidden="true">
              ·
            </span>
          </Show>
        </Show>
        <Show when={!props.hideDuration}>
          <span>{t("chat.turnRecap.doneIn", { duration: duration() })}</span>
        </Show>
      </div>
    </Show>
  );
}
