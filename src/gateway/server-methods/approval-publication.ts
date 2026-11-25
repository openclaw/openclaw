// Best-effort legacy approval resolution events after durable CAS wins.
import type { ExecApprovalForwarder } from "../../infra/exec-approval-forwarder.js";
import type {
  ExecApprovalRequestPayload,
  ExecApprovalResolved,
} from "../../infra/exec-approvals.js";
import type {
  PluginApprovalRequestPayload,
  PluginApprovalResolved,
} from "../../infra/plugin-approvals.js";
import type {
  SystemAgentApprovalRequestPayload,
  SystemAgentApprovalResolved,
} from "../../infra/system-agent-approvals.js";
import type { ExecApprovalRecord } from "../exec-approval-manager.js";
import type { OperatorApprovalRecord } from "../operator-approval-store.js";
import { broadcastApprovalResolvedEvent } from "./approval-shared.js";
import type { GatewayRequestContext } from "./types.js";

type ApprovalRequest =
  | ExecApprovalRequestPayload
  | PluginApprovalRequestPayload
  | SystemAgentApprovalRequestPayload;

export type ExecApprovalIosPushDelivery = {
  handleResolved?: (resolved: ExecApprovalResolved) => Promise<void>;
};

export type PluginApprovalIosPushDelivery = {
  handleResolved?: (resolved: PluginApprovalResolved) => Promise<void>;
};

export async function publishAppliedApprovalResolution(params: {
  record: OperatorApprovalRecord;
  liveRecord: ExecApprovalRecord<ApprovalRequest>;
  context: GatewayRequestContext;
  forwarder?: ExecApprovalForwarder;
  iosPushDelivery?: ExecApprovalIosPushDelivery;
  pluginIosPushDelivery?: PluginApprovalIosPushDelivery;
}): Promise<void> {
  const runSideEffect = async (
    effect: "broadcast" | "forwarder" | "ios-push" | "web-push",
    run: () => void | Promise<void>,
  ) => {
    const approvalKind = params.record.kind;
    try {
      await run();
    } catch (error) {
      params.context.logGateway?.error?.(
        `${approvalKind} approvals: unified resolve ${effect} failed: ${String(error)}`,
      );
    }
  };
  const decision = params.record.decision ?? "deny";
  const resolvedBy = params.liveRecord.resolvedBy ?? null;
  const ts = params.record.resolvedAtMs ?? Date.now();
  const event = {
    id: params.record.id,
    decision,
    resolvedBy,
    ts,
    request: params.liveRecord.request,
    ...(params.record.kind === "system-agent" &&
    (params.record.status === "expired" || params.record.status === "cancelled")
      ? { terminalStatus: params.record.status }
      : {}),
  };
  await runSideEffect("broadcast", () =>
    broadcastApprovalResolvedEvent({
      approvalKind: params.record.kind,
      context: params.context,
      event,
      record: params.liveRecord,
    }),
  );
  const nativeApprovalKind = params.record.kind;
  // Native approval routes are instance-local, so publish the canonical CAS
  // winner directly instead of reconnecting to the Gateway over WebSocket.
  if (nativeApprovalKind !== "system-agent" || params.record.status !== "allowed") {
    try {
      params.context.approvalEvents?.publishResolved(nativeApprovalKind, event);
    } catch (error) {
      params.context.logGateway?.error?.(
        `${nativeApprovalKind} approvals: unified resolve internal-subscriber failed: ${String(error)}`,
      );
    }
  }
  const webPushDelivery = params.context.approvalWebPushDelivery;
  if (webPushDelivery && (nativeApprovalKind === "exec" || nativeApprovalKind === "plugin")) {
    await runSideEffect("web-push", () =>
      params.record.status === "expired"
        ? webPushDelivery.handleExpired(params.liveRecord)
        : webPushDelivery.handleResolved(event),
    );
  }
  if (params.record.kind === "exec" && params.forwarder) {
    await runSideEffect("forwarder", () =>
      params.forwarder!.handleResolved(event as ExecApprovalResolved),
    );
  }
  if (params.record.kind === "exec" && params.iosPushDelivery?.handleResolved) {
    await runSideEffect("ios-push", () =>
      params.iosPushDelivery!.handleResolved!(event as ExecApprovalResolved),
    );
  }
  if (params.record.kind === "plugin" && params.forwarder?.handlePluginApprovalResolved) {
    await runSideEffect("forwarder", () =>
      params.forwarder!.handlePluginApprovalResolved!(event as PluginApprovalResolved),
    );
  }
  if (params.record.kind === "plugin" && params.pluginIosPushDelivery?.handleResolved) {
    await runSideEffect("ios-push", () =>
      params.pluginIosPushDelivery!.handleResolved!(event as PluginApprovalResolved),
    );
  }
  // Decisions (allowed or denied) report their outcome from the system-agent owner.
  if (
    params.record.kind === "system-agent" &&
    (params.record.status === "expired" || params.record.status === "cancelled") &&
    params.forwarder?.handleSystemAgentApprovalResolved
  ) {
    await runSideEffect("forwarder", () =>
      // SAFETY: a system-agent record's live request is a system-agent payload.
      params.forwarder!.handleSystemAgentApprovalResolved!(event as SystemAgentApprovalResolved),
    );
  }
}
