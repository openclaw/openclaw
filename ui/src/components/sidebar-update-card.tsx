import { Show, createEffect, createMemo, createSignal, merge, onCleanup } from "solid-js";
import type { UpdateRunRecord } from "../../../src/infra/update-run-record.ts";
import type { UpdateAvailable, UpdateScheduleState } from "../api/types.ts";
import {
  hasNativeUpdateBridge,
  NATIVE_UPDATE_AVAILABILITY_CHANGED_EVENT,
} from "../app/native-link-routing.ts";
import { confirmAndStartUpdate, type UpdateProgress } from "../app/update-confirmation.ts";
import type { ApplicationStatusBanner } from "../app/update-overlay-helpers.ts";
import { projectUpdateRun } from "../app/update-run-projection.ts";
import {
  formatUpdateCampaignLabel,
  formatUpdateTargetLabel,
  isUpdateActionable,
} from "../app/update-schedule-projection.ts";
import { t } from "../i18n/index.ts";
import { registerSidebarAttentionEnglish } from "../i18n/locales/en-sidebar-attention.ts";
import "../styles/sidebar-update-card.css";
import { isUpdateRunAttentionVisible } from "./sidebar-attention-update.ts";
import { SidebarNotificationCard } from "./sidebar-notification-card.tsx";
import { Icon } from "./solid/icon.tsx";
import "./tooltip.ts";
import { renderUpdateGitRevisions } from "./solid/update-git-revisions.tsx";

registerSidebarAttentionEnglish();

export type SidebarUpdateCardProps = {
  compact?: boolean;
  updateAvailable?: UpdateAvailable | null;
  updateSchedule?: UpdateScheduleState | null;
  heldUpdateCampaignId?: string | null;
  updateBusy?: boolean;
  updateRun?: UpdateRunRecord | null;
  updateRunAcknowledged?: boolean;
  connected?: boolean;
  onCheckStatus?: () => Promise<boolean>;
  onAcknowledge?: () => void;
  statusBanner?: ApplicationStatusBanner | null;
  watchUpdateProgress?: (listener: (progress: UpdateProgress) => void) => () => void;
  canUpdate?: boolean;
  canHoldUpdate?: boolean;
  onUpdate?: () => void;
  refreshRequired?: boolean;
  onRefresh?: () => Promise<boolean>;
  onHoldUpdate?: () => Promise<boolean>;
  onReviewUpdate?: () => void;
  onDismiss?: () => void;
};

export function SidebarUpdateCard(input: SidebarUpdateCardProps) {
  const props = merge(
    {
      compact: false,
      updateAvailable: null,
      updateSchedule: null,
      heldUpdateCampaignId: null,
      updateBusy: false,
      updateRun: null,
      updateRunAcknowledged: false,
      connected: true,
      statusBanner: null,
      canUpdate: false,
      canHoldUpdate: false,
      onUpdate: () => undefined,
      refreshRequired: false,
      onRefresh: async () => false,
      onHoldUpdate: async () => false,
      onReviewUpdate: () => undefined,
    },
    input,
  );
  const [holdingCampaignId, setHoldingCampaignId] = createSignal<string | null>(null);
  const [nativeUpdateAvailable, setNativeUpdateAvailable] = createSignal(hasNativeUpdateBridge());
  const [refreshInFlight, setRefreshInFlight] = createSignal(false);
  const [refreshFailed, setRefreshFailed] = createSignal(false);
  const [now, setNow] = createSignal(Date.now());
  let refreshAttempt = 0;
  let refreshPending = false;
  const updateNativeAvailability = () => setNativeUpdateAvailable(hasNativeUpdateBridge());
  window.addEventListener(NATIVE_UPDATE_AVAILABILITY_CHANGED_EVENT, updateNativeAvailability);
  onCleanup(() =>
    window.removeEventListener(NATIVE_UPDATE_AVAILABILITY_CHANGED_EVENT, updateNativeAvailability),
  );
  createEffect(
    () => props.refreshRequired,
    (required) => {
      if (!required) {
        refreshAttempt++;
        refreshPending = false;
        setRefreshInFlight(false);
        setRefreshFailed(false);
      }
    },
  );
  createEffect(
    () => props.updateSchedule?.campaign?.state,
    (state) => {
      if (state !== "countdown" && state !== "waiting-for-idle") {
        return;
      }
      const timer = setInterval(() => setNow(Date.now()), 1000);
      return () => clearInterval(timer);
    },
  );
  function renderStatus() {
    const statusBanner = props.updateRun ? null : props.statusBanner;
    // The Gateway recorded this outcome; unlike the client's own update
    // metadata it stays true even when this client is stale.
    return statusBanner ? (
      <div
        class={`sidebar-update-card__status sidebar-update-card__status--${statusBanner.tone}`}
        role="alert"
      >
        {statusBanner.text}
      </div>
    ) : null;
  }

  const openRun = () => {
    if (!props.updateRun) {
      return;
    }
    confirmUpdate(props.updateRun);
  };

  const startUpdate = () => {
    const campaign = props.updateSchedule?.campaign;
    const busy = props.updateBusy || campaign?.state === "applying";
    if (busy || !props.canUpdate) {
      return;
    }
    confirmUpdate();
  };

  function confirmUpdate(existingRun?: UpdateRunRecord) {
    void confirmAndStartUpdate({
      existingRun,
      startGatewayUpdate: () => props.onUpdate(),
      onCheckStatus: props.onCheckStatus,
      onReviewUpdate: props.onReviewUpdate,
      onAcknowledge: props.onAcknowledge,
      watchUpdateProgress: props.watchUpdateProgress,
      updateAvailable: props.updateAvailable,
      updateSchedule: props.updateSchedule,
      // Read the bridge at click time: a Mac app that installed it
      // after the last availability event still owns this update.
      viaNativeApp: hasNativeUpdateBridge(),
    });
  }

  const holdUpdate = async (campaignId: string) => {
    setHoldingCampaignId(campaignId);
    await props.onHoldUpdate();
    setHoldingCampaignId(null);
  };

  const refreshControlUi = async () => {
    if (refreshPending) {
      return;
    }
    refreshPending = true;
    setRefreshInFlight(true);
    setRefreshFailed(false);
    const attempt = ++refreshAttempt;
    let reloading = false;
    try {
      reloading = await props.onRefresh();
    } catch {
      // The current document remains the recovery surface when its probe fails.
    }
    if (attempt !== refreshAttempt || !props.refreshRequired) {
      return;
    }
    if (!reloading) {
      refreshPending = false;
      setRefreshInFlight(false);
      setRefreshFailed(true);
    }
  };

  function compactSummary() {
    if (props.refreshRequired) {
      return {
        timestampMs: undefined,
        critical: false,
        detail: t("chat.sidebar.serverUpdatedRefresh"),
        icon: <Icon name="refresh" />,
        severity: "warning" as const,
        title: t("chat.sidebar.serverUpdatedTitle"),
      };
    }
    if (
      isUpdateRunAttentionVisible(props.updateRun, props.updateRunAcknowledged) &&
      props.updateRun
    ) {
      const view = projectUpdateRun(props.updateRun, props.connected);
      return {
        title: view.headline,
        detail: view.compactLabel,
        timestampMs:
          props.updateRun.status === "running"
            ? props.updateRun.createdAtMs
            : props.updateRun.finishedAtMs,
        icon: (
          <Icon
            name={
              props.updateRun.status === "running"
                ? "refresh"
                : props.updateRun.status === "succeeded"
                  ? "check"
                  : "alertTriangle"
            }
          />
        ),
        severity: props.updateRun.status === "failed" ? ("error" as const) : ("warning" as const),
        critical: false,
      };
    }
    const campaign = props.updateSchedule?.campaign;
    const busy = props.updateBusy || campaign?.state === "applying";
    const statusBanner = props.updateRun ? null : props.statusBanner;
    if (!statusBanner && !isUpdateActionable(props.updateAvailable, props.updateSchedule, busy)) {
      return null;
    }
    const targetLabel = formatUpdateTargetLabel(props.updateSchedule, props.updateAvailable);
    const campaignLabel = formatUpdateCampaignLabel(props.updateSchedule, now());
    const blocked = statusBanner && statusBanner.tone !== "info";
    const blockedReason = statusBanner?.text.trim() || t("updates.sidebar.blockedSummary");
    return {
      timestampMs: campaign?.announcedAtMs,
      detail: blocked
        ? campaign?.state === "waiting-for-idle" && targetLabel
          ? t("updates.sidebar.blockedWaiting", { target: targetLabel })
          : targetLabel
            ? `${targetLabel} · ${blockedReason}`
            : blockedReason
        : campaignLabel && targetLabel
          ? t("updates.sidebar.campaignTarget", { status: campaignLabel, target: targetLabel })
          : (campaignLabel ??
            targetLabel ??
            statusBanner?.text ??
            t("updates.sidebar.availableSummary")),
      icon: <Icon name={statusBanner ? "alertTriangle" : busy ? "refresh" : "download"} />,
      critical: Boolean(blocked),
      severity: statusBanner?.tone === "danger" ? ("error" as const) : ("warning" as const),
      title: blocked
        ? t("updates.sidebar.blockedTitle")
        : busy
          ? t("updates.sidebar.updating")
          : t("updates.sidebar.availableTitle"),
    };
  }

  function CompactCard() {
    const summary = createMemo(compactSummary);
    return (
      <Show when={summary()}>
        {(current) => (
          <SidebarNotificationCard
            title={current().title}
            detail={current().detail}
            timestampMs={current().timestampMs}
            icon={current().icon}
            severity={current().severity}
            critical={current().critical}
            onDismiss={props.onDismiss}
            body={<>{renderCompactDetails()}</>}
            bodyClass="sidebar-update-issue__body"
          />
        )}
      </Show>
    );
  }

  function renderCompactDetails() {
    const statusBanner = props.updateRun ? null : props.statusBanner;
    if (!statusBanner) {
      return renderCard();
    }
    return (
      <div class="sidebar-update-card sidebar-update-card--compact-details">
        <p class="sidebar-update-card__compact-reason" title={statusBanner.text}>
          {statusBanner.text}
        </p>
        <div class="sidebar-update-card__compact-actions">
          <button
            class="sidebar-update-card__review sidebar-update-card__review--primary"
            type="button"
            onClick={props.onReviewUpdate}
          >
            {t("updates.reviewUpdate")}
          </button>
          {renderHoldUpdate()}
        </div>
      </div>
    );
  }

  function renderHoldUpdate() {
    const campaign = props.updateSchedule?.campaign;
    if (
      !campaign ||
      campaign.state === "applying" ||
      !props.canUpdate ||
      !props.canHoldUpdate ||
      props.updateBusy ||
      (campaign.holdUntilMs !== undefined && campaign.holdUntilMs > now()) ||
      props.heldUpdateCampaignId === campaign.id
    ) {
      return null;
    }
    return (
      <button
        class="sidebar-update-card__hold"
        type="button"
        disabled={holdingCampaignId() === campaign.id}
        onClick={() => holdUpdate(campaign.id)}
      >
        {t("updates.holdOneHour")}
      </button>
    );
  }

  function renderCard() {
    // A stale client cannot trust its own update metadata, so refresh takes precedence
    // over any available update it may still report.
    if (props.refreshRequired) {
      return (
        <div class="sidebar-update-card" role="status" aria-live="polite">
          {renderStatus()}
          {refreshFailed() ? (
            <div class="sidebar-update-card__status sidebar-update-card__status--warn" role="alert">
              {t("connection.actionsUnavailable")}
            </div>
          ) : null}
          <button
            class={[
              "sidebar-update-card__action",
              { "sidebar-update-card__action--busy": refreshInFlight() },
            ]}
            type="button"
            disabled={refreshInFlight()}
            aria-busy={refreshInFlight() ? "true" : "false"}
            onClick={refreshControlUi}
          >
            <span class="sidebar-update-card__icon" aria-hidden="true">
              <Icon name="refresh" />
            </span>
            <span class="sidebar-update-card__text sidebar-update-card__text--stacked">
              <span class="sidebar-update-card__title">{t("chat.sidebar.serverUpdatedTitle")}</span>
              <span class="sidebar-update-card__subtitle">
                {refreshInFlight()
                  ? t("lazyView.reloading")
                  : refreshFailed()
                    ? t("connection.retryNow")
                    : t("chat.sidebar.serverUpdatedRefresh")}
              </span>
            </span>
          </button>
        </div>
      );
    }
    if (
      isUpdateRunAttentionVisible(props.updateRun, props.updateRunAcknowledged) &&
      props.updateRun
    ) {
      const view = projectUpdateRun(props.updateRun, props.connected);
      return (
        <div class="sidebar-update-card" role="status" aria-live="polite">
          <button class="sidebar-update-card__action" type="button" onClick={openRun}>
            <span class="sidebar-update-card__icon" aria-hidden="true">
              <Icon
                name={
                  props.updateRun.status === "running"
                    ? "refresh"
                    : props.updateRun.status === "succeeded"
                      ? "check"
                      : "alertTriangle"
                }
              />
            </span>
            <span class="sidebar-update-card__text sidebar-update-card__text--stacked">
              <span class="sidebar-update-card__title">{view.headline}</span>
              {view.compactLabel ? (
                <span class="sidebar-update-card__subtitle">{view.compactLabel}</span>
              ) : null}
            </span>
          </button>
        </div>
      );
    }
    const update = props.updateAvailable;
    const campaign = props.updateSchedule?.campaign;
    const busy = props.updateBusy || campaign?.state === "applying";
    // A running update outranks availability: the gateway drops its update
    // metadata while it restarts, and the card must not vanish or fall back to
    // the stale "update available" call to action mid-install.
    const statusBanner = props.updateRun ? null : props.statusBanner;
    const actionable = isUpdateActionable(update, props.updateSchedule, busy);
    if (!statusBanner && !actionable) {
      return null;
    }
    const title = nativeUpdateAvailable()
      ? t("chat.sidebar.updateMacAndGateway")
      : t("chat.sidebar.updateGateway");
    const betaChannelSuffix = update?.channel === "beta" ? " (beta)" : "";
    const targetLabel = formatUpdateTargetLabel(props.updateSchedule, update);
    const text = () => {
      const campaignLabel = formatUpdateCampaignLabel(props.updateSchedule, now());
      return campaignLabel
        ? targetLabel
          ? t("updates.sidebar.campaignTarget", { status: campaignLabel, target: targetLabel })
          : campaignLabel
        : busy
          ? t("updates.sidebar.updating")
          : targetLabel
            ? `${title} · ${targetLabel}${betaChannelSuffix}`
            : title;
    };
    const countdownActive =
      campaign?.state === "countdown" || campaign?.state === "waiting-for-idle";
    // An outcome with nothing left to act on is the whole card: re-offering an
    // update the operator just ran would bury the reason it failed.
    const updateAction = (
      <button
        class={["sidebar-update-card__action", { "sidebar-update-card__action--busy": busy }]}
        type="button"
        aria-disabled={props.canUpdate ? null : "true"}
        disabled={busy}
        onClick={startUpdate}
      >
        <span class="sidebar-update-card__icon" aria-hidden="true">
          <Icon name={busy ? "refresh" : "download"} />
        </span>
        <span
          class="sidebar-update-card__text"
          role={countdownActive ? "timer" : null}
          aria-live={countdownActive ? "off" : null}
        >
          {text()}
        </span>
      </button>
    );
    return (
      <div
        class="sidebar-update-card"
        role={campaign ? null : "status"}
        aria-live={campaign ? null : "polite"}
      >
        {renderStatus()}
        {actionable ? (
          <div class="sidebar-update-card__actions">
            {props.canUpdate ? (
              updateAction
            ) : (
              <openclaw-tooltip open-on-click prop:content={t("updates.adminRequired")}>
                {updateAction}
              </openclaw-tooltip>
            )}
            {renderHoldUpdate()}
          </div>
        ) : null}
        {statusBanner ? (
          <button class="sidebar-update-card__review" type="button" onClick={props.onReviewUpdate}>
            {t("updates.reviewUpdate")}
          </button>
        ) : null}
        {actionable && !busy
          ? renderUpdateGitRevisions(props.updateSchedule, props.updateAvailable)
          : null}
      </div>
    );
  }

  return (
    <Show when={props.compact} fallback={<>{renderCard()}</>}>
      <CompactCard />
    </Show>
  );
}
