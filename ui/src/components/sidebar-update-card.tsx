import type { JSX } from "@solidjs/web";
import {
  Show,
  action,
  createMemo,
  createOptimistic,
  createSignal,
  Errored,
  flush,
  latest,
  onSettled,
} from "solid-js";
import type { UpdateRunRecord } from "../../../src/infra/update-run-record.ts";
import type { UpdateAvailable, UpdateScheduleState } from "../api/types.ts";
import {
  hasNativeUpdateBridge,
  NATIVE_UPDATE_AVAILABILITY_CHANGED_EVENT,
} from "../app/native-link-routing.ts";
import {
  confirmAndStartUpdate,
  type ConfirmAndStartUpdateParams,
  type UpdateProgress,
} from "../app/update-confirmation.ts";
import type { ApplicationStatusBanner } from "../app/update-overlay-helpers.ts";
import { projectUpdateRun } from "../app/update-run-projection.ts";
import {
  formatUpdateCampaignLabel,
  formatUpdateTargetLabel,
  isUpdateActionable,
} from "../app/update-schedule-projection.ts";
import { registerSidebarAttentionEnglish } from "../i18n/locales/en-sidebar-attention.ts";
import { registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";
import { listen } from "../lib/reactive/listener.ts";
import { createInterval } from "../lib/reactive/timers.ts";
import "../styles/sidebar-update-card.css";
import { sidebarAttentionFocusRef } from "./sidebar-attention-focus.ts";
import { isUpdateRunAttentionVisible } from "./sidebar-attention-update.ts";
import { SidebarNotificationCard } from "./sidebar-notification-card.tsx";
import { Icon } from "./solid/icon.tsx";
import { UpdateGitRevisions } from "./solid/update-git-revisions.tsx";
import "./tooltip.ts";

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
  prepareRetry?: ConfirmAndStartUpdateParams["prepareRetry"];
  onAcknowledge?: () => void;
  statusBanner: ApplicationStatusBanner | null;
  watchUpdateProgress?: (listener: (progress: UpdateProgress) => void) => () => void;
  canUpdate: boolean;
  canNativeUpdate: boolean;
  canStartNativeUpdate?: ConfirmAndStartUpdateParams["canStartNativeUpdate"];
  canHoldUpdate: boolean;
  onUpdate: () => void;
  captureUpdateTarget?: () => () => boolean;
  refreshRequired: boolean;
  onRefresh: () => Promise<boolean>;
  onHoldUpdate: () => Promise<boolean>;
  onReviewUpdate: () => void;
  onDismiss?: () => void;
};

export function SidebarUpdateCard(
  props: Partial<SidebarUpdateCardProps> & {
    class?: JSX.ClassValue;
    "data-attention-kind"?: string;
  },
) {
  let host!: HTMLElement;
  const [holdingCampaignId, setHoldingCampaignId] = createOptimistic<string | null>(null);
  const [nativeUpdateAvailable, setNativeUpdateAvailable] = createSignal(hasNativeUpdateBridge());
  const refreshScope = createMemo(() => ({ required: props.refreshRequired }), {
    equals: (before, after) => before.required === after.required,
  });
  const [refreshInFlight, setRefreshInFlight] = createSignal(() => {
    // Re-entering recovery starts with a fresh retry surface.
    refreshScope();
    return false;
  });
  const [refreshCompletion, setRefreshCompletion] = createSignal<
    { result: Promise<boolean> } | undefined
  >(() => {
    refreshScope();
    return undefined;
  });
  const refreshOutcome = createMemo(
    () =>
      refreshCompletion()?.result.then((reloading) => {
        if (!reloading) {
          throw new Error("Control UI refresh did not reload the document");
        }
        return null;
      }),
    { loadingValue: undefined },
  );
  const [targetCompletion, setTargetCompletion] = createSignal<{ result: Promise<boolean> }>();
  const targetReady = createMemo(() => targetCompletion()?.result ?? true, { loadingValue: true });
  const targetOutcome = createMemo(
    () =>
      targetCompletion()?.result.then((ready) => {
        if (!ready) {
          throw new Error("Update target check failed");
        }
        return null;
      }),
    { loadingValue: undefined },
  );
  const [checkingTarget, setCheckingTarget] = createOptimistic(false);
  const [expanded, setExpanded] = createSignal(false);
  const [now, setNow] = createSignal(Date.now());
  let refreshPending: ReturnType<typeof refreshScope> | undefined;
  let targetCheckPending = false;
  const updateNativeAvailability = () => setNativeUpdateAvailable(hasNativeUpdateBridge());
  onSettled(() =>
    listen(window, NATIVE_UPDATE_AVAILABILITY_CHANGED_EVENT, updateNativeAvailability),
  );
  createInterval(
    () => setNow(Date.now()),
    () => {
      const state = props.updateSchedule?.campaign?.state;
      return state === "countdown" || state === "waiting-for-idle" ? 1000 : undefined;
    },
  );
  const visibleStatusBanner = () =>
    props.statusBanner?.source === "read" || !props.updateRun ? props.statusBanner : null;
  function renderStatus() {
    const statusBanner = visibleStatusBanner();
    // The Gateway recorded this outcome; unlike the client's own update
    // metadata it stays true even when this client is stale.
    return statusBanner ? (
      <div
        class={["sidebar-update-card__status", `sidebar-update-card__status--${statusBanner.tone}`]}
        role="alert"
      >
        {statusBanner.text}
      </div>
    ) : (
      <Show when={!checkingTarget()}>
        <Errored
          fallback={
            <div class="sidebar-update-card__status sidebar-update-card__status--warn" role="alert">
              {t("updates.sidebar.checkFailed")}
            </div>
          }
        >
          {targetOutcome()}
        </Errored>
      </Show>
    );
  }

  const openRun = () => props.updateRun && confirmUpdate(props.updateRun);

  const expansionChecksTarget = () =>
    Boolean(props.onCheckStatus) &&
    !nativeUpdateAvailable() &&
    !isUpdateRunAttentionVisible(props.updateRun ?? null, props.updateRunAcknowledged ?? false);

  const checkStatus = action(async function* (pending: Promise<boolean>) {
    setCheckingTarget(true);
    const refreshed = await pending;
    yield;
    return refreshed;
  });

  const checkTarget = async () => {
    const check = props.onCheckStatus;
    if (!check) {
      return true;
    }
    if (targetCheckPending || props.connected === false || props.updateBusy) {
      return false;
    }
    targetCheckPending = true;
    // Observe the owner operation, not the action whose settlement these reads can hold.
    const completion = (async () => check())().catch(() => false);
    setTargetCompletion({ result: completion });
    try {
      const refreshed = await checkStatus(completion);
      // The action has settled; commit the overlay's fresh props before live checks.
      flush();
      return refreshed;
    } finally {
      targetCheckPending = false;
    }
  };

  const startUpdate = async () => {
    const campaign = props.updateSchedule?.campaign;
    const busy = props.updateBusy || campaign?.state === "applying";
    const viaNativeApp = hasNativeUpdateBridge();
    const canStart = () => (viaNativeApp ? props.canNativeUpdate : props.canUpdate);
    // Native-app updates own their discovery; Gateway freshness cannot gate them.
    if (busy || !canStart() || (!viaNativeApp && !(await checkTarget()))) {
      return;
    }
    if (
      !host.isConnected ||
      props.connected === false ||
      hasNativeUpdateBridge() !== viaNativeApp ||
      !canStart() ||
      props.refreshRequired ||
      props.updateBusy ||
      props.updateSchedule?.campaign?.state === "applying" ||
      !isUpdateActionable(props.updateAvailable, props.updateSchedule, false)
    ) {
      return;
    }
    confirmUpdate(undefined, viaNativeApp);
  };

  function confirmUpdate(existingRun?: UpdateRunRecord, viaNativeApp = hasNativeUpdateBridge()) {
    const isCurrentTarget = props.captureUpdateTarget?.();
    if (!isCurrentTarget) {
      return;
    }
    const onUpdate = props.onUpdate ?? (() => undefined);
    void confirmAndStartUpdate({
      isCurrentTarget,
      existingRun,
      prepareRetry: viaNativeApp ? undefined : props.prepareRetry,
      prepareGatewayFallback: props.prepareRetry,
      canStartNativeUpdate: props.canStartNativeUpdate,
      startGatewayUpdate: onUpdate,
      onCheckStatus: props.onCheckStatus,
      onReviewUpdate: props.onReviewUpdate ?? (() => undefined),
      onAcknowledge: props.onAcknowledge,
      watchUpdateProgress: props.watchUpdateProgress,
      updateAvailable: props.updateAvailable ?? null,
      updateSchedule: props.updateSchedule ?? null,
      // Keep the preflight owner; a lost native bridge needs fresh Gateway reconfirmation.
      viaNativeApp,
    });
  }

  const holdUpdate = action(function* (campaignId: string) {
    setHoldingCampaignId(campaignId);
    yield props.onHoldUpdate?.();
  });

  const refreshControlUi = async () => {
    const scope = refreshScope();
    if (refreshPending === scope) {
      return;
    }
    refreshPending = scope;
    // A successful reload owns this affordance until document unload, not promise settlement.
    setRefreshInFlight(true);
    const completion = (async () => (await props.onRefresh?.()) ?? false)().catch(() => false);
    setRefreshCompletion({ result: completion });
    const reloading = await completion;
    if (scope !== refreshScope() || !props.refreshRequired) {
      return;
    }
    if (!reloading) {
      refreshPending = undefined;
      setRefreshInFlight(false);
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
      isUpdateRunAttentionVisible(props.updateRun ?? null, props.updateRunAcknowledged ?? false) &&
      props.updateRun
    ) {
      const view = projectUpdateRun(props.updateRun, props.connected ?? true);
      return {
        title: view.headline,
        detail:
          props.statusBanner?.source === "read"
            ? props.statusBanner.text
            : !latest(targetReady)
              ? t("updates.sidebar.checkFailed")
              : view.compactLabel,
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
    const statusBanner = visibleStatusBanner();
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
            detail={checkingTarget() ? t("updates.sidebar.checking") : current().detail}
            timestampMs={current().timestampMs}
            icon={current().icon}
            severity={current().severity}
            critical={current().critical}
            onToggle={(open) => {
              setExpanded(open);
              if (open && expansionChecksTarget()) {
                void checkTarget();
              }
            }}
            onDismiss={props.onDismiss}
            body={<CompactDetails />}
            bodyClass="sidebar-update-issue__body"
          />
        )}
      </Show>
    );
  }

  function CompactDetails() {
    const statusBanner = () => {
      const banner = visibleStatusBanner();
      return banner?.source === "read" ? null : banner;
    };
    return (
      <Show when={statusBanner()} fallback={<Card />}>
        {(banner) => (
          <div class="sidebar-update-card sidebar-update-card--compact-details">
            <p class="sidebar-update-card__compact-reason" title={banner().text}>
              {banner().text}
            </p>
            <div class="sidebar-update-card__compact-actions">
              <button
                ref={sidebarAttentionFocusRef()}
                class="sidebar-update-card__review sidebar-update-card__review--primary"
                type="button"
                onClick={() => props.onReviewUpdate?.()}
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
            ref={sidebarAttentionFocusRef()}
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
        <Show when={!refreshInFlight()}>
          <Errored
            fallback={
              <div
                class="sidebar-update-card__status sidebar-update-card__status--warn"
                role="alert"
              >
                {t("updates.refreshFailed")}
              </div>
            }
          >
            {refreshOutcome()}
          </Errored>
        </Show>
        <button
          ref={sidebarAttentionFocusRef()}
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
              <Show when={!refreshInFlight()} fallback={t("lazyView.reloading")}>
                <Errored fallback={t("connection.retryNow")}>
                  {refreshOutcome() ?? t("chat.sidebar.serverUpdatedRefresh")}
                </Errored>
              </Show>
            </span>
          </span>
        </button>
      </div>
    );
  }

  function RecordedRunCard(current: { run: UpdateRunRecord }) {
    const view = createMemo(() => projectUpdateRun(current.run, props.connected ?? true));
    return (
      <div class="sidebar-update-card" role="status" aria-live="polite">
        {renderStatus()}
        <button
          ref={sidebarAttentionFocusRef()}
          class="sidebar-update-card__action"
          type="button"
          onClick={openRun}
        >
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
    // Expansion queues the target check; its first frame must already be busy.
    const checking = () =>
      checkingTarget() || (props.compact && !expanded() && expansionChecksTarget());
    const canUpdate = () => (nativeUpdateAvailable() ? props.canNativeUpdate : props.canUpdate);
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
          ref={sidebarAttentionFocusRef()}
          class={[
            "sidebar-update-card__action",
            { "sidebar-update-card__action--busy": busy() || checking() },
          ]}
          type="button"
          aria-disabled={canUpdate() ? undefined : "true"}
          disabled={busy() || checking()}
          aria-busy={checking() ? "true" : "false"}
          onClick={() => void startUpdate()}
        >
          <span class="sidebar-update-card__icon" aria-hidden="true">
            <Icon name={busy() || checking() ? "refresh" : "download"} />
          </span>
          <span
            class="sidebar-update-card__text"
            role={countdownActive() ? "timer" : undefined}
            aria-live={countdownActive() ? "off" : undefined}
          >
            {checking() ? t("updates.sidebar.checking") : text()}
          </span>
        </button>
      );
    }
    // An outcome with nothing left to act on is the whole card.
    return (
      <Show when={Boolean(props.statusBanner || actionable())}>
        <div
          class="sidebar-update-card"
          role={campaign() ? undefined : "status"}
          aria-live={campaign() ? undefined : "polite"}
        >
          {renderStatus()}
          <Show when={!actionable() && props.statusBanner?.source === "read"}>
            <button
              ref={sidebarAttentionFocusRef()}
              type="button"
              class="sidebar-update-card__review"
              disabled={checking() || props.connected === false}
              onClick={() => void checkTarget()}
            >
              {checking() ? t("updates.sidebar.checking") : t("connection.retryNow")}
            </button>
          </Show>
          <Show when={actionable()}>
            <div class="sidebar-update-card__actions">
              <Show
                when={canUpdate()}
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
          <Show when={props.statusBanner}>
            <button
              ref={sidebarAttentionFocusRef()}
              class="sidebar-update-card__review"
              type="button"
              onClick={() => props.onReviewUpdate?.()}
            >
              {t("updates.reviewUpdate")}
            </button>
          </Show>
          <Show when={actionable() && !busy() && !checking() && latest(targetReady)}>
            <UpdateGitRevisions
              schedule={props.updateSchedule}
              updateAvailable={props.updateAvailable}
              compareLinkRef={sidebarAttentionFocusRef()}
            />
          </Show>
        </div>
      </Show>
    );
  }

  function Card() {
    const run = createMemo(() =>
      isUpdateRunAttentionVisible(props.updateRun ?? null, props.updateRunAcknowledged ?? false)
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
    <openclaw-sidebar-update-card
      ref={(element) => (host = element)}
      style="display: contents"
      class={props.class}
      data-attention-kind={props["data-attention-kind"]}
    >
      <Show when={props.compact} fallback={<Card />}>
        <CompactCard />
      </Show>
    </openclaw-sidebar-update-card>
  );
}
