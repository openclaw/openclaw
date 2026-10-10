import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import type { ReactiveController, ReactiveControllerHost } from "lit";
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

type SidebarSnapshotHost = ReactiveControllerHost & {
  sidebarSnapshot: SidebarSnapshotModel | null;
  readonly sessionDataContext?: { gateway: ApplicationGateway };
  captureSidebarSnapshot(): SidebarSnapshotModel | null;
  sidebarSnapshotSettled(): boolean;
  restoreSidebarSnapshot(model: SidebarSnapshotModel): void;
  releaseSidebarSnapshot(): void;
  clearSidebarSnapshot(): void;
};

export class SidebarSnapshotController implements ReactiveController {
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

  constructor(private readonly host: SidebarSnapshotHost) {
    host.addController(this);
  }

  hostConnected(): void {
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
    this.hostUpdate();
  }

  hostUpdate(): void {
    if (!this.cleanup.length) return;
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
          void this.store
            .readSidebar(sidebarSnapshotScopeKey(boot.scope), parseSidebarSnapshot)
            .then((model) => {
              this.hostUpdate();
              if (!current()) return;
              this.pending = false;
              if (model && !this.host.sidebarSnapshotSettled()) {
                this.host.restoreSidebarSnapshot(model);
                this.serialized = JSON.stringify(model);
                this.saved = true;
              }
              this.host.requestUpdate();
            });
        }
        this.stopGateway = gateway.subscribe(() => {
          this.hostUpdate();
          this.host.requestUpdate();
        });
      }
    }
    if (!gateway) return;
    if (gateway.connectionRevision !== this.revision) {
      this.revision = gateway.connectionRevision;
      this.retiredHello = undefined;
      this.replaceScope(null);
    }
    const snapshot = gateway.snapshot;
    if (snapshot.client?.offlineRecoveryRetired || snapshot.hello === this.retiredHello) {
      if (this.scope) this.replaceScope(null);
    } else if (snapshot.phase === "connected") {
      const recoveryScope = snapshot.hello?.auth?.recoveryScope;
      const next = recoveryScope
        ? {
            gatewayScope: gatewayCredentialScope(gateway.connection.gatewayUrl),
            recoveryScope,
            profileId: snapshot.selfUser?.id ?? null,
          }
        : null;
      if (JSON.stringify(next) !== JSON.stringify(this.scope)) this.replaceScope(next);
    }
  }

  hostUpdated(): void {
    if (!this.cleanup.length || this.pending || !this.scope || !this.host.sidebarSnapshotSettled())
      return;
    if (this.host.sidebarSnapshot) {
      // Capture only after the live renderer has replaced the saved projection.
      this.host.releaseSidebarSnapshot();
      this.saved = false;
      this.serialized = null;
      this.host.requestUpdate();
      return;
    }
    const model = this.host.captureSidebarSnapshot();
    if (!model) return;
    const serialized = JSON.stringify(model);
    if (serialized === this.serialized) {
      return;
    }
    this.serialized = serialized;
    this.saved = false;
    const current = this.captureScope();
    const key = sidebarSnapshotScopeKey(this.scope);
    void this.retirement.then(async () => {
      if (!current()) return;
      const written = await this.store.writeSidebar(key, model, parseSidebarSnapshot);
      if (written && current() && serialized === this.serialized) {
        this.saved = true;
        this.host.requestUpdate();
      }
    });
  }

  hostDisconnected(): void {
    this.cleanup.splice(0).forEach((stop) => stop());
    this.stopGateway?.();
    this.store.disconnect();
    this.gateway = undefined;
    this.scope = null;
    this.clearDisplay();
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
    this.host.requestUpdate();
  }
}
