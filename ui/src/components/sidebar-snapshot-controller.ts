import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import type { ApplicationGateway } from "../app/gateway.ts";
import {
  sidebarSnapshotInvalidationMatches,
  subscribeSnapshotInvalidation,
} from "../pages/chat/session-snapshot-invalidation-events.ts";
import {
  consumeSidebarBootScope,
  sidebarSnapshotScopeKey,
  subscribeSidebarBootRetirement,
  type SidebarSnapshotScope,
} from "../pages/chat/session-snapshot-prewarm.ts";
import { SessionSnapshotStore } from "../pages/chat/session-snapshot-store.ts";
import { parseSidebarSnapshot, type SidebarSnapshotModel } from "./sidebar-snapshot-model.ts";

type SidebarSnapshotHost = {
  sidebarSnapshot: SidebarSnapshotModel | null;
  readonly sessionDataContext?: {
    gateway: ApplicationGateway;
    agentSelection: { readonly state: { readonly scopeId: string | null } };
  };
  expandedAgentId(): string;
  captureSidebarSnapshot(): SidebarSnapshotModel | null;
  sidebarSnapshotSettled(): boolean;
  restoreSidebarSnapshot(model: SidebarSnapshotModel): void;
  releaseSidebarSnapshot(): void;
  clearSidebarSnapshot(): void;
};

export class SidebarSnapshotController {
  private readonly listeners = new Set<() => void>();
  pending = false;
  saved = false;
  private readonly store = new SessionSnapshotStore();
  private gateway: ApplicationGateway | undefined;
  private revision = -1;
  private scope: SidebarSnapshotScope | null = null;
  private generation = 0;
  private serialized: string | null = null;
  private retirement = Promise.resolve();
  private cleanup: Array<() => void> = [];
  private stopGateway: (() => void) | undefined;
  private retiredHello: ApplicationGateway["snapshot"]["hello"] | undefined;

  constructor(private readonly host: SidebarSnapshotHost) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  connect(): void {
    this.store.connect();
    this.cleanup = [
      subscribeSnapshotInvalidation((event) => {
        if (
          this.scope &&
          sidebarSnapshotInvalidationMatches(sidebarSnapshotScopeKey(this.scope), event)
        ) {
          this.clearDisplay();
        }
      }),
      subscribeSidebarBootRetirement(
        () => this.scope,
        () => {
          this.retiredHello = this.gateway?.snapshot.hello;
          this.replaceScope(null);
        },
      ),
    ];
    this.synchronize();
  }

  synchronize(): void {
    if (!this.cleanup.length) {
      return;
    }
    const gateway = this.host.sessionDataContext?.gateway;
    if (gateway !== this.gateway) {
      this.stopGateway?.();
      this.replaceScope(null);
      this.gateway = gateway;
      this.revision = gateway?.connectionRevision ?? -1;
      this.retiredHello = undefined;
      if (gateway) {
        const boot = consumeSidebarBootScope(gateway);
        if (boot?.revision === this.revision) {
          this.scope = boot.scope;
          this.pending = true;
          const current = this.captureScope();
          void boot.snapshot.then((model) => {
            this.synchronize();
            if (!current()) {
              return;
            }
            this.pending = false;
            if (model && this.matchesAgent(model) && !this.host.sidebarSnapshotSettled()) {
              this.host.restoreSidebarSnapshot(model);
              this.serialized = JSON.stringify(model);
              this.saved = true;
            }
            this.notify();
          });
        }
        this.stopGateway = gateway.subscribe(() => {
          this.synchronize();
          this.notify();
        });
      }
    }
    if (!gateway) {
      return;
    }
    if (gateway.connectionRevision !== this.revision) {
      this.revision = gateway.connectionRevision;
      this.retiredHello = undefined;
      this.replaceScope(null);
    }
    const snapshot = gateway.snapshot;
    if (this.host.sidebarSnapshot && !this.matchesAgent(this.host.sidebarSnapshot)) {
      this.clearDisplay();
    }
    if (this.pending && this.host.sidebarSnapshotSettled()) {
      this.generation += 1;
      this.pending = false;
    }
    if (snapshot.client?.offlineRecoveryRetired || snapshot.hello === this.retiredHello) {
      if (this.scope) {
        this.replaceScope(null);
      }
    } else if (snapshot.phase === "connected") {
      const recoveryScope = snapshot.hello?.auth?.recoveryScope;
      const next = recoveryScope
        ? {
            gatewayScope: gatewayCredentialScope(gateway.connection.gatewayUrl),
            recoveryScope,
            profileId: snapshot.selfUser?.id ?? null,
          }
        : null;
      if (JSON.stringify(next) !== JSON.stringify(this.scope)) {
        this.replaceScope(next);
      }
    }
    if (this.host.sidebarSnapshot && this.host.sidebarSnapshotSettled()) {
      // Release before rendering so a failed refresh cannot leave cached controls painted.
      this.host.releaseSidebarSnapshot();
      this.saved = false;
      this.serialized = null;
    }
  }

  capture(): void {
    if (
      !this.cleanup.length ||
      this.pending ||
      !this.scope ||
      this.host.sidebarSnapshot ||
      !this.host.sidebarSnapshotSettled()
    ) {
      return;
    }
    const model = this.host.captureSidebarSnapshot();
    if (!model) {
      return;
    }
    const serialized = JSON.stringify(model);
    if (serialized === this.serialized) {
      return;
    }
    this.serialized = serialized;
    this.saved = false;
    const current = this.captureScope();
    const key = sidebarSnapshotScopeKey(this.scope);
    void this.retirement.then(async () => {
      if (!current()) {
        return;
      }
      const written = await this.store.writeSidebar(key, model, parseSidebarSnapshot);
      if (written && current() && serialized === this.serialized) {
        this.saved = true;
        this.notify();
      }
    });
  }

  disconnect(): void {
    this.cleanup.splice(0).forEach((stop) => stop());
    this.stopGateway?.();
    this.store.disconnect();
    this.gateway = undefined;
    this.scope = null;
    this.clearDisplay();
  }

  private matchesAgent(model: SidebarSnapshotModel): boolean {
    return (
      (model.mode !== "chip" || model.roster?.agentId === this.host.expandedAgentId()) &&
      (model.navigationView !== "pages" ||
        model.pageScopeId === this.host.sessionDataContext?.agentSelection.state.scopeId)
    );
  }

  private captureScope(): () => boolean {
    const generation = this.generation;
    const gateway = this.gateway;
    const revision = this.revision;
    return () =>
      generation === this.generation &&
      gateway === this.host.sessionDataContext?.gateway &&
      revision === gateway?.connectionRevision;
  }

  private replaceScope(next: SidebarSnapshotScope | null): void {
    const previous = this.scope;
    this.scope = next;
    this.clearDisplay();
    if (previous) {
      // A new hello may reuse this key; its writes must follow the old deletion.
      this.retirement = Promise.all([
        this.retirement,
        this.store.delete(sidebarSnapshotScopeKey(previous)),
      ]).then(() => undefined);
    }
  }

  private clearDisplay(): void {
    this.generation += 1;
    this.pending = this.saved = false;
    this.serialized = null;
    this.host.clearSidebarSnapshot();
    this.notify();
  }
}
