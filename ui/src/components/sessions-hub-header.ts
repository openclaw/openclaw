import { html, nothing, type TemplateResult } from "lit";
import { shellLayoutTraits } from "../app/shell-layout-traits.ts";
import { t } from "../i18n/index.ts";
import { renderHubTabs } from "./hub-tabs.ts";

type SessionsHubTab = "sessions" | "worktrees";

type SessionsHubHeaderProps = {
  active: SessionsHubTab;
  title: unknown;
  subtitle?: unknown;
  actions?: unknown;
  onSelect: (tab: SessionsHubTab) => void;
};

export function renderSessionsHubHeader(props: SessionsHubHeaderProps): TemplateResult {
  return html`
    <section
      class="content-header content-header--settings content-header--page hub-page-header sessions-hub-header"
      ${shellLayoutTraits({ toolbarHeader: true })}
    >
      <div class="hub-page-header__title">
        <div class="page-title">${props.title}</div>
        ${props.subtitle ? html`<div class="page-subtitle">${props.subtitle}</div>` : nothing}
      </div>
      <div class="hub-page-header__tabs">
        ${renderHubTabs<SessionsHubTab>({
          id: "sessions",
          active: props.active,
          tabs: [
            { value: "sessions", label: t("tabs.sessions") },
            { value: "worktrees", label: t("tabs.worktrees") },
          ],
          ariaLabel: t("sessionsPage.hubTablistLabel"),
          panelId: "sessions-hub-panel",
          onSelect: props.onSelect,
        })}
      </div>
      <div class="hub-page-header__actions">${props.actions ?? nothing}</div>
    </section>
  `;
}
