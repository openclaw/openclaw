import { html, nothing, type TemplateResult } from "lit";
import { t } from "../i18n/index.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import type { SidebarSessionHovercardRow } from "./app-sidebar-session-types.ts";
import { icons } from "./icons.ts";
import { sessionMachineParts } from "./session-machine.ts";
import type { progressCardHeadsUp } from "./session-progress-card.ts";

export type SessionHovercardContextInput = {
  row?: SidebarSessionHovercardRow;
  automationLink?: { href: string; navigate: () => void };
};

function renderContextRow(
  icon: TemplateResult,
  value: string,
  label: string,
  title: string | typeof nothing = nothing,
) {
  return html`<div class="session-hovercard__context-row" aria-label=${label} title=${title}>
    <span class="session-hovercard__context-icon" aria-hidden="true">${icon}</span>
    <span class="session-hovercard__context-value session-hovercard__context-text">${value}</span>
  </div>`;
}

function renderProgressHeadsUp(headsUp: ReturnType<typeof progressCardHeadsUp>) {
  if (!headsUp) {
    return nothing;
  }
  const statusLabel = t(
    headsUp.status === "in_progress"
      ? "sessionProgressCard.status.inProgress"
      : headsUp.status === "paused"
        ? "sessionProgressCard.status.paused"
        : "sessionProgressCard.status.pending",
  );
  return html`<div
    class="session-hovercard__context-row session-hovercard__plan-row"
    aria-label=${t("sessionProgressCard.stepLabel", {
      status: statusLabel,
      step: headsUp.step,
    })}
    title=${headsUp.step}
  >
    <span class="session-hovercard__context-icon" aria-hidden="true"
      >${
        headsUp.status === "in_progress"
          ? html`<span class="session-run-spinner"></span>`
          : icons.clock
      }</span
    >
    <span class="session-hovercard__context-value session-hovercard__plan-step"
      >${headsUp.step}</span
    >
    <span class="session-hovercard__plan-count">${headsUp.completed}/${headsUp.total}</span>
  </div>`;
}

export function renderSessionHovercardContext(
  { row, automationLink }: SessionHovercardContextInput,
  headsUp: ReturnType<typeof progressCardHeadsUp>,
) {
  const context = row?.workContext;
  const contextLabel = t(
    context?.kind === "project"
      ? "sessionHovercard.projectLabel"
      : "sessionHovercard.workspaceLabel",
  );
  const directory = context?.kind === "project" ? context.cwd : context?.path;
  const projectLocation = directory ?? context?.path;
  const placementIdentity =
    row?.placementProviderId && row.placementProfileId
      ? {
          label: `${row.placementProviderId} · ${row.placementProfileId}`,
          title: t("sessionHovercard.runsOn", {
            providerId: row.placementProviderId,
            profileId: row.placementProfileId,
          }),
        }
      : undefined;
  const machineParts = sessionMachineParts(row?.placementMachine);
  const machineSummary = machineParts.filter(Boolean).join(" · ");
  return html`<div class="session-hovercard__context">
    ${
      context
        ? renderContextRow(
            icons.folder,
            context.name,
            `${contextLabel}: ${context.name}`,
            projectLocation ? `${contextLabel}: ${projectLocation}` : nothing,
          )
        : nothing
    }
    ${
      context?.kind === "project" && context.branch
        ? renderContextRow(
            icons.gitBranch,
            context.branch,
            `${t("sessionHovercard.branchLabel")}: ${context.branch}`,
            directory ?? nothing,
          )
        : nothing
    }
    ${
      placementIdentity
        ? renderContextRow(
            icons.server,
            placementIdentity.label,
            placementIdentity.title,
            placementIdentity.title,
          )
        : nothing
    }
    ${
      placementIdentity && machineSummary
        ? html`<div
            class="session-hovercard__machine"
            aria-label=${`${t("sessionHovercard.machineLabel")}: ${machineSummary}`}
          >
            ${machineParts.map((part, index) =>
              part
                ? html`<span class=${index === 1 ? "session-hovercard__machine-class" : nothing}
                    >${part}</span
                  >`
                : nothing,
            )}
          </div>`
        : nothing
    }
    ${
      row?.boardFace === "dashboard"
        ? renderContextRow(
            icons.layoutDashboard,
            t("sessionsView.opensAsDashboard"),
            t("sessionsView.opensAsDashboard"),
          )
        : nothing
    }
    ${
      row?.hasAutomation && automationLink
        ? html`<a
            class="session-hovercard__context-row session-hovercard__automation-link"
            href=${automationLink.href}
            @click=${(event: MouseEvent) => {
              if (shouldHandleNavigationClick(event)) {
                event.preventDefault();
                automationLink.navigate();
              }
            }}
          >
            <span class="session-hovercard__context-icon" aria-hidden="true">${icons.clock}</span>
            <span class="session-hovercard__context-value session-hovercard__context-text"
              >${t("sessionsView.automationAttached")}</span
            >
            <span class="session-hovercard__context-icon" aria-hidden="true"
              >${icons.chevronRight}</span
            >
          </a>`
        : nothing
    }
    ${renderProgressHeadsUp(headsUp)}
  </div>`;
}
