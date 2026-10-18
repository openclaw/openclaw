import { createMemo, For, Show } from "solid-js";
import type { GatewaySessionRow } from "../../../api/types.ts";
import type { ApplicationPlacementStartupStatus } from "../../../app/session-placement-startup.ts";
import "../../../components/elapsed-time.tsx";
import { resolveCloudWorkerStopAction } from "../../../components/cloud-worker-stop.ts";
import {
  repositorySessionNeedsWorker,
  sessionPlacementRetry,
} from "../../../components/session-placement-action.ts";
import { isCloudWorkerPlacementState } from "../../../components/session-row-badges.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { Menu, type MenuEntry } from "../../../components/solid/menu.tsx";
import { formatBytes } from "../../../lib/agents/display.ts";
import { formatRelativeTimestamp } from "../../../lib/format.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { resolveChatPaneWorkerPresentation } from "../chat-pane-placement.ts";

let nextPlacementId = 0;

export function ChatPanePlacement(props: {
  session: GatewaySessionRow | undefined;
  placementStartupStatus?: Pick<ApplicationPlacementStartupStatus, "phase" | "targetKind"> | null;
  placementMoving?: boolean;
  placementRestarting?: boolean;
  placementMoveDisabledReason?: string;
  placementReclaimDisabledReason?: string;
  placementRecoveryDisabledReason?: string;
  onPlacementMove?: () => void;
  onPlacementReclaim?: () => void;
  onPlacementRecover?: () => void;
}) {
  const id = `chat-placement-${++nextPlacementId}`;
  const state = createMemo(() => {
    const session = props.session;
    const placement = session?.placement;
    const placementState = placement?.state;
    const dispatchRequired = repositorySessionNeedsWorker(session);
    if (!session || (!isCloudWorkerPlacementState(placementState) && !dispatchRequired)) {
      return null;
    }
    const placementMove = session.placementMove;
    const retry = sessionPlacementRetry(session);
    const workerPlacement =
      placement && placement.state !== "local" && placement.state !== "requested"
        ? placement
        : undefined;
    const providerId = workerPlacement?.providerId;
    const profileId = workerPlacement?.profileId;
    const environmentId = workerPlacement?.environmentId;
    const hasFacts = Boolean(providerId || profileId || environmentId);
    const runner = placement?.state === "active" ? placement.runner : undefined;
    const deviceOffline = runner?.kind === "device" && runner.status === "offline";
    const workspaceResultReconciling =
      (placement?.state === "active" || placement?.state === "draining") &&
      placement.workspaceResultReconciling === true;
    const restartable = placement?.state === "failed" && placement.recoveryAction === "restart";
    const stopAction = resolveCloudWorkerStopAction(placement);
    const worker = resolveChatPaneWorkerPresentation(session, props.placementStartupStatus);
    const moveTarget =
      placementMove?.target.kind === "gateway"
        ? t("sessionsView.moveSessionGatewayTarget")
        : placementMove?.target.kind === "profile"
          ? placementMove.target.profileId
          : placementMove?.target.kind === "device"
            ? placementMove.target.deviceId
            : undefined;
    const label = placementMove?.error
      ? t("sessionsView.moveSessionFailed")
      : placementMove && moveTarget
        ? t("sessionsView.movingSession", { target: moveTarget })
        : props.placementRestarting
          ? t(
              session.repositoryWorkspaceId && placementState !== "failed"
                ? "sessionsView.dispatchingSession"
                : "sessionsView.restartingSession",
            )
          : props.placementMoving
            ? t("sessionsView.movingSessionGeneric")
            : deviceOffline
              ? t("sessionsView.deviceOffline")
              : workspaceResultReconciling ||
                  placementState === "draining" ||
                  placementState === "reconciling"
                ? t("sessionsView.syncingCloudFiles")
                : dispatchRequired
                  ? t("sessionsView.repositoryWorkerRequiredLabel")
                  : worker.label;
    const moveDisabledReason = props.placementMoveDisabledReason;
    const destructiveMove = retry ? retry.abandonSource === true : deviceOffline;
    const reclaimDisabledReason = props.placementReclaimDisabledReason;
    const recoveryDisabledReason = props.placementRecoveryDisabledReason;
    const age = formatRelativeTimestamp(placement?.stateChangedAtMs, {
      fallback: "",
    });
    const exceptionState = placementMove?.error
      ? placementMove.error
      : dispatchRequired || placementState === "active" || hasFacts
        ? undefined
        : `${placementState}${age ? ` · ${age}` : ""}`;
    return {
      label,
      exceptionState,
      hasFacts,
      providerId,
      profileId,
      environmentId,
      placementState,
      age,
      inferenceWorker: placement?.state === "active" && placement.inference === "worker",
      diskSpace: placement?.state === "active" ? placement.diskSpace : undefined,
      deviceOffline,
      workspaceResultReconciling,
      syncElapsed:
        placement && (placement.state === "draining" || placement.state === "reconciling")
          ? placement.stateChangedAtMs
          : undefined,
      actions: [
        {
          id: "move",
          visible: placementState === "active" || Boolean(retry),
          className: [
            "chat-pane__placement-move",
            { "session-menu__item--destructive": destructiveMove },
          ],
          destructive: destructiveMove,
          disabledReason: moveDisabledReason,
          icon: "monitor" as const,
          label: t(
            retry
              ? "sessionsView.retrySessionMove"
              : deviceOffline
                ? "sessionsView.continueOnGatewayMenu"
                : "sessionsView.moveSession",
          ),
          onClick: props.onPlacementMove,
        },
        {
          id: "recover",
          visible: dispatchRequired || restartable,
          className: "chat-pane__placement-recovery",
          destructive: false,
          disabledReason: recoveryDisabledReason,
          icon: "monitor" as const,
          label: t(dispatchRequired ? "sessionsView.chooseWorker" : "sessionsView.restartSession"),
          onClick: props.onPlacementRecover,
        },
        {
          id: "reclaim",
          visible: Boolean(stopAction),
          className: "session-menu__item--destructive chat-pane__placement-reclaim",
          destructive: true,
          disabledReason: reclaimDisabledReason,
          icon: "stop" as const,
          label: worker.stopLabel,
          onClick: props.onPlacementReclaim,
        },
      ],
    };
  });
  const items = createMemo((): MenuEntry[] =>
    (state()?.actions ?? [])
      .filter((action) => action.visible)
      .map((action) => ({
        id: action.id,
        label: action.label,
        class: ["session-menu__item", action.className],
        variant: action.destructive ? "danger" : undefined,
        disabled: Boolean(action.disabledReason),
        attributes: { title: action.disabledReason },
        icon: (
          <span class="session-menu__icon" aria-hidden="true">
            <Icon name={action.icon} />
          </span>
        ),
        content: <span class="session-menu__text">{action.label}</span>,
      })),
  );
  return (
    <Show when={state()}>
      {(view) => (
        <div class="chat-pane__placement-control">
          <Menu
            lazy
            id={id}
            class="chat-pane__placement-menu"
            placement="bottom-start"
            label={view().label}
            triggerClass="chat-pane__placement-chip"
            items={items()}
            onSelect={(item) =>
              view()
                .actions.find((action) => action.id === item.id)
                ?.onClick?.()
            }
          >
            <Show when={view().exceptionState}>
              {(message) => <div class="chat-pane__placement-state">{message()}</div>}
            </Show>
            <Show when={view().hasFacts}>
              <dl class="chat-pane__placement-facts">
                <For
                  each={
                    [
                      ["sessionsView.placementFactService", view().providerId],
                      ["sessionsView.placementFactProfile", view().profileId],
                      [
                        "sessionsView.placementFactMachine",
                        view().environmentId && `…${view().environmentId!.slice(-6)}`,
                      ],
                    ] as const
                  }
                >
                  {(entry) => (
                    <Show when={entry[1]}>
                      <dt>{t(entry[0])}</dt>
                      <dd>{entry[1]}</dd>
                    </Show>
                  )}
                </For>
                <Show when={view().inferenceWorker}>
                  <dt>{t("sessionsView.placementFactInference")}</dt>
                  <dd>{t("sessionsView.inferenceWorker")}</dd>
                </Show>
                <dt>{t("sessionsView.placementFactState")}</dt>
                <dd>
                  {view().placementState}
                  {view().age ? ` · ${view().age}` : ""}
                </dd>
                <Show when={view().diskSpace}>
                  {(disk) => (
                    <>
                      <dt>{t("sessionsView.placementFactDisk")}</dt>
                      <dd>
                        {t("sessionsView.placementDiskFree", {
                          free: formatBytes(disk().availableBytes),
                        })}
                      </dd>
                    </>
                  )}
                </Show>
              </dl>
            </Show>
          </Menu>
          <Show
            when={view().deviceOffline}
            fallback={
              <Show
                when={view().workspaceResultReconciling}
                fallback={
                  <Show when={view().syncElapsed !== undefined}>
                    <div class="chat-pane__placement-note" role="status">
                      {t("sessionsView.syncingCloudFilesDetail")} ·{" "}
                      <openclaw-elapsed-time prop:startMs={view().syncElapsed} />
                    </div>
                  </Show>
                }
              >
                <div class="chat-pane__placement-note" role="status">
                  {t("sessionsView.syncingCloudFilesDetail")}
                </div>
              </Show>
            }
          >
            <div class="chat-pane__placement-note" role="status">
              {t("sessionsView.waitingForDevice")}
            </div>
          </Show>
        </div>
      )}
    </Show>
  );
}
