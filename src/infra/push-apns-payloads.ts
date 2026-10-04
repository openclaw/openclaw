import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { ChannelApprovalKind } from "./approval-types.js";

const PLUGIN_APPROVAL_ALERT_BODY_MAX_LENGTH = 256;

export function createApnsAlertPayload(params: {
  nodeId: string;
  title: string;
  body: string;
}): object {
  return {
    aps: {
      alert: {
        title: params.title,
        body: params.body,
      },
      sound: "default",
    },
    openclaw: {
      kind: "push.test",
      nodeId: params.nodeId,
      ts: Date.now(),
    },
  };
}

export function createApnsBackgroundPayload(params: {
  nodeId: string;
  wakeReason?: string;
}): object {
  const reason = params.wakeReason ?? "node.invoke";
  return {
    aps: {
      "content-available": 1,
    },
    openclaw: {
      kind: "node.wake",
      nodeId: params.nodeId,
      ts: Date.now(),
      ...(reason ? { reason } : {}),
    },
  };
}

export function createApnsApprovalAlertPayload(params: {
  kind: ChannelApprovalKind;
  approvalId: string;
  gatewayDeviceId: string;
  title: string;
  body: string;
  category: string;
}): object {
  return {
    aps: {
      alert: {
        title: params.title,
        body: params.body,
      },
      sound: "default",
      category: params.category,
      "content-available": 1,
    },
    openclaw: {
      kind: `${params.kind}.approval.requested`,
      approvalId: params.approvalId,
      gatewayDeviceId: params.gatewayDeviceId,
      ts: Date.now(),
    },
  };
}

export function resolvePluginApprovalAlertBody(description: string): string {
  const body = normalizeOptionalString(description) ?? "";
  if (body.length <= PLUGIN_APPROVAL_ALERT_BODY_MAX_LENGTH) {
    return body;
  }
  return `${truncateUtf16Safe(body, PLUGIN_APPROVAL_ALERT_BODY_MAX_LENGTH - 1).trimEnd()}…`;
}

export function createApnsApprovalResolvedPayload(params: {
  kind: ChannelApprovalKind;
  approvalId: string;
  gatewayDeviceId: string;
}): object {
  return {
    aps: {
      "content-available": 1,
    },
    openclaw: {
      kind: `${params.kind}.approval.resolved`,
      approvalId: params.approvalId,
      gatewayDeviceId: params.gatewayDeviceId,
      ts: Date.now(),
    },
  };
}
