import { html, nothing } from "lit";
import type { StartupPresentation } from "../app/startup-presentation.ts";

function renderBar(className: string, width: string) {
  return html`<span class="${className} skeleton" style="--startup-bar-width: ${width}"
    >${"\u00a0"}</span
  >`;
}

function renderSessionRow(width: number, avatar: boolean) {
  return html`
    <div class="sidebar-recent-session sidebar-recent-session--single-line">
      <div class="sidebar-recent-session__link">
        <span class="sidebar-session-indicator"
          >${avatar ? html`<span class="nav-item__icon skeleton"></span>` : nothing}</span
        >
        <span class="sidebar-recent-session__text">
          <span class="sidebar-recent-session__title-row">
            ${renderBar("sidebar-recent-session__name", `${width}%`)}
          </span>
        </span>
      </div>
    </div>
  `;
}

export function renderStartupSidebarSkeleton(presentation: StartupPresentation | undefined) {
  const assistantName = presentation?.initialAssistantName ?? "";
  return html`
    <aside class="sidebar startup-sidebar-skeleton" aria-hidden="true" inert>
      <div class="sidebar-shell">
        <div class="sidebar-brand">
          <div class="sidebar-agent-card">
            <div class="sidebar-agent-card__main">
              <span class="sidebar-agent-card__avatar skeleton"></span>
              <span class="sidebar-agent-card__text">
                <span class="sidebar-agent-card__name">
                  <span class="sidebar-agent-card__name-text skeleton">${assistantName}</span>
                </span>
              </span>
            </div>
          </div>
          <div class="sidebar-brand__actions">
            ${[0, 1, 2].map(
              () => html`
                <span class="sidebar-brand__icon sidebar-brand__header-control">
                  <span class="nav-item__icon skeleton"></span>
                </span>
              `,
            )}
          </div>
        </div>
        <div class="sidebar-shell__content">
          <div class="sidebar-shell__body">
            <div class="sidebar-nav">
              <div class="sidebar-nav__head"></div>
              <div class="nav-section__items">
                ${[44, 84, 88, 56].map(
                  (width) => html`
                    <div class="nav-item">
                      <span class="nav-item__icon skeleton"></span>
                      ${renderBar("nav-item__text", `${width}px`)}
                    </div>
                  `,
                )}
              </div>
            </div>
            <section class="sidebar-sessions">
              <div class="sidebar-session-toolbar">
                ${renderBar("sidebar-recent-sessions__label-text", "60px")}
                <span class="sidebar-session-toolbar__button sidebar-session-sort skeleton"></span>
                <span class="sidebar-session-toolbar__button skeleton"></span>
              </div>
              <div class="sidebar-recent-sessions">
                <div class="sidebar-recent-sessions__group">
                  <div class="sidebar-recent-sessions__head">
                    <div class="sidebar-session-group-toggle">
                      <span class="sidebar-session-group-toggle__lead"></span>
                      ${renderBar("sidebar-recent-sessions__label-text", "64px")}
                    </div>
                  </div>
                  <div class="sidebar-recent-sessions__list">
                    ${[78, 62, 88, 70, 84, 92, 66, 80].map((width, index) => renderSessionRow(width, index === 1 || index === 5))}
                  </div>
                </div>
              </div>
            </section>
          </div>
        </div>
        <div class="sidebar-shell__footer">
          <div class="sidebar-footer-bar sidebar-footer-bar--one-action">
            <div class="sidebar-identity-card">
              <span class="viewer-avatar viewer-avatar--footer skeleton"></span>
              <span class="sidebar-identity-card__text">
                ${renderBar("sidebar-identity-card__name", "72px")}
              </span>
            </div>
            <span class="sidebar-footer-actions">
              <span class="sidebar-brand__icon sidebar-footer-bar__home"
                ><span class="sidebar-issues-button__icon skeleton"></span
              ></span>
              <span class="sidebar-issues-button"
                ><span class="sidebar-issues-button__icon skeleton"></span
              ></span>
            </span>
          </div>
        </div>
      </div>
    </aside>
  `;
}
