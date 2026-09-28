import { html, nothing, type TemplateResult } from "lit";
import "../../../components/elapsed-time.ts";
import type { GatewaySessionRow } from "../../../api/types.ts";
import type { ApplicationPlacementStartupStatus } from "../../../app/session-placement-startup.ts";
import { resolveCloudWorkerStopAction } from "../../../components/cloud-worker-stop.ts";
import { icons } from "../../../components/icons.ts";
import { isCloudWorkerPlacementState } from "../../../components/session-row-badges.ts";
import { t } from "../../../i18n/index.ts";
import { formatBytes } from "../../../lib/agents/display.ts";
import { formatRelativeTimestamp } from "../../../lib/format.ts";
import {
  repositorySessionNeedsWorker,
  resolveChatPaneWorkerPresentation,
} from "../chat-pane-placement.ts";

export function renderChatPanePlacement(props: {
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
}): TemplateResult | typeof nothing {
  const session = props.session;
  const placement = session?.placement;
  const placementState = placement?.state;
  const dispatchRequired = repositorySessionNeedsWorker(session);
  if (!session || (!isCloudWorkerPlacementState(placementState) && !dispatchRequired)) {
    return nothing;
  }
  const placementMove = session.placementMove;
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
  const reclaimDisabledReason = props.placementReclaimDisabledReason;
  const recoveryDisabledReason = props.placementRecoveryDisabledReason;
  const age = formatRelativeTimestamp(placement?.stateChangedAtMs, {
    fallback: "",
  });
  const exceptionState = placementMove?.error
    ? placementMove.error
    : dispatchRequired || placementState === "active" || hasFacts
      ? nothing
      : `${placementState}${age ? ` · ${age}` : ""}`;
  return html`
    <div class="chat-pane__placement-control">
      <wa-dropdown class="chat-pane__placement-menu" placement="bottom-start">
        <button slot="trigger" class="chat-pane__placement-chip" type="button">${label}</button>
        ${
          exceptionState === nothing
            ? nothing
            : html`<div class="chat-pane__placement-state">${exceptionState}</div>`
        }
        ${
          hasFacts
            ? html`<dl class="chat-pane__placement-facts">
                ${
                  providerId
                    ? html`<dt>${t("sessionsView.placementFactService")}</dt>
                        <dd>${providerId}</dd>`
                    : nothing
                }
                ${
                  profileId
                    ? html`<dt>${t("sessionsView.placementFactProfile")}</dt>
                        <dd>${profileId}</dd>`
                    : nothing
                }
                ${
                  environmentId
                    ? html`<dt>${t("sessionsView.placementFactMachine")}</dt>
                        <dd>…${environmentId.slice(-6)}</dd>`
                    : nothing
                }
                <dt>${t("sessionsView.placementFactState")}</dt>
                <dd>${placementState}${age ? ` · ${age}` : ""}</dd>
                ${
                  placement?.state === "active" && placement.diskSpace
                    ? html`<dt>${t("sessionsView.placementFactDisk")}</dt>
                        <dd>
                          ${t("sessionsView.placementDiskFree", {
                            free: formatBytes(placement.diskSpace.availableBytes),
                          })}
                        </dd>`
                    : nothing
                }
              </dl>`
            : nothing
        }
        ${(
          [
            [
              placementState === "active",
              `chat-pane__placement-move ${deviceOffline ? "session-menu__item--destructive" : ""}`,
              deviceOffline,
              moveDisabledReason,
              icons.monitor,
              deviceOffline ? "sessionsView.continueOnGatewayMenu" : "sessionsView.moveSession",
              props.onPlacementMove,
            ],
            [
              dispatchRequired || restartable,
              "chat-pane__placement-recovery",
              false,
              recoveryDisabledReason,
              icons.monitor,
              dispatchRequired ? "sessionsView.chooseWorker" : "sessionsView.restartSession",
              props.onPlacementRecover,
            ],
            [
              stopAction,
              "session-menu__item--destructive chat-pane__placement-reclaim",
              true,
              reclaimDisabledReason,
              icons.stop,
              null,
              props.onPlacementReclaim,
            ],
          ] as const
        ).map(([visible, className, destructive, disabledReason, icon, labelKey, onClick]) =>
          visible
            ? html`<wa-dropdown-item
                class=${`session-menu__item ${className}`}
                variant=${destructive ? "danger" : nothing}
                ?disabled=${Boolean(disabledReason)}
                title=${disabledReason ?? nothing}
                @click=${() => !disabledReason && onClick?.()}
              >
                <span slot="icon" class="session-menu__icon" aria-hidden="true">${icon}</span>
                <span class="session-menu__text">${labelKey ? t(labelKey) : worker.stopLabel}</span>
              </wa-dropdown-item>`
            : nothing,
        )}
      </wa-dropdown>
      ${
        deviceOffline
          ? html`<div class="chat-pane__placement-note" role="status">
              ${t("sessionsView.waitingForDevice")}
            </div>`
          : workspaceResultReconciling
            ? html`<div class="chat-pane__placement-note" role="status">
                ${t("sessionsView.syncingCloudFilesDetail")}
              </div>`
            : placement && (placement.state === "draining" || placement.state === "reconciling")
              ? html`<div class="chat-pane__placement-note" role="status">
                  ${t("sessionsView.syncingCloudFilesDetail")} ·
                  <openclaw-elapsed-time
                    .startMs=${placement.stateChangedAtMs}
                  ></openclaw-elapsed-time>
                </div>`
              : nothing
      }
    </div>
  `;
}
