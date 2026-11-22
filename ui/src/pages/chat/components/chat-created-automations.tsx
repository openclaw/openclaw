import { createMemo, createSignal, For, onSettled, Show } from "solid-js";
import { pathForRoute } from "../../../app-route-paths.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { Switch } from "../../../components/solid/switch.tsx";
import { registerChatSessionOptionalEnglish } from "../../../i18n/locales/en-chat-session-optional.ts";
import { registerCronEnglish } from "../../../i18n/locales/en-cron.ts";
import type { AutomationCreationCardPlan } from "../../../lib/chat/automation-creation-card.ts";
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

function LiveAutomation(props: { jobId: string; name: string }) {
  const app = useOptionalApplication();
  const [state, publish] = createSignal<CronJobObservation>({
    loading: Boolean(app),
    writable: false,
  });
  let watch: ReturnType<typeof watchCronJobDefinition> | undefined;
  onSettled(() => {
    if (app) {
      const observer = watchCronJobDefinition(app.gateway, props.jobId, publish);
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
  const search = () => `?${new URLSearchParams({ job: props.jobId, tab: "settings" })}`;
  return (
    <>
      <Show
        when={job()}
        fallback={
          <>
            <div class="chat-created-automations__copy" role="status">
              <strong>{props.name}</strong>
              <small>
                {t(
                  state().readFailure === "not-found"
                    ? "chat.sessionAutomation.removed"
                    : state().loading
                      ? "chat.sessionAutomation.created"
                      : "chat.sessionAutomation.unavailable",
                )}
              </small>
            </div>
            <span class="chat-created-automations__action">
              <Show when={state().readFailure === "retryable" && !state().loading}>
                <button
                  type="button"
                  class="chat-created-automations__retry"
                  aria-label={t("common.retry")}
                  title={t("common.retry")}
                  onClick={() => void watch?.retry()}
                >
                  <Icon name="refresh" />
                </button>
              </Show>
            </span>
          </>
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

export function ChatCreatedAutomations(props: { plan: AutomationCreationCardPlan }) {
  const single = () => !props.plan.grouped;
  return (
    <div
      class={["chat-created-automations", { "chat-created-automations--single": single() }]}
      role="group"
      aria-label={t("chat.sessionDetails.automations")}
    >
      <Show when={!single()}>
        <h3 class="chat-created-automations__heading">
          <ClockTile />
          {t("chat.sessionDetails.automations")}
        </h3>
      </Show>
      <ul class="chat-created-automations__rows" role="list">
        <For each={props.plan.rows} keyed={(row) => row.jobId}>
          {(row) => (
            <li
              class="chat-created-automations__row"
              data-slot-id={row().slotId}
              data-job-id={row().jobId}
            >
              <Show when={single()}>
                <ClockTile />
              </Show>
              <LiveAutomation jobId={row().jobId} name={row().name} />
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}
