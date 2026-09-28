import type {
  SessionCapability,
  SessionListScope,
  SessionListSnapshot,
} from "../lib/sessions/session-capability.ts";

const QUERY = {
  includeOwnerSessionCounts: true,
  limit: 1,
  includeDerivedTitles: false,
  includeLastMessage: false,
  includeGlobal: false,
  includeUnknown: false,
  excludeSubagents: true,
  excludeCron: true,
  excludeSystem: true,
} as const satisfies SessionListScope;

/** Presentation adapter for one complete, access-scoped managed-list facet. */
export class SidebarOwnerSessionCounts {
  counts: ReadonlyMap<string, { open: number; running: number }> | null = null;
  error: string | null = null;
  private source: SessionCapability | undefined;
  private viewerId: string | null = null;
  private observation: ReturnType<SessionCapability["observeList"]> | null = null;
  private accept: (() => void) | null = null;

  constructor(private readonly changed: () => void) {}

  synchronize(sessions: SessionCapability | undefined, viewerId: string | null): void {
    if (this.source === sessions && (!sessions || this.viewerId === viewerId)) {
      return;
    }
    const wasActive = this.source !== undefined;
    this.dispose();
    const scope = sessions?.captureConnectionScope();
    if (!sessions || !scope) {
      if (wasActive) {
        this.changed();
      }
      return;
    }
    this.source = sessions;
    this.viewerId = viewerId;
    let ready = false;
    let latest: SessionListSnapshot | undefined;
    const publish = () => {
      if (!latest || !sessions.isConnectionScopeCurrent(scope)) {
        return;
      }
      this.error = latest.error;
      if (ready && !latest.loading && !latest.error) {
        const counts = latest.result?.ownerSessionCounts;
        this.counts = counts
          ? new Map(counts.map(({ profileId, open, running }) => [profileId, { open, running }]))
          : null;
      }
      this.changed();
    };
    this.observation = sessions.observeList(QUERY, (snapshot) => {
      latest = snapshot;
      publish();
    });
    // An observation can initially replay a retained snapshot. Adopt no counts
    // until its explicit refresh settles for this viewer and connection.
    this.accept = () => {
      ready = true;
      publish();
    };
    this.refresh();
  }

  refresh(): void {
    const observation = this.observation;
    const settled = () => {
      if (this.observation === observation) {
        this.accept?.();
      }
    };
    // Failure is published by the observation. Once the initial attempt settles,
    // a later event-driven successful refresh may also recover the display.
    void observation?.refresh().then(settled, settled);
  }

  dispose(): void {
    this.observation?.dispose();
    this.observation = null;
    this.source = undefined;
    this.viewerId = null;
    this.accept = null;
    this.counts = null;
    this.error = null;
  }
}
