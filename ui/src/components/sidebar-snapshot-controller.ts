import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { ApplicationContext } from "../app/context.ts";
import type { ApplicationGateway } from "../app/gateway.ts";
import {
  sidebarSnapshotInvalidationMatches,
  subscribeSnapshotInvalidation,
} from "../pages/chat/session-snapshot-invalidation-events.ts";
import {
  consumePrewarmedSidebarSnapshot,
  subscribeSidebarBootRetirement,
} from "../pages/chat/sidebar-snapshot-prewarm.ts";
import {
  SidebarSnapshotStore,
  sidebarSnapshotScopeKey,
  type SidebarSnapshotScope,
} from "../pages/chat/sidebar-snapshot-store.ts";
import { parseSidebarSnapshot, type SidebarSnapshotModel } from "./sidebar-snapshot-model.ts";

type SidebarSnapshotHost = ReactiveControllerHost & {
  sidebarSnapshot: SidebarSnapshotModel | null;
  readonly sessionDataContext?: Pick<ApplicationContext, "gateway">;
  captureSidebarSnapshot(): SidebarSnapshotModel | null;
  sidebarSnapshotSettled(): boolean;
  restoreSidebarSnapshot(model: SidebarSnapshotModel): void;
  releaseSidebarSnapshot(): void;
  clearSidebarSnapshot(): void;
};

export class SidebarSnapshotController implements ReactiveController {
  pending = false;
  saved = false;
  private connected = false;
  private gateway: ApplicationGateway | undefined;
  private revision = -1;
  private scope: SidebarSnapshotScope | null = null;
  private generation = 0;
  private serialized: string | null = null;
  private store: SidebarSnapshotStore<SidebarSnapshotModel> | null = null;
  private retirement = Promise.resolve();
  private stopGateway: (() => void) | undefined;
  private stopInvalidation: (() => void) | undefined;
  private stopBootRetirement: (() => void) | undefined;
  private stopPrewarm: (() => void) | undefined;
  private retiredAdmission:
    | (Pick<ApplicationGateway["snapshot"], "client" | "hello"> & { revision: number })
    | null = null;

  constructor(private readonly host: SidebarSnapshotHost) {
    host.addController(this);
  }

  hostConnected(): void {
    this.connected = true;
    this.store = new SidebarSnapshotStore(parseSidebarSnapshot);
    this.stopInvalidation = subscribeSnapshotInvalidation((invalidation) => {
      const key = this.scope && sidebarSnapshotScopeKey(this.scope);
      if (key && sidebarSnapshotInvalidationMatches(key, invalidation)) {
        this.clearDisplay();
      }
    });
    this.stopBootRetirement = subscribeSidebarBootRetirement(
      () => this.scope,
      () => {
        if (this.gateway) {
          const { client, hello } = this.gateway.snapshot;
          this.retiredAdmission = { client, hello, revision: this.gateway.connectionRevision };
        }
        this.replaceScope(null);
      },
    );
    this.synchronizeGateway();
  }

  hostUpdate(): void {
    if (this.connected) {
      this.synchronizeGateway();
      this.synchronizeScope();
    }
  }

  hostUpdated(): void {
    if (
      !this.connected ||
      this.pending ||
      !this.scope ||
      !this.store ||
      !this.host.sidebarSnapshotSettled()
    ) {
      return;
    }
    if (this.host.sidebarSnapshot) {
      // Release the projection first; capture only after the live renderer has run.
      this.host.releaseSidebarSnapshot();
      this.host.requestUpdate();
      return;
    }
    const model = parseSidebarSnapshot(this.host.captureSidebarSnapshot());
    if (!model) {
      return;
    }
    const serialized = JSON.stringify(model);
    if (serialized === this.serialized) {
      return;
    }
    this.serialized = serialized;
    this.saved = false;
    const generation = this.generation;
    const gateway = this.gateway;
    const revision = this.revision;
    const store = this.store;
    const scope = this.scope;
    const isCurrent = () =>
      this.connected &&
      this.generation === generation &&
      this.serialized === serialized &&
      this.host.sessionDataContext?.gateway === gateway &&
      gateway?.connectionRevision === revision;
    void this.retirement.then(async () => {
      if (!isCurrent()) {
        return;
      }
      await store.write(scope, model);
      if (isCurrent()) {
        this.saved = true;
        this.host.requestUpdate();
      }
    });
  }

  hostDisconnected(): void {
    this.connected = false;
    this.stopGateway?.();
    this.stopGateway = undefined;
    this.stopInvalidation?.();
    this.stopInvalidation = undefined;
    this.stopBootRetirement?.();
    this.stopBootRetirement = undefined;
    this.stopPrewarm?.();
    this.stopPrewarm = undefined;
    this.store?.dispose();
    this.store = null;
    this.gateway = undefined;
    this.retiredAdmission = null;
    this.scope = null;
    this.clearDisplay();
  }

  private synchronizeGateway(): void {
    const gateway = this.host.sessionDataContext?.gateway;
    if (this.gateway === gateway) {
      return;
    }
    this.stopGateway?.();
    this.stopPrewarm?.();
    this.replaceScope(null);
    this.gateway = gateway;
    this.retiredAdmission = null;
    if (!gateway) {
      return;
    }
    this.revision = gateway.connectionRevision;
    const prewarm = consumePrewarmedSidebarSnapshot(gateway);
    if (prewarm && prewarm.revision === this.revision) {
      this.scope = prewarm.scope;
      this.pending = true;
      this.stopPrewarm = prewarm.stop;
      const generation = this.generation;
      void prewarm.promise.then((model) => {
        this.synchronizeScope();
        if (
          !this.connected ||
          generation !== this.generation ||
          this.gateway !== gateway ||
          this.host.sessionDataContext?.gateway !== gateway
        ) {
          return;
        }
        this.pending = false;
        if (model && prewarm.isCurrent() && !this.host.sidebarSnapshotSettled()) {
          this.host.restoreSidebarSnapshot(model);
          this.serialized = JSON.stringify(model);
          this.saved = true;
        }
        prewarm.stop();
        this.stopPrewarm = undefined;
        this.host.requestUpdate();
      });
    } else {
      prewarm?.stop();
    }
    this.stopGateway = gateway.subscribe(() => {
      if (this.connected && this.gateway === gateway) {
        this.synchronizeScope();
        this.host.requestUpdate();
      }
    });
    this.synchronizeScope();
  }

  private synchronizeScope(): void {
    const gateway = this.gateway;
    if (!gateway) {
      return;
    }
    if (gateway.connectionRevision !== this.revision) {
      this.revision = gateway.connectionRevision;
      this.replaceScope(null);
    }
    const snapshot = gateway.snapshot;
    if (
      snapshot.client?.offlineRecoveryRetired ||
      (this.retiredAdmission?.revision === this.revision &&
        this.retiredAdmission.client === snapshot.client &&
        this.retiredAdmission.hello === snapshot.hello)
    ) {
      if (this.scope) {
        this.replaceScope(null);
      }
      return;
    }
    this.retiredAdmission = null;
    if (snapshot.phase !== "connected") {
      return;
    }
    const recoveryScope = snapshot.hello?.auth?.recoveryScope;
    const next = recoveryScope
      ? {
          gatewayScope: gatewayCredentialScope(gateway.connection.gatewayUrl),
          recoveryScope,
          profileId: snapshot.selfUser?.id ?? null,
        }
      : null;
    if (
      (next && sidebarSnapshotScopeKey(next)) !==
      (this.scope && sidebarSnapshotScopeKey(this.scope))
    ) {
      this.replaceScope(next);
    }
  }

  private replaceScope(next: SidebarSnapshotScope | null): void {
    const previous = this.scope;
    this.scope = next;
    this.clearDisplay();
    if (previous) {
      const invalidation = this.store?.invalidate(previous);
      if (invalidation) {
        // A fresh hello can retain the same cache key; its write follows the old deletion.
        this.retirement = Promise.all([this.retirement, invalidation]).then(() => undefined);
      }
    }
  }

  private clearDisplay(): void {
    this.generation += 1;
    this.pending = false;
    this.saved = false;
    this.serialized = null;
    this.stopPrewarm?.();
    this.stopPrewarm = undefined;
    this.host.clearSidebarSnapshot();
    this.host.requestUpdate();
  }
}
