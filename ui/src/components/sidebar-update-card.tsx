import { Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
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
  getUpdateGitRevisions,
} from "../app/update-schedule-projection.ts";
import { registerSidebarAttentionEnglish } from "../i18n/locales/en-sidebar-attention.ts";
import { registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";
import { defineSolidBridge } from "../lit/solid-bridge.ts";
import "../styles/sidebar-update-card.css";
import { isUpdateRunAttentionVisible } from "./sidebar-attention-update.ts";
import { SidebarNotificationCard } from "./sidebar-notification-card.tsx";
import { Icon } from "./solid/icon.tsx";
import "./tooltip.ts";
import "../styles/update-git-revisions.css";

registerEnglishCatalog(registerSidebarAttentionEnglish);

export type SidebarUpdateCardProps = {
  compact: boolean;
  updateAvailable: UpdateAvailable | null;
  updateSchedule: UpdateScheduleState | null;
  heldUpdateCampaignId: string | null;
  updateBusy: boolean;
  updateRun: UpdateRunRecord | null;
  updateRunAcknowledged: boolean;
  connected: boolean;
  onCheckStatus?: () => Promise<boolean>;
  onAcknowledge?: () => void;
  statusBanner: ApplicationStatusBanner | null;
  watchUpdateProgress?: (listener: (progress: UpdateProgress) => void) => () => void;
  canUpdate: boolean;
  canHoldUpdate: boolean;
  onUpdate: () => void;
  refreshRequired: boolean;
  onRefresh: () => Promise<boolean>;
  onHoldUpdate: () => Promise<boolean>;
  onReviewUpdate: () => void;
  onDismiss?: () => void;
};

function SidebarUpdateCardContent(props: SidebarUpdateCardProps, host: HTMLElement) {
  host.style.display = "contents";
  const [holdingCampaignId, setHoldingCampaignId] = createSignal<string | null>(null);
  const [nativeUpdateAvailable, setNativeUpdateAvailable] = createSignal(hasNativeUpdateBridge());
  const [refreshState, setRefreshState] = createSignal(() => {
    // Re-entering recovery starts with a fresh retry surface.
    void props.refreshRequired;
    return { inFlight: false, failed: false };
  });
  const refreshInFlight = () => refreshState().inFlight;
  const refreshFailed = () => refreshState().failed;
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
      }
    },
  );
  createEffect(
    () => props.updateSchedule?.campaign?.state,
    (state) => {
      if (state !== "countdown" && state !== "waiting-for-idle") {
        return undefined;
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
    setRefreshState({ inFlight: true, failed: false });
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
      setRefreshState({ inFlight: false, failed: true });
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
            body={<CompactDetails />}
            bodyClass="sidebar-update-issue__body"
          />
        )}
      </Show>
    );
  }

  function CompactDetails() {
    const statusBanner = () => (props.updateRun ? null : props.statusBanner);
    return (
      <Show when={statusBanner()} fallback={<Card />}>
        {(banner) => (
          <div class="sidebar-update-card sidebar-update-card--compact-details">
            <p class="sidebar-update-card__compact-reason" title={banner().text}>
              {banner().text}
            </p>
            <div class="sidebar-update-card__compact-actions">
              <button
                class="sidebar-update-card__review sidebar-update-card__review--primary"
                type="button"
                onClick={props.onReviewUpdate}
              >
                {t("updates.reviewUpdate")}
              </button>
              <HoldUpdate />
            </div>
          </div>
        )}
      </Show>
    );
  }

  function HoldUpdate() {
    const campaign = createMemo(() => {
      const current = props.updateSchedule?.campaign;
      return current &&
        current.state !== "applying" &&
        props.canUpdate &&
        props.canHoldUpdate &&
        !props.updateBusy &&
        (current.holdUntilMs === undefined || current.holdUntilMs <= now()) &&
        props.heldUpdateCampaignId !== current.id
        ? current
        : null;
    });
    return (
      <Show when={campaign()}>
        {(current) => (
          <button
            class="sidebar-update-card__hold"
            type="button"
            disabled={holdingCampaignId() === current().id}
            onClick={() => void holdUpdate(current().id)}
          >
            {t("updates.holdOneHour")}
          </button>
        )}
      </Show>
    );
  }

  function RefreshCard() {
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
          onClick={() => void refreshControlUi()}
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

  function RecordedRunCard(current: { run: UpdateRunRecord }) {
    const view = createMemo(() => projectUpdateRun(current.run, props.connected));
    return (
      <div class="sidebar-update-card" role="status" aria-live="polite">
        <button class="sidebar-update-card__action" type="button" onClick={openRun}>
          <span class="sidebar-update-card__icon" aria-hidden="true">
            <Icon
              name={
                current.run.status === "running"
                  ? "refresh"
                  : current.run.status === "succeeded"
                    ? "check"
                    : "alertTriangle"
              }
            />
          </span>
          <span class="sidebar-update-card__text sidebar-update-card__text--stacked">
            <span class="sidebar-update-card__title">{view().headline}</span>
            {view().compactLabel ? (
              <span class="sidebar-update-card__subtitle">{view().compactLabel}</span>
            ) : null}
          </span>
        </button>
      </div>
    );
  }

  function AvailableCard() {
    const campaign = () => props.updateSchedule?.campaign;
    const busy = () => props.updateBusy || campaign()?.state === "applying";
    const statusBanner = () => (props.updateRun ? null : props.statusBanner);
    const actionable = () =>
      isUpdateActionable(props.updateAvailable, props.updateSchedule, busy());
    const countdownActive = () =>
      campaign()?.state === "countdown" || campaign()?.state === "waiting-for-idle";
    const text = createMemo(() => {
      const title = nativeUpdateAvailable()
        ? t("chat.sidebar.updateMacAndGateway")
        : t("chat.sidebar.updateGateway");
      const target = formatUpdateTargetLabel(props.updateSchedule, props.updateAvailable);
      const label = formatUpdateCampaignLabel(props.updateSchedule, now());
      return label
        ? target
          ? t("updates.sidebar.campaignTarget", { status: label, target })
          : label
        : busy()
          ? t("updates.sidebar.updating")
          : target
            ? `${title} · ${target}${props.updateAvailable?.channel === "beta" ? " (beta)" : ""}`
            : title;
    });
    function UpdateAction() {
      return (
        <button
          class={["sidebar-update-card__action", { "sidebar-update-card__action--busy": busy() }]}
          type="button"
          aria-disabled={props.canUpdate ? undefined : "true"}
          disabled={busy()}
          onClick={startUpdate}
        >
          <span class="sidebar-update-card__icon" aria-hidden="true">
            <Icon name={busy() ? "refresh" : "download"} />
          </span>
          <span
            class="sidebar-update-card__text"
            role={countdownActive() ? "timer" : undefined}
            aria-live={countdownActive() ? "off" : undefined}
          >
            {text()}
          </span>
        </button>
      );
    }
    // An outcome with nothing left to act on is the whole card.
    return (
      <Show when={Boolean(statusBanner() || actionable())}>
        <div
          class="sidebar-update-card"
          role={campaign() ? undefined : "status"}
          aria-live={campaign() ? undefined : "polite"}
        >
          {renderStatus()}
          <Show when={actionable()}>
            <div class="sidebar-update-card__actions">
              <Show
                when={props.canUpdate}
                fallback={
                  <openclaw-tooltip open-on-click prop:content={t("updates.adminRequired")}>
                    <UpdateAction />
                  </openclaw-tooltip>
                }
              >
                <UpdateAction />
              </Show>
              <HoldUpdate />
            </div>
          </Show>
          <Show when={statusBanner()}>
            <button
              class="sidebar-update-card__review"
              type="button"
              onClick={props.onReviewUpdate}
            >
              {t("updates.reviewUpdate")}
            </button>
          </Show>
          {actionable() && !busy()
            ? renderUpdateGitRevisions(props.updateSchedule, props.updateAvailable)
            : null}
        </div>
      </Show>
    );
  }

  function Card() {
    const run = createMemo(() =>
      isUpdateRunAttentionVisible(props.updateRun, props.updateRunAcknowledged)
        ? props.updateRun
        : null,
    );
    // Branch components retain their controls while the current run publishes progress.
    return (
      <Show
        when={props.refreshRequired}
        fallback={
          <Show when={run()} fallback={<AvailableCard />}>
            {(current) => <RecordedRunCard run={current()} />}
          </Show>
        }
      >
        <RefreshCard />
      </Show>
    );
  }

  return (
    <Show when={props.compact} fallback={<Card />}>
      <CompactCard />
    </Show>
  );
}

export const SidebarUpdateCard = defineSolidBridge<SidebarUpdateCardProps>(
  "openclaw-sidebar-update-card",
  SidebarUpdateCardContent,
  {
    properties: {
      compact: { default: false, attribute: false },
      updateAvailable: { default: null, attribute: false },
      updateSchedule: { default: null, attribute: false },
      heldUpdateCampaignId: { default: null, attribute: false },
      updateBusy: { default: false, attribute: false },
      updateRun: { default: null, attribute: false },
      updateRunAcknowledged: { default: false, attribute: false },
      connected: { default: true, attribute: false },
      onCheckStatus: { default: undefined, attribute: false },
      onAcknowledge: { default: undefined, attribute: false },
      statusBanner: { default: null, attribute: false },
      watchUpdateProgress: { default: undefined, attribute: false },
      canUpdate: { default: false, attribute: false },
      canHoldUpdate: { default: false, attribute: false },
      onUpdate: { default: () => undefined, attribute: false },
      refreshRequired: { default: false, attribute: false },
      onRefresh: { default: async () => false, attribute: false },
      onHoldUpdate: { default: async () => false, attribute: false },
      onReviewUpdate: { default: () => undefined, attribute: false },
      onDismiss: { default: undefined, attribute: false },
    },
  },
);

function renderUpdateGitRevisions(
  schedule: UpdateScheduleState | null | undefined,
  updateAvailable: UpdateAvailable | null | undefined,
) {
  const revisions = getUpdateGitRevisions(schedule, updateAvailable);
  if (!revisions) {
    return null;
  }
  return (
    <div class="update-git-revisions">
      <span class="update-git-revisions__range" dir="ltr">
        {revisions.currentSha ? (
          <>
            <code title={revisions.currentSha}>{revisions.currentSha.slice(0, 8)}</code>
            <span aria-hidden="true">→</span>
          </>
        ) : null}
        <code title={revisions.targetSha}>{revisions.targetSha.slice(0, 8)}</code>
      </span>
      {revisions.compareUrl ? (
        <a href={revisions.compareUrl} target="_blank" rel="noopener noreferrer">
          {t("updates.target.viewChanges")} <span aria-hidden="true">↗</span>
        </a>
      ) : null}
    </div>
  );
}
