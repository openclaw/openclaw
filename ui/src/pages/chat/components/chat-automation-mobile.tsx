import { createMemo, For, isPending, Loading } from "solid-js";
import { pathForRoute } from "../../../app-route-paths.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { PanelEmptyState } from "../../../components/solid/panel-empty-state.tsx";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { registerCronEnglish } from "../../../i18n/locales/en-cron.ts";
import { handleNavigationClick } from "../../../lib/navigation-click.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import {
  SessionAutomationRead,
  type SessionAutomationInventory,
} from "./chat-summary-automations.tsx";
import "../../../styles/chat/automation-mobile.css";
import "../../../styles/chat/summary-automations.css";
import { SessionAutomationResult } from "./session-automation-result.tsx";
import { sessionAutomationSchedule } from "./session-automation-schedule.ts";

registerEnglishCatalog(registerChatSessionEnglish);

registerEnglishCatalog(registerCronEnglish);

export type SessionAutomationMobileListProps = {
  inventory: SessionAutomationInventory;
  basePath: string;
  onOpenAutomation: (jobId: string) => void;
};
export function SessionAutomationMobileList(props: SessionAutomationMobileListProps) {
  const inventory = () => props.inventory;
  const errorNotice = () => (
    <div
      class={[
        "session-automation-mobile__message",
        { "session-automation-mobile__empty": inventory().jobs().length === 0 },
      ]}
      role="alert"
    >
      <span>
        {t(
          inventory().loaded()
            ? "chat.sessionDetails.automationUpdateError"
            : "chat.sessionDetails.automationError",
        )}
      </span>
      <button
        type="button"
        disabled={isPending(inventory().read) || !inventory().connected()}
        onClick={() => void inventory().refresh()}
      >
        {t("common.retry")}
      </button>
    </div>
  );
  const loadingNotice = () => (
    <p role="status" class="session-automation-mobile__empty">
      {t("chat.sessionDetails.automationLoading")}
    </p>
  );
  return (
    <Loading
      fallback={
        <div class="session-automation-mobile" aria-busy="true">
          {loadingNotice()}
        </div>
      }
    >
      <div
        class="session-automation-mobile"
        aria-busy={isPending(inventory().read) ? "true" : "false"}
      >
        {!inventory().connected() && (
          <p role="status" class="session-automation-mobile__note">
            {t("chat.sessionDetails.automationOffline")}
          </p>
        )}
        <SessionAutomationRead
          inventory={inventory()}
          loading={!inventory().loaded() && loadingNotice()}
          error={errorNotice()}
        />
        {!inventory().available() && (
          <p role="status" class="session-automation-mobile__empty">
            {t("chat.sessionDetails.automationUnavailable")}
          </p>
        )}
        {inventory().loaded() &&
          !inventory().error() &&
          !isPending(inventory().read) &&
          inventory().total() === 0 && (
            <PanelEmptyState
              presentation="mobile"
              icon={<Icon name="clock" />}
              heading={t("chat.sessionDetails.automationEmpty")}
              description={t("chat.sessionAutomation.emptyHint")}
            />
          )}
        <div class="session-automation-mobile__group">
          <For each={inventory().jobs()} keyed={(job) => job.id}>
            {(job) => {
              const schedule = createMemo(() => {
                const value = job().schedule;
                return value ? sessionAutomationSchedule(value) : "";
              });
              return (
                <a
                  class="session-automation-mobile__list-row"
                  href={`${pathForRoute("cron", props.basePath)}?${new URLSearchParams({ job: job().id })}`}
                  onClick={(event) =>
                    handleNavigationClick(event, () => props.onOpenAutomation(job().id))
                  }
                >
                  <span class="session-automation-mobile__list-icon">
                    <Icon name="clock" />
                    {job().autoDisabled ? (
                      <span class="chat-summary__automation-attention" />
                    ) : !job().enabled ? (
                      <span class="chat-summary__automation-paused">
                        <Icon name="pause" />
                      </span>
                    ) : undefined}
                  </span>
                  <span class="session-automation-mobile__list-copy">
                    <strong>{job().name || job().id}</strong>
                    <small>
                      {job().autoDisabled
                        ? t("chat.sessionDetails.automationAttention")
                        : !job().enabled
                          ? t("chat.sessionDetails.automationPaused")
                          : inventory().connected() && job().runningAtMs !== undefined
                            ? t("common.running")
                            : schedule()}
                    </small>
                    <SessionAutomationResult job={job()} />
                  </span>
                  <Icon name="chevronRight" />
                </a>
              );
            }}
          </For>
        </div>
        {inventory().hasMore() && (
          <button
            type="button"
            class="session-automation-mobile__more"
            disabled={
              isPending(inventory().read) || inventory().error() || !inventory().connected()
            }
            onClick={() => void inventory().loadMore()}
          >
            {t("chat.sessionDetails.automationMore")}
          </button>
        )}
      </div>
    </Loading>
  );
}
