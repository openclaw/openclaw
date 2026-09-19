import {
  type CatalogSessionContinuedDetail,
  catalogSessionReleasedDetailFromEvent,
  CATALOG_SESSION_RELEASE_RECONCILE_DELAYS_MS,
} from "../lib/sessions/catalog-key.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";
import {
  applySessionCatalogContinuation,
  requestSessionCatalogRefresh,
  type SessionCatalogDataOwner,
} from "./session-data-controller-catalog.ts";

/** Reconciles the sidebar catalog after a scoped native terminal writer exits. */
export class SessionCatalogReleaseReconciler {
  private timer: ReturnType<typeof globalThis.setTimeout> | null = null;

  constructor(private readonly owner: SessionCatalogDataOwner) {}

  readonly handleContinued = (event: CustomEvent<CatalogSessionContinuedDetail>) => {
    applySessionCatalogContinuation(this.owner, event.detail);
  };

  readonly handle = (event: Event) => {
    const detail = catalogSessionReleasedDetailFromEvent(event);
    const rawAgentId = detail?.agentId.trim() ?? "";
    const eventAgentId = rawAgentId ? normalizeAgentId(rawAgentId) : null;
    const currentAgentId = this.owner.sessionCatalogAgentId
      ? normalizeAgentId(this.owner.sessionCatalogAgentId)
      : null;
    const ownsHost = this.owner.sessionCatalogs
      .find((catalog) => catalog.id === detail?.catalogId)
      ?.hosts.some((host) => host.hostId === detail?.hostId);
    if (!detail || !eventAgentId || eventAgentId !== currentAgentId || !ownsHost) {
      return;
    }
    this.clear();
    const client = this.owner.sessionCatalogGatewayClient();
    const generation = this.owner.sessionScopeGeneration;
    const reconcile = (attempt: number) => {
      this.timer = globalThis.setTimeout(() => {
        this.timer = null;
        if (
          client !== this.owner.sessionCatalogGatewayClient() ||
          generation !== this.owner.sessionScopeGeneration
        ) {
          return;
        }
        void requestSessionCatalogRefresh(this.owner);
        if (attempt + 1 < CATALOG_SESSION_RELEASE_RECONCILE_DELAYS_MS.length) {
          reconcile(attempt + 1);
        }
      }, CATALOG_SESSION_RELEASE_RECONCILE_DELAYS_MS[attempt]);
    };
    reconcile(0);
  };

  clear(): void {
    if (this.timer !== null) {
      globalThis.clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
