import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  CATALOG_SESSION_RELEASED_EVENT,
  CATALOG_SESSION_RELEASE_RECONCILE_DELAYS_MS,
  catalogSessionReleasedDetailFromEvent,
  parseCatalogSessionKey,
  type CatalogSessionKey,
} from "../../lib/sessions/catalog-key.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";

type ReconcileContext = {
  connected: boolean;
  client: GatewayBrowserClient;
  sessionKey: string;
  agentId: string;
};

/** Refreshes one retained catalog pane after its own native writer exits. */
export class ChatCatalogReleaseReconciler {
  private timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private generation = 0;

  constructor(
    private readonly deps: {
      current(): ReconcileContext | null;
      load(key: CatalogSessionKey): Promise<boolean>;
    },
  ) {}

  connect(): () => void {
    document.addEventListener(CATALOG_SESSION_RELEASED_EVENT, this.handle);
    return () => {
      document.removeEventListener(CATALOG_SESSION_RELEASED_EVENT, this.handle);
      this.clear();
    };
  }

  private readonly handle = (event: Event) => {
    const context = this.deps.current();
    const key = parseCatalogSessionKey(context?.sessionKey ?? "");
    const detail = catalogSessionReleasedDetailFromEvent(event);
    if (
      !context?.connected ||
      !key ||
      !detail?.threadId ||
      key.catalogId !== detail.catalogId ||
      key.hostId !== detail.hostId ||
      key.threadId !== detail.threadId ||
      context.agentId !== normalizeAgentId(detail.agentId)
    ) {
      return;
    }
    this.clear();
    const generation = this.generation;
    const { agentId, client, sessionKey } = context;
    const reconcile = (attempt: number) => {
      this.timer = globalThis.setTimeout(() => {
        this.timer = null;
        if (generation !== this.generation) {
          return;
        }
        const current = this.deps.current();
        const currentKey = parseCatalogSessionKey(current?.sessionKey ?? "");
        if (
          !current?.connected ||
          current.client !== client ||
          current.sessionKey !== sessionKey ||
          current.agentId !== agentId
        ) {
          return;
        }
        if (!currentKey) {
          return;
        }
        void this.deps.load(currentKey).then(() => {
          if (
            generation === this.generation &&
            attempt + 1 < CATALOG_SESSION_RELEASE_RECONCILE_DELAYS_MS.length
          ) {
            reconcile(attempt + 1);
          }
        });
      }, CATALOG_SESSION_RELEASE_RECONCILE_DELAYS_MS[attempt]);
    };
    reconcile(0);
  };

  private clear(): void {
    this.generation += 1;
    if (this.timer !== null) {
      globalThis.clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
