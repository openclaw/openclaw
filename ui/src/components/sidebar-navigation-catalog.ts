import { createMemo, createSignal, onSettled } from "solid-js";
import type { ApplicationContext } from "../app/context.ts";
import { projectAgentSelection, projectGateway } from "../lib/reactive/application.ts";
import { projectSource } from "../lib/reactive/projection.ts";
import { dashboardSessionListQuery } from "../lib/sessions/session-requests.ts";

export type SidebarNavigationCatalog = ReturnType<typeof createSidebarNavigationCatalog>;

/** Managed session queries own access, freshness, and pagination. */
export function createSidebarNavigationCatalog(
  context: ApplicationContext,
  navigationView: () => string,
  host: HTMLElement,
) {
  const [ready, setReady] = createSignal(false);
  // Solid-owned bridges create their content before inserting the host.
  onSettled(() => void setReady(true));
  const gateway = projectGateway(context.gateway);
  const selection = projectAgentSelection(context.agentSelection);
  const readScope = () =>
    [
      context.gateway.snapshot.phase === "connected" ? context.gateway.snapshot.client : undefined,
      context.agentSelection.state.scopeId ?? null,
    ] as const;
  type Scope = ReturnType<typeof readScope>;
  const sameScope = (left: Scope, right: Scope) => left[0] === right[0] && left[1] === right[1];
  const active = createMemo<Scope | null>((previous) => {
    gateway.revision();
    selection.revision();
    const scope = readScope();
    if (!ready() || scope[0] === undefined) {
      return null;
    }
    // Opening Pages retains its catalog until the connection or agent changes.
    return previous && sameScope(previous, scope)
      ? previous
      : navigationView() === "pages"
        ? scope
        : null;
  });
  const list = createMemo(() => {
    const scope = active();
    if (!scope) {
      return null;
    }
    const query = { ...dashboardSessionListQuery(scope[1]), archivedFilter: "active" as const };
    const current = () => host.isConnected && sameScope(scope, readScope());
    const snapshot = projectSource(query, {
      read: () => (current() ? context.sessions.listSnapshot(query) : null),
      subscribe: (_, notify) => {
        if (!current()) {
          return () => {};
        }
        const observation = context.sessions.observeList(query, notify);
        void observation.refresh().catch(() => undefined);
        return observation.dispose;
      },
      equality: "revision",
    });
    return { query, snapshot };
  });
  return {
    get dashboards() {
      return list()?.snapshot.read() ?? null;
    },
    loadMoreDashboards() {
      const pages = list();
      const snapshot = pages?.snapshot.read();
      if (!pages || !snapshot?.result?.hasMore || snapshot.loading) {
        return;
      }
      void context.sessions
        .refreshList({
          ...pages.query,
          append: true,
          offset: snapshot.result.nextOffset ?? snapshot.result.sessions.length,
        })
        .catch(() => undefined);
    },
  };
}
