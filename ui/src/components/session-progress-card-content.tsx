import type { ProgressCard, ProgressCardStep, SessionRunStatus } from "@openclaw/gateway-protocol";
import { createMemo, For, Show, useContext, type Accessor } from "solid-js";
import { formatUiExternalText } from "../lib/format-error.ts";
import { formatRelativeTimestamp } from "../lib/format.ts";
import { t } from "../lib/reactive/i18n.ts";
import { readVisibleTime } from "../lib/reactive/visible-clock.ts";
import type { SessionProgressCardRuntime } from "../lib/session-progress-runtime.ts";
import { ContentPresentation } from "../lib/solid/presentation.ts";
import {
  progressCardPresentation,
  STATUS_LABEL_KEYS,
  TERMINAL_RUN_OUTCOMES,
  type PresentedProgressStepStatus,
} from "./session-progress-card.ts";
import { Icon } from "./solid/icon.tsx";

export function CardActivity(props: {
  view: Accessor<ReturnType<typeof progressCardPresentation>>;
  composer?: boolean;
  hideCount?: boolean;
  hideTooltip?: boolean;
}) {
  const presented = useContext(ContentPresentation);
  const timestamp = () => props.view().activityTimestamp;
  const label = createMemo(() => {
    if (presented()) {
      readVisibleTime(30_000);
    }
    return t(props.view().activityKey, { time: formatRelativeTimestamp(timestamp()) });
  });
  const count = () => {
    const { counts, currentPosition } = props.view();
    return counts && !props.hideCount
      ? props.composer
        ? `${t("sessionProgressCard.stepCount", {
            current: String(currentPosition),
            total: String(counts.total),
          })} · `
        : ` · ${counts.completed}/${counts.total}`
      : "";
  };
  return (
    <span>
      {props.composer && count()}
      <time
        datetime={new Date(timestamp()).toISOString()}
        aria-label={label()}
        title={props.hideTooltip ? undefined : label()}
      >
        {label()}
      </time>
      {!props.composer && count()}
    </span>
  );
}

export function StepMarker(props: {
  status: PresentedProgressStepStatus;
  outcome?: ReturnType<typeof progressCardPresentation>["terminalOutcome"];
}) {
  return (
    <Show
      when={props.status === "in_progress" && !props.outcome}
      fallback={
        <Icon
          name={
            (props.outcome ?? props.status) === "completed"
              ? "check"
              : props.outcome
                ? "circleX"
                : props.status === "pending"
                  ? "circleDashed"
                  : "clock"
          }
        />
      }
    >
      <span class="session-run-spinner" />
    </Show>
  );
}

export function Steps(props: {
  card: ProgressCard;
  hasActiveRun: boolean;
  sessionStatus?: SessionRunStatus;
}) {
  return (
    <Show when={props.card.steps?.length}>
      <ol class="session-progress-card__steps">
        <For each={props.card.steps}>
          {(step) => (
            <Step
              step={step}
              hasActiveRun={props.hasActiveRun}
              sessionStatus={props.sessionStatus}
            />
          )}
        </For>
      </ol>
    </Show>
  );
}

function Step(props: {
  step: ProgressCardStep;
  hasActiveRun: boolean;
  sessionStatus?: SessionRunStatus;
}) {
  const terminalOutcome = () =>
    props.step.status === "in_progress" && props.sessionStatus
      ? TERMINAL_RUN_OUTCOMES[props.sessionStatus]
      : undefined;
  const status = (): PresentedProgressStepStatus =>
    props.step.status === "in_progress" && !props.hasActiveRun && !terminalOutcome()
      ? "paused"
      : props.step.status;
  const label = () =>
    t(
      terminalOutcome()
        ? `sessionProgressCard.status.${terminalOutcome()}`
        : status() === "paused"
          ? "sessionProgressCard.status.paused"
          : STATUS_LABEL_KEYS[props.step.status],
    );
  return (
    <li
      class={["session-progress-card__step", `session-progress-card__step--${status()}`]}
      aria-label={t("sessionProgressCard.stepLabel", { status: label(), step: props.step.step })}
    >
      <span
        class="session-progress-card__step-marker"
        data-status={status()}
        data-outcome={terminalOutcome() ? props.sessionStatus : undefined}
        aria-hidden="true"
      >
        <StepMarker status={status()} outcome={terminalOutcome()} />
      </span>
      <span class="session-progress-card__step-text">{props.step.step}</span>
    </li>
  );
}

export function ProgressRuntime(props: {
  runtime?: SessionProgressCardRuntime;
  hasActiveRun?: boolean;
  sessionStatus?: SessionRunStatus;
  terminalOutcome?: "failed" | "stopped";
}) {
  const unavailable = () => props.runtime?.connected === false || props.runtime?.known === false;
  const label = createMemo(() => {
    const runtime = props.runtime;
    if (!runtime) {
      return "";
    }
    if (runtime.connected === false) {
      return t("sessionProgressCard.runtime.offline");
    }
    if (runtime.known === false) {
      return t("sessionProgressCard.runtime.unknown");
    }
    const parts = runtime.children
      ? (["running", "queued", "waiting", "failed", "stopped"] as const).flatMap((state) =>
          runtime.children?.[state]
            ? [
                t(`sessionProgressCard.runtime.${state}`, {
                  count: String(runtime.children[state]),
                }),
              ]
            : [],
        )
      : [];
    if (parts.length) {
      return [
        props.terminalOutcome ? t(`sessionProgressCard.outcome.${props.terminalOutcome}`) : "",
        t("sessionProgressCard.runtime.children", { activity: parts.join(" · ") }),
      ]
        .filter(Boolean)
        .join(" · ");
    }
    if (runtime.hasActiveSubagentRun) {
      return t("sessionProgressCard.runtime.delegated");
    }
    if (props.terminalOutcome) {
      return t(`sessionProgressCard.outcome.${props.terminalOutcome}`);
    }
    if (props.sessionStatus === "queued") {
      return t("sessionProgressCard.runtime.queuedSelf");
    }
    return t(
      props.hasActiveRun && props.sessionStatus !== "done"
        ? "sessionProgressCard.runtime.working"
        : "sessionProgressCard.runtime.idle",
    );
  });
  const detail = () =>
    unavailable()
      ? ""
      : formatUiExternalText(
          props.terminalOutcome === "failed"
            ? props.runtime?.lastRunError
            : props.runtime?.children?.failed
              ? props.runtime.childError
              : undefined,
        ).slice(0, 240);
  return (
    <Show when={props.runtime}>
      <span
        class="session-progress-card__runtime"
        role="status"
        data-error={String(
          !unavailable() &&
            (props.terminalOutcome === "failed" || Boolean(props.runtime?.children?.failed)),
        )}
      >
        <span>{label()}</span>
        <Show when={detail()}>
          {(value) => <span class="session-progress-card__runtime-detail">{value()}</span>}
        </Show>
      </span>
    </Show>
  );
}
