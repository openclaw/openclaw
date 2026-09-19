import type { ReactiveController, ReactiveControllerHost, ReactiveElement } from "lit";
import type { ApplicationContext } from "../app/context.ts";
import type { SidebarVisibleSections } from "./app-sidebar-session-projection.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";

type PinFocusHost = HTMLElement &
  ReactiveControllerHost & {
    sessionDataContext: Pick<ApplicationContext, "gateway" | "agentSelection"> | undefined;
    findSidebarSessionByKey(key: string): SidebarRecentSession | undefined;
  };

/** Preserve native pin controls across the sidebar's separate render sections. */
export class SidebarSessionPinFocusController implements ReactiveController {
  private renderedContext: PinFocusHost["sessionDataContext"];
  private renderedClient: ApplicationContext["gateway"]["snapshot"]["client"] = null;
  private pending: { key: string; sessionId: string; selector: string } | undefined;

  constructor(
    private readonly host: PinFocusHost,
    private readonly projection: () => SidebarVisibleSections,
  ) {
    host.addController(this);
  }

  hostUpdate(): void {
    this.pending = undefined;
    const { host } = this;
    const context = host.sessionDataContext;
    const active = host.ownerDocument.activeElement;
    const row = active?.closest<HTMLElement>("[data-session-key]");
    const selector = ["[data-session-menu]", "[data-sidebar-session-pin]"].find((candidate) =>
      active?.matches(candidate),
    );
    if (
      !selector ||
      !row ||
      row.closest("openclaw-app-sidebar") !== host ||
      row.dataset.catalogSessionKey ||
      context !== this.renderedContext ||
      context?.gateway.snapshot.client !== this.renderedClient
    ) {
      return;
    }
    const session = host.findSidebarSessionByKey(row.dataset.sessionKey ?? "");
    if (
      session?.sessionId &&
      session.sessionId === row.dataset.sessionId &&
      session.pinned !== row.classList.contains("session-row-host--pinned")
    ) {
      this.pending = { key: session.key, sessionId: session.sessionId, selector };
    }
  }

  hostUpdated(): void {
    const { host, pending } = this;
    this.pending = undefined;
    this.renderedContext = host.sessionDataContext;
    this.renderedClient = this.renderedContext?.gateway.snapshot.client ?? null;
    if (!pending || !host.isConnected) {
      return;
    }
    const context = this.renderedContext;
    const client = this.renderedClient;
    const canRestore = () =>
      host.isConnected &&
      host.sessionDataContext === context &&
      context?.gateway.snapshot.client === client &&
      host.ownerDocument.activeElement === host.ownerDocument.body &&
      host.findSidebarSessionByKey(pending.key)?.sessionId === pending.sessionId;
    // The roster owns a child render; resolve its replacement control afterward.
    queueMicrotask(() => {
      if (!canRestore()) {
        return;
      }
      const row = [...host.querySelectorAll<HTMLElement>("[data-session-key]")].find(
        (element) =>
          element.dataset.sessionKey === pending.key &&
          element.dataset.sessionId === pending.sessionId &&
          !element.dataset.catalogSessionKey &&
          element.closest("openclaw-app-sidebar") === host,
      );
      let target = row?.querySelector<HTMLElement>(pending.selector);
      if (!row) {
        // The projection retains collapsed membership; it owns grouping policy.
        const section = this.projection().sections.find((candidate) =>
          candidate.rows.some(
            (session) => session.key === pending.key && session.sessionId === pending.sessionId,
          ),
        );
        target = [...host.querySelectorAll<HTMLElement>("[data-session-section]")]
          .find((element) => element.dataset.sessionSection === section?.id)
          ?.querySelector<HTMLElement>('.sidebar-session-group-toggle[aria-expanded="false"]');
        if (
          !target &&
          this.projection().expandedRows.some(
            (session) => session.key === pending.key && session.sessionId === pending.sessionId,
          )
        ) {
          // A paged-out row has no control; keep keyboard navigation in Sessions.
          target = host.querySelector<HTMLElement>(".sidebar-session-sort");
        }
      }
      const restoreFocus = () => {
        // Contextual sidebars hide Sessions while keeping pinned nav rows visible.
        const visibleTarget = target?.checkVisibility()
          ? target
          : host.querySelector<HTMLElement>(".sidebar-nav__head-action");
        if (visibleTarget?.checkVisibility() && canRestore()) {
          visibleTarget.focus({ preventScroll: true });
        }
      };
      // A new tooltip must render its slot before its button can receive focus.
      const tooltip = target?.closest<ReactiveElement>("openclaw-tooltip");
      if (tooltip) {
        void tooltip.updateComplete.then(restoreFocus);
      } else {
        restoreFocus();
      }
    });
  }

  hostDisconnected(): void {
    this.pending = undefined;
    this.renderedContext = undefined;
    this.renderedClient = null;
  }
}
