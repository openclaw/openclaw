import type {
  DesktopAvailability,
  DesktopSource,
  EnvironmentSummary,
} from "@openclaw/gateway-protocol";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ReactiveControllerHost } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { readSessionChangedEvent } from "../../lib/sessions/reconcile.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import { PollController } from "../../lit/poll-controller.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { resolveChatPaneDesktopTarget } from "../../pages/chat/chat-pane-placement.ts";
import { loadDesktopEnvironments } from "./desktop-source.ts";

// Keep the chat placement dependency in this lazily loaded desktop owner, outside the boot chunk.
async function resolveDesktopDocumentSessionTarget(
  client: Pick<GatewayBrowserClient, "request">,
  sessionKey: string,
): Promise<string | null> {
  // `sessions.describe` is the exact-key lookup; a paged list cannot rule out a later match.
  const session = (
    await client.request<{ session?: GatewaySessionRow | null }>("sessions.describe", {
      key: sessionKey,
    })
  ).session;
  return resolveChatPaneDesktopTarget(session ?? undefined);
}

type DesktopSessionHost = ReactiveControllerHost & {
  isConnected: boolean;
  client: GatewayBrowserClient | null;
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

export class DesktopSessionController {
  private refreshId = 0;
  private availabilityRequestId = 0;
  private desktopSource: NodeAvailability | null = null;
  private availabilitySnapshot: NodeAvailability | null = null;
  private startup: DesktopStartup | undefined;
  startupEnvironment: EnvironmentSummary | undefined;
  private readonly startupPoll: PollController;

  constructor(
    private readonly host: DesktopSessionHost,
    private readonly currentTarget: () => string | null,
    private readonly onTargetChange: (target: string | null) => void,
    private readonly onInventoryChange: () => void,
    private readonly requestedAvailabilityTarget: () => string | null,
    private readonly onTargetError: (error: unknown) => void,
  ) {
    this.startupPoll = new PollController(host, 2_000, () => void this.refreshStartup(), false);
    new SubscriptionsController(host).effect(
      () => (host.available && host.suppliedEnvironments === null ? host.client : null),
      (client) =>
        client.addEventListener((event) => {
          if (!host.isConnected || !host.available || client !== host.client) {
            return;
          }
          if (event.event === "node.runnerInventory.changed") {
            const payload = event.payload;
            if (
              isRecord(payload) &&
              typeof payload.nodeId === "string" &&
              payload.nodeId.length > 0
            ) {
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
            host.documentMode &&
            host.sessionKey !== null &&
            host.requestedSource === null &&
            event.event === "sessions.changed" &&
            !(isRecord(event.payload) && event.payload.phase === "message")
              ? readSessionChangedEvent(event.payload)
              : null;
          if (changed && areUiSessionKeysEquivalent(changed.key, host.sessionKey)) {
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
        }),
    );
  }

  invalidate(): void {
    this.refreshId += 1;
    this.stopStartup()?.resolve(undefined);
  }

  private stopStartup(): DesktopStartup | undefined {
    this.startupPoll.stop();
    const startup = this.startup;
    this.startup = undefined;
    if (this.startupEnvironment) {
      this.startupEnvironment = undefined;
      this.host.requestUpdate();
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
        this.host.requestUpdate();
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
      this.host.requestUpdate();
      this.startup = { load, isCurrent, resolve, reject, busy: false };
      this.startupPoll.start();
    });
  }

  loadInventory(options: {
    automatic: boolean;
    target: string | null | undefined;
    isCurrent: () => boolean;
  }) {
    this.invalidate();
    const client = this.host.client;
    const resolution = options.automatic
      ? this.resolveTarget(options.target)
      : { target: Promise.resolve(options.target), isCurrent: () => true };
    const isCurrent = () =>
      this.host.isConnected &&
      this.host.available &&
      client === this.host.client &&
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
                  recoverToPicker: this.host.documentMode && !this.host.embedded,
                }),
              isCurrent,
            )
          : Promise.resolve(undefined),
    };
  }

  setDesktopSource(source: DesktopSource, availability: DesktopAvailability | undefined): void {
    const client = this.host.client;
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
    this.availabilityRequestId += 1;
  }

  get desktopAvailability(): DesktopAvailability | undefined {
    const source = this.desktopSource;
    if (!source || source.client !== this.host.client) {
      return undefined;
    }
    const snapshot = this.availabilitySnapshot;
    return snapshot?.client === source.client && snapshot.nodeId === source.nodeId
      ? snapshot.availability
      : source.availability;
  }

  private get availabilityTarget(): string | null {
    if (this.desktopSource && this.desktopSource.client !== this.host.client) {
      return null;
    }
    return this.requestedAvailabilityTarget();
  }

  private async refreshDesktopAvailability(nodeId: string): Promise<void> {
    const { client } = this.host;
    if (!client) {
      return;
    }
    const environmentId = `node:${nodeId}`;
    const requestId = ++this.availabilityRequestId;
    const isCurrent = () =>
      this.host.isConnected &&
      this.host.available &&
      client === this.host.client &&
      requestId === this.availabilityRequestId &&
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
      this.host.requestUpdate();
    } catch {
      if (isCurrent() && this.desktopAvailability) {
        this.availabilitySnapshot = { client, nodeId, availability: { state: "unknown" } };
        this.host.requestUpdate();
      }
    }
  }

  resolveTarget(resolvedSessionTarget?: string | null) {
    const { client, sessionKey, requestedSource, documentMode } = this.host;
    if (!client) {
      return undefined;
    }
    const refreshId = ++this.refreshId;
    const isCurrent = () =>
      refreshId === this.refreshId &&
      this.host.isConnected &&
      client === this.host.client &&
      sessionKey === this.host.sessionKey &&
      documentMode === this.host.documentMode &&
      this.host.available &&
      requestedSource === this.host.requestedSource;
    // Embedded presenters and placement events already carry the authoritative target.
    const target = requestedSource ?? resolvedSessionTarget;
    return {
      target:
        target === undefined && documentMode && sessionKey !== null
          ? resolveDesktopDocumentSessionTarget(client, sessionKey)
          : Promise.resolve(target ?? (sessionKey !== null ? null : undefined)),
      // Carry this owner across both target resolution and the selected status request.
      isCurrent,
    };
  }
}
