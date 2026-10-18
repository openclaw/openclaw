import type { JSX } from "@solidjs/web";
import { createMemo, For, Show } from "solid-js";
import type { GatewaySessionRow } from "../../../api/types.ts";
import type { ApplicationPlacementStartupStatus } from "../../../app/session-placement-startup.ts";
import { resolveCloudWorkerStopAction } from "../../../components/cloud-worker-stop.ts";
import { ElapsedTime } from "../../../components/elapsed-time.tsx";
import {
  repositorySessionNeedsWorker,
  sessionPlacementRetry,
} from "../../../components/session-placement-action.ts";
import { isCloudWorkerPlacementState } from "../../../components/session-row-badges.ts";
import { Icon, type IconName } from "../../../components/solid/icon.tsx";
import { Menu, type MenuEntry } from "../../../components/solid/menu.tsx";
import { registerSessionMachineEnglish } from "../../../i18n/locales/en-session-machine.ts";
import { formatBytes } from "../../../lib/agents/display.ts";
import { formatRelativeTimestamp } from "../../../lib/format.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { resolveChatPaneWorkerPresentation } from "../chat-pane-placement.ts";

registerEnglishCatalog(registerSessionMachineEnglish);

let nextPlacementId = 0;

export type ChatPanePlacementProps = {
  /** Native environment catalog label; never the session title. */
  machineName?: string;
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
};

export function createChatMachinePresentation(props: ChatPanePlacementProps) {
  return createMemo(() => {
    const session = props.session;
    const placement = session?.placement;
    const placementState = placement?.state ?? "local";
    const dispatchRequired = repositorySessionNeedsWorker(session);
    if (!session) {
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
      showPlacementMenu: isCloudWorkerPlacementState(placementState) || dispatchRequired,
      machineName:
        props.machineName ||
        environmentId ||
        (placementState === "local" ? t("sessionsView.moveSessionGatewayTarget") : worker.label),
      machineIcon: (runner?.kind === "device" || placementState === "local"
        ? "monitor"
        : "cloud") as IconName,
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
          visible:
            placementState === "active" ||
            Boolean(retry) ||
            (placementState === "local" && !dispatchRequired && Boolean(props.onPlacementMove)),
          className: [
            "chat-pane__placement-move",
            { "session-menu__item--destructive": destructiveMove },
          ],
          destructive: destructiveMove,
          disabledReason: moveDisabledReason,
          icon: "arrowLeftRight" as const,
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
}

export type ChatPanePlacementTrigger = {
  content: (view: ChatMachinePresentation) => JSX.Element;
  label: (view: ChatMachinePresentation) => string;
  class?: JSX.ClassValue;
};

export function ChatPanePlacement(
  props: ChatPanePlacementProps & { trigger?: ChatPanePlacementTrigger },
) {
  const id = `chat-placement-${++nextPlacementId}`;
  const state = createChatMachinePresentation(props);
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
    <Show when={state()?.showPlacementMenu && state()}>
      {(view) => (
        <div class="chat-pane__placement-control">
          <Menu
            lazy
            id={id}
            class="chat-pane__placement-menu"
            placement="bottom-start"
            label={props.trigger?.label(view()) ?? view().label}
            trigger={props.trigger?.content(view())}
            triggerClass={props.trigger?.class ?? "chat-pane__placement-chip"}
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
            <div class="chat-pane__placement-heading">
              <strong>{view().machineName}</strong>
              <Show when={view().environmentId}>
                {(environmentId) => <span>…{environmentId().slice(-6)}</span>}
              </Show>
            </div>
            <ChatMachineFacts view={view()} />
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
                      <ElapsedTime startMs={view().syncElapsed} />
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

export type ChatMachinePresentation = NonNullable<
  ReturnType<ReturnType<typeof createChatMachinePresentation>>
>;

export function ChatMachineFacts(props: {
  view: ChatMachinePresentation;
  group?: "configuration" | "state";
  includeId?: boolean;
}) {
  const facts = createMemo(() => {
    const view = props.view;
    const configuration: {
      label: string;
      value: string | undefined;
      icon?: IconName;
    }[] = [
      ...(props.includeId
        ? [
            {
              label: t("sessionsView.machineId"),
              value: view.environmentId && `…${view.environmentId.slice(-6)}`,
              icon: "hash" as const,
            },
          ]
        : []),
      { label: t("sessionsView.placementFactService"), value: view.providerId, icon: "server" },
      { label: t("sessionsView.placementFactProfile"), value: view.profileId, icon: "settings" },
      {
        label: t("sessionsView.placementFactInference"),
        value: view.inferenceWorker ? t("sessionsView.inferenceWorker") : undefined,
        icon: "cpu",
      },
    ];
    const state = [
      {
        label: t("sessionsView.placementFactState"),
        value:
          view.placementState === "local"
            ? undefined
            : `${view.placementState}${view.age ? ` · ${view.age}` : ""}`,
        icon: "activity" as const,
      },
      {
        label: t("sessionsView.placementFactDisk"),
        value: view.diskSpace
          ? t("sessionsView.placementDiskFree", {
              free: formatBytes(view.diskSpace.availableBytes),
            })
          : undefined,
        icon: "archive" as const,
      },
    ];
    return (
      props.group === "configuration"
        ? configuration
        : props.group === "state"
          ? state
          : [...configuration, ...state]
    ).filter((fact) => fact.value);
  });
  return (
    <Show when={facts().length}>
      <dl class="chat-pane__placement-facts">
        <For each={facts()}>
          {(fact) => (
            <div class="chat-pane__placement-fact">
              <dt>
                <span class="chat-pane__placement-fact-icon" aria-hidden="true">
                  <Show when={fact.icon} fallback="#">
                    {(icon) => <Icon name={icon()} />}
                  </Show>
                </span>
                {fact.label}
              </dt>
              <dd>{fact.value}</dd>
            </div>
          )}
        </For>
      </dl>
    </Show>
  );
}
