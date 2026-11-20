import { createMemo, createSignal, For, onSettled, Show } from "solid-js";
import type { AutomationSavedDefinition } from "../../../../../src/shared/automation-saved-definition.js";
import { pathForRoute } from "../../../app-route-paths.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { Switch } from "../../../components/solid/switch.tsx";
import { registerChatSessionOptionalEnglish } from "../../../i18n/locales/en-chat-session-optional.ts";
import { registerCronEnglish } from "../../../i18n/locales/en-cron.ts";
import type {
  AutomationCreationCardPlan,
  AutomationCreationRow,
} from "../../../lib/chat/automation-creation-card.ts";
import {
  watchCronJobDefinition,
  type CronJobObservation,
} from "../../../lib/cron/watch-job-definition.ts";
import { handleNavigationClick } from "../../../lib/navigation-click.ts";
import { useOptionalApplication } from "../../../lib/reactive/context.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { sessionAutomationSchedule } from "./session-automation-schedule.ts";
import "../../../styles/chat/created-automations.css";

registerEnglishCatalog(registerChatSessionOptionalEnglish);
registerEnglishCatalog(registerCronEnglish);

function ClockTile() {
  return (
    <span class="chat-created-automations__clock" aria-hidden="true">
      <Icon name="clock" />
    </span>
  );
}

function SlotStatus(props: {
  name: string;
  phase: "pending" | "failed" | "loading" | "unavailable";
  retry?: () => void;
}) {
  const waiting = () => props.phase === "pending" || props.phase === "loading";
  return (
    <>
      <div class="chat-created-automations__copy" role="status">
        <strong>{props.name}</strong>
        <Show
          when={waiting()}
          fallback={
            <small class={{ "chat-created-automations__failed": props.phase === "failed" }}>
              {t(
                props.phase === "failed"
                  ? "chat.sessionAutomation.notCreated"
                  : "chat.sessionAutomation.unavailable",
              )}
            </small>
          }
        >
          <span class="chat-created-automations__schedule-placeholder" aria-hidden="true" />
          <span class="sr-only">
            {t(
              props.phase === "pending"
                ? "chat.sessionAutomation.creating"
                : "chat.sessionDetails.automationLoading",
            )}
          </span>
        </Show>
      </div>
      <span class="chat-created-automations__action">
        {waiting() && (
          <span class="chat-created-automations__switch-placeholder" aria-hidden="true" />
        )}
        {props.phase === "failed" && (
          <Icon name="alertTriangle" class="chat-created-automations__failed" />
        )}
        {props.retry && (
          <button
            type="button"
            class="chat-created-automations__retry"
            aria-label={t("common.retry")}
            title={t("common.retry")}
            onClick={() => props.retry?.()}
          >
            <Icon name="refresh" />
          </button>
        )}
      </span>
    </>
  );
}

/** Only a confirmed job ID mounts a scheduler observer; a plan name is never a write target. */
type ConfirmedJob = { id: string; initial?: AutomationSavedDefinition };
function LiveAutomation(props: { job: ConfirmedJob; name: string }) {
  const app = useOptionalApplication();
  const [state, publish] = createSignal<CronJobObservation>({
    loading: Boolean(app),
    writable: false,
  });
  let watch: ReturnType<typeof watchCronJobDefinition> | undefined;
  onSettled(() => {
    if (app) {
      const observer = watchCronJobDefinition(
        app.gateway,
        props.job.id,
        publish,
        props.job.initial,
      );
      watch = observer;
      return () => observer.dispose();
    }
    return undefined;
  });
  const job = createMemo(() => state().job);
  const name = () => job()?.displayName ?? job()?.name ?? props.name;
  const schedule = createMemo(() => {
    const value = job()?.schedule;
    if (!value) {
      return "";
    }
    const label = sessionAutomationSchedule(value);
    return value.kind === "cron" && value.tz
      ? t("cron.scheduleLabel.withTimeZone", { value: label, timeZone: value.tz })
      : label;
  });
  const search = () => `?${new URLSearchParams({ job: props.job.id, tab: "settings" })}`;
  return (
    <>
      <Show
        when={job()}
        fallback={
          <SlotStatus
            name={props.name}
            phase={state().loading ? "loading" : "unavailable"}
            retry={state().retryable && !state().loading ? () => void watch?.retry() : undefined}
          />
        }
      >
        {(loaded) => (
          <>
            <a
              class="chat-created-automations__copy chat-created-automations__link"
              href={pathForRoute("cron", app?.basePath ?? "") + search()}
              onClick={(event) =>
                app &&
                handleNavigationClick(event, () => app.navigate("cron", { search: search() }))
              }
            >
              <strong>{name()}</strong>
              <small>{schedule()}</small>
            </a>
            <span class="chat-created-automations__action">
              <Switch
                size="sm"
                checked={state().saving ?? loaded().enabled}
                disabled={!state().writable && state().saving === undefined}
                saving={state().saving !== undefined}
                ariaLabel={t(
                  loaded().enabled ? "cron.actions.pauseJob" : "cron.actions.resumeJob",
                  { name: name() },
                )}
                onChange={(enabled) => watch?.setEnabled(enabled) ?? false}
              />
            </span>
          </>
        )}
      </Show>
      {state().error && (
        <small class="chat-created-automations__error" role="alert">
          {state().error}
        </small>
      )}
    </>
  );
}

function AutomationRow(props: { row: AutomationCreationRow; single: boolean }) {
  // A receipt seeds only the observer for a transition this mounted slot saw.
  // Retain that identity through unrelated plan updates; a remount starts without it.
  const binding = createMemo<ConfirmedJob | "pending" | undefined>((previous) => {
    const row = props.row;
    if (row.status !== "created") {
      return row.status === "pending" || previous === "pending" ? "pending" : undefined;
    }
    if (previous && previous !== "pending" && previous.id === row.jobId) {
      return previous;
    }
    return { id: row.jobId, initial: previous === "pending" ? row.definition : undefined };
  });
  const confirmed = () => {
    const value = binding();
    return value === "pending" ? undefined : value;
  };
  return (
    <li
      class="chat-created-automations__row"
      data-slot-id={props.row.slotId}
      data-job-id={confirmed()?.id}
    >
      {props.single && <ClockTile />}
      <Show
        when={confirmed()}
        keyed
        fallback={
          <SlotStatus
            name={props.row.name}
            phase={props.row.status === "failed" ? "failed" : "pending"}
          />
        }
      >
        {(job) => <LiveAutomation job={job} name={props.row.name} />}
      </Show>
    </li>
  );
}

export function ChatCreatedAutomations(props: { plan: AutomationCreationCardPlan }) {
  const single = () => props.plan.rows.length === 1;
  return (
    <Show when={props.plan.rows.length}>
      <div
        class={["chat-created-automations", { "chat-created-automations--single": single() }]}
        role="group"
        aria-label={t("chat.sessionDetails.automations")}
      >
        {!single() && (
          <h3 class="chat-created-automations__heading">
            <ClockTile />
            {t("chat.sessionDetails.automations")}
          </h3>
        )}
        <ul class="chat-created-automations__rows" role="list">
          <For each={props.plan.rows} keyed={(row) => row.slotId}>
            {(row) => <AutomationRow row={row()} single={single()} />}
          </For>
        </ul>
      </div>
    </Show>
  );
}
