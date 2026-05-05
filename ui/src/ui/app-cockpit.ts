import { html, nothing } from "lit";
import { t } from "../i18n/index.ts";
import {
  createChatSession,
  resolveSessionDisplayName,
  switchChatSession,
} from "./app-render.helpers.ts";
import type { AppViewState } from "./app-view-state.ts";
import { icons } from "./icons.ts";
import { resolveAgentIdFromSessionKey } from "./session-key.ts";
import { normalizeOptionalString } from "./string-coerce.ts";

function formatCompactRelativeTime(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return t("cockpit.timeNever");
  }
  const deltaMs = Date.now() - value;
  if (deltaMs < 0) {
    return t("cockpit.timeNow");
  }
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) {
    return t("cockpit.timeNow");
  }
  if (minutes < 60) {
    return t("cockpit.minutesAgo", { count: String(minutes) });
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return t("cockpit.hoursAgo", { count: String(hours) });
  }
  const days = Math.floor(hours / 24);
  if (days < 14) {
    return t("cockpit.daysAgo", { count: String(days) });
  }
  return new Date(value).toLocaleDateString([], { month: "short", day: "numeric" });
}

function getAgentDisplayName(state: AppViewState, agentId: string | null): string {
  if (!agentId) {
    return state.assistantName || t("cockpit.defaultAgent");
  }
  const agent = state.agentsList?.agents?.find((entry) => entry.id === agentId);
  return (
    normalizeOptionalString(agent?.identity?.name) ??
    normalizeOptionalString(agent?.name) ??
    agentId
  );
}

function countConnectedChannels(state: AppViewState): number {
  const accounts = Object.values(state.channelsSnapshot?.channelAccounts ?? {}).flat();
  return accounts.filter((account) => account.connected || account.running || account.linked)
    .length;
}

export function renderCockpitSessionRail(state: AppViewState, navCollapsed: boolean) {
  if (navCollapsed) {
    return nothing;
  }
  const recentSessions = (state.sessionsResult?.sessions ?? [])
    .filter((session) => !session.archived)
    .toSorted((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .slice(0, 7);
  const agentId =
    resolveAgentIdFromSessionKey(state.sessionKey) ?? state.agentsList?.defaultId ?? null;
  const agentName = getAgentDisplayName(state, agentId);
  const activeSessionLabel =
    recentSessions.find((entry) => entry.key === state.sessionKey)?.displayName ??
    recentSessions.find((entry) => entry.key === state.sessionKey)?.label ??
    state.sessionKey;

  return html`
    <div class="cockpit-quick">
      <button
        type="button"
        class="cockpit-new-chat"
        ?disabled=${state.chatLoading || state.chatSending || Boolean(state.chatRunId)}
        @click=${() => void createChatSession(state)}
      >
        <span aria-hidden="true">${icons.plus}</span>
        <span>${t("cockpit.newChat")}</span>
      </button>
      <button
        type="button"
        class="cockpit-agent-card"
        @click=${() => state.setTab("agents" as import("./navigation.ts").Tab)}
      >
        <span class="cockpit-agent-card__avatar" aria-hidden="true">
          ${state.assistantAvatar ? html`<img src=${state.assistantAvatar} alt="" />` : icons.brain}
        </span>
        <span class="cockpit-agent-card__copy">
          <span class="cockpit-agent-card__label">${t("cockpit.agent")}</span>
          <span class="cockpit-agent-card__name">${agentName}</span>
          <span class="cockpit-agent-card__sub">${activeSessionLabel}</span>
        </span>
      </button>
    </div>
    <section class="cockpit-sessions" aria-label=${t("cockpit.recentSessions")}>
      <div class="cockpit-section-head">
        <span>${t("cockpit.sessions")}</span>
        <button
          type="button"
          class="cockpit-link-button"
          @click=${() => state.setTab("sessions" as import("./navigation.ts").Tab)}
        >
          ${t("cockpit.all")}
        </button>
      </div>
      <div class="cockpit-session-list">
        ${recentSessions.length
          ? recentSessions.map((session) => {
              const label = resolveSessionDisplayName(session.key, session);
              const active = session.key === state.sessionKey;
              return html`
                <button
                  type="button"
                  class="cockpit-session ${active ? "cockpit-session--active" : ""}"
                  @click=${() => {
                    switchChatSession(state, session.key);
                    state.setTab("chat" as import("./navigation.ts").Tab);
                  }}
                  title=${session.key}
                >
                  <span class="cockpit-session__dot" aria-hidden="true"></span>
                  <span class="cockpit-session__main">
                    <span class="cockpit-session__title">${label}</span>
                    <span class="cockpit-session__meta"
                      >${session.kind} · ${formatCompactRelativeTime(session.updatedAt)}</span
                    >
                  </span>
                  ${session.hasActiveRun
                    ? html`<span class="cockpit-session__run">${t("cockpit.live")}</span>`
                    : nothing}
                </button>
              `;
            })
          : html`<div class="cockpit-empty">${t("cockpit.noStoredSessions")}</div>`}
      </div>
    </section>
  `;
}

export function renderCapabilityInspector(state: AppViewState) {
  const skills = state.skillsReport?.skills ?? [];
  const readySkills = skills.filter((skill) => skill.eligible && !skill.disabled).length;
  const blockedSkills = skills.filter(
    (skill) => skill.disabled || skill.blockedByAllowlist || !skill.eligible,
  ).length;
  const enabledCronJobs = state.cronJobs.filter((job) => job.enabled).length;
  const nextCron =
    typeof state.cronStatus?.nextWakeAtMs === "number"
      ? formatCompactRelativeTime(state.cronStatus.nextWakeAtMs)
      : "none";
  const connectedChannels = countConnectedChannels(state);
  const liveNodes = state.nodes.length;
  const activeRuns =
    state.sessionsResult?.sessions?.filter((session) => session.hasActiveRun).length ?? 0;
  const inspectorTabs = [
    {
      label: t("cockpit.skills"),
      tab: "skills" as const,
      value: `${readySkills}/${skills.length || 0}`,
    },
    { label: t("cockpit.cron"), tab: "cron" as const, value: `${enabledCronJobs}` },
    {
      label: t("cockpit.hooks"),
      tab: "automation" as const,
      value: state.eventLog.length.toString(),
    },
  ];

  return html`
    <aside class="cockpit-inspector" aria-label=${t("cockpit.runtimeInspector")}>
      <div class="cockpit-inspector__inner">
        <div class="cockpit-inspector__tabs">
          ${inspectorTabs.map(
            (entry) => html`
              <button
                type="button"
                class="cockpit-inspector-tab ${state.tab === entry.tab
                  ? "cockpit-inspector-tab--active"
                  : ""}"
                @click=${() => {
                  state.setTab(entry.tab as import("./navigation.ts").Tab);
                  if (entry.tab === "automation") {
                    state.automationActiveSection = "hooks";
                  }
                }}
              >
                <span>${entry.label}</span>
                <strong>${entry.value}</strong>
              </button>
            `,
          )}
        </div>

        <section class="cockpit-card cockpit-card--access">
          <div class="cockpit-card__head">
            <span>${t("cockpit.gateway")}</span>
            <span class="cockpit-status ${state.connected ? "cockpit-status--ok" : ""}">
              ${state.connected ? t("common.online") : t("common.offline")}
            </span>
          </div>
          <div class="cockpit-gateway-url" title=${state.settings.gatewayUrl}>
            ${state.settings.gatewayUrl || t("cockpit.currentOrigin")}
          </div>
          <div class="cockpit-metric-grid">
            <button
              type="button"
              class="cockpit-metric"
              @click=${() => state.setTab("channels" as import("./navigation.ts").Tab)}
            >
              <span>${connectedChannels}</span>
              <small>${t("cockpit.channels")}</small>
            </button>
            <button
              type="button"
              class="cockpit-metric"
              @click=${() => state.setTab("nodes" as import("./navigation.ts").Tab)}
            >
              <span>${liveNodes}</span>
              <small>${t("cockpit.nodes")}</small>
            </button>
            <button
              type="button"
              class="cockpit-metric"
              @click=${() => state.setTab("sessions" as import("./navigation.ts").Tab)}
            >
              <span>${activeRuns}</span>
              <small>${t("cockpit.runs")}</small>
            </button>
          </div>
        </section>

        <section class="cockpit-card">
          <div class="cockpit-card__head">
            <span>${t("cockpit.skills")}</span>
            <button
              type="button"
              class="cockpit-link-button"
              @click=${() => state.setTab("skills" as import("./navigation.ts").Tab)}
            >
              ${t("cockpit.manage")}
            </button>
          </div>
          <div class="cockpit-list">
            ${skills.slice(0, 5).map(
              (skill) => html`
                <div class="cockpit-list-row">
                  <span class="cockpit-list-row__icon">${skill.emoji || "•"}</span>
                  <span class="cockpit-list-row__text">
                    <strong>${skill.name}</strong>
                    <small
                      >${skill.disabled
                        ? t("cockpit.skillStateDisabled")
                        : skill.eligible
                          ? t("cockpit.skillStateReady")
                          : t("cockpit.skillStateNeedsSetup")}</small
                    >
                  </span>
                </div>
              `,
            )}
            ${skills.length
              ? nothing
              : html`<div class="cockpit-empty">${t("cockpit.noSkillSnapshot")}</div>`}
          </div>
          ${blockedSkills
            ? html`<div class="cockpit-note">
                ${t("cockpit.blockedSkills", { count: String(blockedSkills) })}
              </div>`
            : nothing}
        </section>

        <section class="cockpit-card">
          <div class="cockpit-card__head">
            <span>${t("cockpit.automation")}</span>
            <button
              type="button"
              class="cockpit-link-button"
              @click=${() => state.setTab("cron" as import("./navigation.ts").Tab)}
            >
              ${t("cockpit.schedule")}
            </button>
          </div>
          <div class="cockpit-automation-row">
            <span class="cockpit-automation-row__icon" aria-hidden="true">${icons.loader}</span>
            <span>
              <strong>${t("cockpit.cronJobs", { count: String(enabledCronJobs) })}</strong>
              <small>${t("cockpit.nextWake", { time: nextCron })}</small>
            </span>
          </div>
          <div class="cockpit-automation-row">
            <span class="cockpit-automation-row__icon" aria-hidden="true">${icons.terminal}</span>
            <span>
              <strong>${t("cockpit.hooks")}</strong>
              <small
                >${t("cockpit.recentUiEvents", { count: String(state.eventLog.length) })}</small
              >
            </span>
          </div>
        </section>
      </div>
    </aside>
  `;
}
