// Routes node connection alerts to the Mac most recently used by the operator.
import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { GatewayScheduler, GatewaySchedulerScope } from "../infra/gateway-scheduler.js";
import type { NodeRegistry, NodeSession } from "./node-registry.js";

type NotificationRegistry = Pick<
  NodeRegistry,
  "listCurrentConnected" | "isConnectionCurrentPairingState" | "invoke"
>;

type PendingConnectionAlert = {
  nodeId: string;
  connId: string;
  pairingIdentity?: string;
  pairingGeneration?: string;
};

const PRIMARY_DELAY_MS = 750;
const FALLBACK_DELAY_MS = 5_000;

function isMacNotificationNode(node: NodeSession): boolean {
  const platform = node.platform?.trim().toLowerCase() ?? "";
  return (
    (platform === "darwin" || platform.startsWith("macos")) &&
    node.commands.includes("system.notify")
  );
}

function compareActivity(left: NodeSession, right: NodeSession): number {
  const activeDelta = (right.lastActiveAtMs ?? -1) - (left.lastActiveAtMs ?? -1);
  if (activeDelta !== 0) {
    return activeDelta;
  }
  return (right.presenceUpdatedAtMs ?? -1) - (left.presenceUpdatedAtMs ?? -1);
}

function connectionLabel(node: NodeSession): string {
  const raw = normalizeOptionalString(node.displayName) ?? node.nodeId;
  return sliceUtf16Safe(raw.replace(/\s+/g, " "), 0, 80);
}

/** One Gateway-runtime router for staged first-connection alerts. */
class NodeConnectionNotificationRouter {
  private readonly pendingByNodeId = new Map<string, PendingConnectionAlert>();

  constructor(
    private readonly registry: NotificationRegistry,
    private readonly scheduler: GatewaySchedulerScope,
  ) {}

  onConnected(source: NodeSession, isFirstConnection: boolean): void {
    // A rapid replacement may take over an already-pending first-connection alert.
    // Ordinary reconnects have no pending claim and remain silent.
    if (!isFirstConnection && !this.pendingByNodeId.has(source.nodeId)) {
      return;
    }
    const pending: PendingConnectionAlert = {
      nodeId: source.nodeId,
      connId: source.connId,
      pairingIdentity: source.pairingIdentity,
      pairingGeneration: source.pairingGeneration,
    };
    this.pendingByNodeId.set(source.nodeId, pending);
    this.scheduler.schedule({
      id: `node-connection/${pending.nodeId}`,
      delayMs: PRIMARY_DELAY_MS,
      run: () => this.deliverPrimary(pending),
    });
  }

  dispose(): void {
    this.scheduler.beginClose();
    this.pendingByNodeId.clear();
  }

  private async deliverPrimary(pending: PendingConnectionAlert): Promise<void> {
    const connected = await this.registry.listCurrentConnected();
    const source = this.currentSource(pending, connected);
    if (!source) {
      this.finishAlert(pending);
      return;
    }
    const primary = connected
      .filter(isMacNotificationNode)
      .filter((node) => node.lastActiveAtMs !== undefined)
      .toSorted(compareActivity)
      .at(0);
    const delivered = primary ? await this.notify(primary, source, pending) : false;
    if (!this.attemptIsCurrent(pending)) {
      return;
    }
    if (delivered) {
      this.finishAlert(pending);
      return;
    }
    this.scheduler.schedule({
      id: `node-connection/${pending.nodeId}`,
      delayMs: FALLBACK_DELAY_MS,
      run: () => this.deliverFallback(pending, primary?.connId),
    });
  }

  private async deliverFallback(
    pending: PendingConnectionAlert,
    attemptedConnId?: string,
  ): Promise<void> {
    const connected = await this.registry.listCurrentConnected();
    const source = this.currentSource(pending, connected);
    if (!source) {
      this.finishAlert(pending);
      return;
    }
    const targets = connected
      .filter(isMacNotificationNode)
      .filter((node) => node.connId !== attemptedConnId);
    await Promise.all(targets.map(async (node) => await this.notify(node, source, pending)));
    if (this.attemptIsCurrent(pending)) {
      this.finishAlert(pending);
    }
  }

  private currentSource(
    pending: PendingConnectionAlert,
    connected: readonly NodeSession[],
  ): NodeSession | undefined {
    if (!this.attemptIsCurrent(pending)) {
      return undefined;
    }
    return connected.find(
      (node) =>
        node.nodeId === pending.nodeId &&
        node.connId === pending.connId &&
        node.pairingIdentity === pending.pairingIdentity &&
        node.pairingGeneration === pending.pairingGeneration,
    );
  }

  private attemptIsCurrent(pending: PendingConnectionAlert): boolean {
    // Object identity lets a replacement invalidate both staged jobs and
    // in-flight deliveries without a second generation bookkeeping path.
    return !this.scheduler.signal.aborted && this.pendingByNodeId.get(pending.nodeId) === pending;
  }

  private finishAlert(pending: PendingConnectionAlert): void {
    if (this.attemptIsCurrent(pending)) {
      this.pendingByNodeId.delete(pending.nodeId);
    }
  }

  private async sourceIsCurrent(pending: PendingConnectionAlert): Promise<boolean> {
    if (!this.attemptIsCurrent(pending)) {
      return false;
    }
    const connected = await this.registry.listCurrentConnected();
    if (!this.currentSource(pending, connected)) {
      return false;
    }
    return await this.registry.isConnectionCurrentPairingState(pending.connId);
  }

  private async notify(
    target: NodeSession,
    source: NodeSession,
    pending: PendingConnectionAlert,
  ): Promise<boolean> {
    try {
      if (!(await this.sourceIsCurrent(pending)) || !this.attemptIsCurrent(pending)) {
        return false;
      }
      const result = await this.registry.invoke({
        nodeId: target.nodeId,
        expectedConnId: target.connId,
        expectedPairingGeneration: target.pairingGeneration,
        command: "system.notify",
        params: {
          title: "Node connected",
          body: `${connectionLabel(source)} connected to OpenClaw.`,
          priority: "active",
          delivery: "auto",
        },
        timeoutMs: 10_000,
        idempotencyKey: randomUUID(),
      });
      return result.ok;
    } catch {
      return false;
    }
  }
}

const routersByRegistry = new WeakMap<NodeRegistry, NodeConnectionNotificationRouter>();

/** Schedules a staged alert for one newly connected node. */
export function scheduleNodeConnectionNotification(
  registry: NodeRegistry,
  source: NodeSession,
  options: { isFirstConnection: boolean },
): void {
  routersByRegistry.get(registry)?.onConnected(source, options.isFirstConnection);
}

/** Registers the Gateway's alert owner and returns its shutdown cleanup. */
export function startNodeConnectionNotifications(
  registry: NodeRegistry,
  scheduler: GatewayScheduler,
): () => void {
  const router = new NodeConnectionNotificationRouter(registry, scheduler.scope());
  routersByRegistry.set(registry, router);
  return () => {
    router.dispose();
    routersByRegistry.delete(registry);
  };
}
