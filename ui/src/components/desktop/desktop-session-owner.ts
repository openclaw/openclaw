import type {
  DesktopAvailability,
  DesktopSource,
  EnvironmentSummary,
} from "@openclaw/gateway-protocol";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { readSessionChangedEvent } from "../../lib/sessions/reconcile.ts";
import type { SessionCapability } from "../../lib/sessions/session-capability.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import { resolveChatPaneDesktopTarget } from "../../pages/chat/chat-pane-placement.ts";
import { loadDesktopEnvironments } from "./desktop-source.ts";

type DesktopSessionContext = {
  isConnected: boolean;
  client: GatewayBrowserClient | null;
  sessions: Pick<SessionCapability, "describe"> | undefined;
  available: boolean;
  documentMode: boolean;
  embedded: boolean;
  requestedSource: string | null;
  sessionKey: string | null;
  suppliedEnvironments: readonly EnvironmentSummary[] | null;
};

type NodeAvailability = {
  client: GatewayBrowserClient;
  nodeId: string;
  availability: DesktopAvailability | undefined;
};

type DesktopInventory = Awaited<ReturnType<typeof loadDesktopEnvironments>>;
type DesktopStartup = {
  load: () => Promise<DesktopInventory>;
  isCurrent: () => boolean;
  resolve: (inventory: DesktopInventory) => void;
  reject: (error: unknown) => void;
  busy: boolean;
};

/** Synchronous admission for desktop inventory, availability, and session targets. */
export class DesktopSessionOwner {
  private refreshId = 0;
  private desktopSource: NodeAvailability | null = null;
  private availabilitySnapshot: NodeAvailability | null = null;
  private startup: DesktopStartup | undefined;
  startupEnvironment: EnvironmentSummary | undefined;
  private startupTimer: ReturnType<typeof globalThis.setInterval> | undefined;

  constructor(
    private readonly context: DesktopSessionContext,
    private readonly notify: () => void,
    private readonly currentTarget: () => string | null,
    private readonly onTargetChange: (target: string | null) => void,
    private readonly onInventoryChange: () => void,
    private readonly requestedAvailabilityTarget: () => string | null,
    private readonly onTargetError: (error: unknown) => void,
  ) {}

  subscribe(client: GatewayBrowserClient): () => void {
    return client.addEventListener((event) => {
      if (!this.context.isConnected || !this.context.available || client !== this.context.client) {
        return;
      }
      if (event.event === "node.runnerInventory.changed") {
        const payload = event.payload;
        if (isRecord(payload) && typeof payload.nodeId === "string" && payload.nodeId.length > 0) {
          if (this.availabilityTarget === `node:${payload.nodeId}`) {
            void this.refreshDesktopAvailability(payload.nodeId);
          } else {
            this.onInventoryChange();
          }
        }
        return;
      }
      if (
        event.event === "presence" ||
        event.event === "node.pair.resolved" ||
        event.event === "config.changed"
      ) {
        this.onInventoryChange();
        return;
      }
      const changed =
        this.context.documentMode &&
        this.context.sessionKey !== null &&
        this.context.requestedSource === null &&
        event.event === "sessions.changed" &&
        !(isRecord(event.payload) && event.payload.phase === "message")
          ? readSessionChangedEvent(event.payload)
          : null;
      if (changed && areUiSessionKeysEquivalent(changed.key, this.context.sessionKey)) {
        const resolution = this.resolveTarget();
        if (resolution) {
          void resolution.target
            .then((target) => {
              // Preserve live input when the exact-row refresh leaves its target unchanged.
              if (
                resolution.isCurrent() &&
                target !== undefined &&
                (target === null || target !== this.currentTarget())
              ) {
                this.onTargetChange(target);
              }
            })
            .catch((error: unknown) => {
              if (resolution.isCurrent()) {
                this.onTargetError(error);
              }
            });
        }
      }
    });
  }

  invalidate(): void {
    this.refreshId += 1;
    this.stopStartup()?.resolve(undefined);
  }

  private stopStartup(): DesktopStartup | undefined {
    globalThis.clearInterval(this.startupTimer);
    this.startupTimer = undefined;
    const startup = this.startup;
    this.startup = undefined;
    if (this.startupEnvironment) {
      this.startupEnvironment = undefined;
      this.notify();
    }
    return startup;
  }

  private async refreshStartup(): Promise<void> {
    const startup = this.startup;
    if (!startup || startup.busy) {
      return;
    }
    if (!startup.isCurrent()) {
      this.stopStartup()?.resolve(undefined);
      return;
    }
    startup.busy = true;
    try {
      const inventory = await startup.load();
      if (this.startup !== startup) {
        return;
      }
      if (!startup.isCurrent() || !inventory?.pendingSource) {
        this.stopStartup()?.resolve(startup.isCurrent() ? inventory : undefined);
      } else {
        this.startupEnvironment = inventory.environments.find(
          (environment) => environment.id === inventory.pendingSource,
        );
        this.notify();
      }
    } catch (error) {
      if (this.startup === startup) {
        this.stopStartup()?.reject(error);
      }
    } finally {
      startup.busy = false;
    }
  }

  private async waitForStartup(
    load: DesktopStartup["load"],
    isCurrent: () => boolean,
  ): Promise<DesktopInventory> {
    const inventory = await load();
    if (!isCurrent()) {
      return undefined;
    }
    if (!inventory?.pendingSource) {
      return inventory;
    }
    return await new Promise<DesktopInventory>((resolve, reject) => {
      this.startupEnvironment = inventory.environments.find(
        (environment) => environment.id === inventory.pendingSource,
      );
      this.notify();
      this.startup = { load, isCurrent, resolve, reject, busy: false };
      this.startupTimer = globalThis.setInterval(() => void this.refreshStartup(), 2_000);
    });
  }

  loadInventory(options: {
    automatic: boolean;
    target: string | null | undefined;
    refresh?: boolean;
    isCurrent: () => boolean;
  }) {
    this.invalidate();
    const client = this.context.client;
    const resolution = options.automatic
      ? this.resolveTarget(options.target, options.refresh)
      : { target: Promise.resolve(options.target), isCurrent: () => true };
    const isCurrent = () =>
      this.context.isConnected &&
      this.context.available &&
      client === this.context.client &&
      options.isCurrent() &&
      resolution?.isCurrent() === true;
    return {
      isCurrent,
      result:
        client && resolution
          ? this.waitForStartup(
              () =>
                loadDesktopEnvironments(client, {
                  target: resolution.target,
                  isCurrent,
                  recoverToPicker: this.context.documentMode && !this.context.embedded,
                }),
              isCurrent,
            )
          : Promise.resolve(undefined),
    };
  }

  setDesktopSource(source: DesktopSource, availability: DesktopAvailability | undefined): void {
    const client = this.context.client;
    const previous = this.desktopSource;
    if (
      previous &&
      (previous.client !== client || source.kind !== "node" || previous.nodeId !== source.nodeId)
    ) {
      this.clearDesktopSource();
    }
    this.desktopSource =
      client && source.kind === "node" ? { client, nodeId: source.nodeId, availability } : null;
  }

  clearDesktopSource(): void {
    this.desktopSource = null;
    this.availabilitySnapshot = null;
  }

  get desktopAvailability(): DesktopAvailability | undefined {
    const source = this.desktopSource;
    if (!source || source.client !== this.context.client) {
      return undefined;
    }
    const snapshot = this.availabilitySnapshot;
    return snapshot?.client === source.client && snapshot.nodeId === source.nodeId
      ? snapshot.availability
      : source.availability;
  }

  private get availabilityTarget(): string | null {
    if (this.desktopSource && this.desktopSource.client !== this.context.client) {
      return null;
    }
    return this.requestedAvailabilityTarget();
  }

  private async refreshDesktopAvailability(nodeId: string): Promise<void> {
    const { client } = this.context;
    if (!client) {
      return;
    }
    const environmentId = `node:${nodeId}`;
    const isCurrent = () =>
      this.context.isConnected &&
      this.context.available &&
      client === this.context.client &&
      environmentId === this.availabilityTarget;
    try {
      const environment = await client.request<EnvironmentSummary>("environments.status", {
        environmentId,
      });
      if (!isCurrent()) {
        return;
      }
      if (environment.id !== environmentId) {
        throw new Error("Desktop status returned a different environment");
      }
      // This targeted refresh is newer than the inventory that opened the viewer.
      this.availabilitySnapshot = { client, nodeId, availability: environment.desktopAvailability };
      this.notify();
    } catch {
      if (isCurrent() && this.desktopAvailability) {
        this.availabilitySnapshot = { client, nodeId, availability: { state: "unknown" } };
        this.notify();
      }
    }
  }

  resolveTarget(resolvedSessionTarget?: string | null, refresh = false) {
    const { client, sessions, sessionKey, requestedSource, documentMode } = this.context;
    if (!client) {
      return undefined;
    }
    const refreshId = ++this.refreshId;
    const isCurrent = () =>
      refreshId === this.refreshId &&
      this.context.isConnected &&
      client === this.context.client &&
      sessions === this.context.sessions &&
      sessionKey === this.context.sessionKey &&
      documentMode === this.context.documentMode &&
      this.context.available &&
      requestedSource === this.context.requestedSource;
    // Embedded presenters and placement events already carry the authoritative target.
    const target = requestedSource ?? resolvedSessionTarget;
    if (target === undefined && documentMode && sessionKey !== null && !sessions) {
      throw new Error("Desktop session capability is unavailable");
    }
    return {
      target:
        target === undefined && documentMode && sessionKey !== null && sessions
          ? sessions
              .describe({ key: sessionKey }, { client, refresh })
              .then(({ session }) => resolveChatPaneDesktopTarget(session ?? undefined))
          : Promise.resolve(target ?? (sessionKey !== null ? null : undefined)),
      // Carry this owner across both target resolution and the selected status request.
      isCurrent,
    };
  }
}
