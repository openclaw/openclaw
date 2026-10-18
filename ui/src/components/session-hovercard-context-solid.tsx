import type { JSX } from "@solidjs/web";
import { createMemo, For, Show } from "solid-js";
import { t } from "../i18n/index.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import type { SidebarSessionHovercardRow } from "./app-sidebar-session-types.ts";
import { sessionMachineParts } from "./session-machine.ts";
import type { progressCardHeadsUp } from "./session-progress-card.ts";
import { Icon } from "./solid/icon.tsx";

export type SessionHovercardContextInput = {
  row?: SidebarSessionHovercardRow;
  automationLink?: { href: string; navigate: () => void };
};

function ContextRow(props: { icon: JSX.Element; value: string; label: string; title?: string }) {
  return (
    <div class="session-hovercard__context-row" aria-label={props.label} title={props.title}>
      <span class="session-hovercard__context-icon" aria-hidden="true">
        {props.icon}
      </span>
      <span class="session-hovercard__context-value session-hovercard__context-text">
        {props.value}
      </span>
    </div>
  );
}

function ProgressHeadsUp(props: { headsUp: ReturnType<typeof progressCardHeadsUp> }) {
  const statusLabel = () =>
    t(
      props.headsUp?.status === "in_progress"
        ? "sessionProgressCard.status.inProgress"
        : props.headsUp?.status === "paused"
          ? "sessionProgressCard.status.paused"
          : "sessionProgressCard.status.pending",
    );
  return (
    <Show when={props.headsUp}>
      <div
        class="session-hovercard__context-row session-hovercard__plan-row"
        aria-label={t("sessionProgressCard.stepLabel", {
          status: statusLabel(),
          step: props.headsUp?.step ?? "",
        })}
        title={props.headsUp?.step}
      >
        <span class="session-hovercard__context-icon" aria-hidden="true">
          <Show when={props.headsUp?.status === "in_progress"} fallback={<Icon name="clock" />}>
            <span class="session-run-spinner" />
          </Show>
        </span>
        <span class="session-hovercard__context-value session-hovercard__plan-step">
          {props.headsUp?.step}
        </span>
        <span class="session-hovercard__plan-count">
          {props.headsUp?.completed}/{props.headsUp?.total}
        </span>
      </div>
    </Show>
  );
}

export function SessionHovercardContext(
  props: SessionHovercardContextInput & { headsUp: ReturnType<typeof progressCardHeadsUp> },
) {
  const context = () => props.row?.workContext;
  const contextLabel = () =>
    t(
      context()?.kind === "project"
        ? "sessionHovercard.projectLabel"
        : "sessionHovercard.workspaceLabel",
    );
  const directory = () => {
    const current = context();
    return current?.kind === "project" ? current.cwd : current?.path;
  };
  const projectLocation = () => directory() ?? context()?.path;
  const branch = () => {
    const current = context();
    return current?.kind === "project" ? current.branch : undefined;
  };
  const placement = createMemo(() =>
    props.row?.placementProviderId && props.row.placementProfileId
      ? {
          label: `${props.row.placementProviderId} · ${props.row.placementProfileId}`,
          title: t("sessionHovercard.runsOn", {
            providerId: props.row.placementProviderId,
            profileId: props.row.placementProfileId,
          }),
        }
      : undefined,
  );
  const machineParts = createMemo(() => sessionMachineParts(props.row?.placementMachine));
  const machineSummary = () => machineParts().filter(Boolean).join(" · ");
  return (
    <div class="session-hovercard__context">
      <Show when={context()}>
        <ContextRow
          icon={<Icon name="folder" />}
          value={context()?.name ?? ""}
          label={`${contextLabel()}: ${context()?.name ?? ""}`}
          title={projectLocation() ? `${contextLabel()}: ${projectLocation()}` : undefined}
        />
      </Show>
      <Show when={branch()}>
        <ContextRow
          icon={<Icon name="gitBranch" />}
          value={branch() ?? ""}
          label={`${t("sessionHovercard.branchLabel")}: ${branch() ?? ""}`}
          title={directory()}
        />
      </Show>
      <Show when={placement()}>
        <ContextRow
          icon={<Icon name="server" />}
          value={placement()?.label ?? ""}
          label={placement()?.title ?? ""}
          title={placement()?.title}
        />
      </Show>
      <Show when={placement() && machineSummary()}>
        <div
          class="session-hovercard__machine"
          aria-label={`${t("sessionHovercard.machineLabel")}: ${machineSummary()}`}
        >
          <For each={machineParts()}>
            {(part, index) => (
              <Show when={part}>
                <span class={index() === 1 ? "session-hovercard__machine-class" : undefined}>
                  {part}
                </span>
              </Show>
            )}
          </For>
        </div>
      </Show>
      <Show when={props.row?.boardFace === "dashboard"}>
        <ContextRow
          icon={<Icon name="layoutDashboard" />}
          value={t("sessionsView.opensAsDashboard")}
          label={t("sessionsView.opensAsDashboard")}
        />
      </Show>
      <Show when={props.row?.hasAutomation && props.automationLink}>
        <a
          class="session-hovercard__context-row session-hovercard__automation-link"
          href={props.automationLink?.href}
          onClick={(event: MouseEvent) => {
            if (shouldHandleNavigationClick(event)) {
              event.preventDefault();
              props.automationLink?.navigate();
            }
          }}
        >
          <span class="session-hovercard__context-icon" aria-hidden="true">
            <Icon name="clock" />
          </span>
          <span class="session-hovercard__context-value session-hovercard__context-text">
            {t("sessionsView.automationAttached")}
          </span>
          <span class="session-hovercard__context-icon" aria-hidden="true">
            <Icon name="chevronRight" />
          </span>
        </a>
      </Show>
      <ProgressHeadsUp headsUp={props.headsUp} />
    </div>
  );
}
