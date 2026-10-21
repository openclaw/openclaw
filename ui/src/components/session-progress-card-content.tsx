import type { ProgressCard, ProgressCardStep, SessionRunStatus } from "@openclaw/gateway-protocol";
import { createMemo, createSignal, For, Show, useContext, type Accessor } from "solid-js";
import { formatRelativeTimestamp } from "../lib/format.ts";
import { t } from "../lib/reactive/i18n.ts";
import { createInterval } from "../lib/reactive/timers.ts";
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
  const [revision, setRevision] = createSignal(0);
  createInterval(
    () => setRevision((value) => value + 1),
    () => (presented() ? 30_000 : undefined),
  );
  const timestamp = () => props.view().activityTimestamp;
  const label = createMemo(() => {
    revision();
    presented();
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
