// Builds portable APNs payloads for alerts, wakes, and approval lifecycle events.
import { Buffer } from "node:buffer";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf8Prefix } from "../utils/utf8-truncate.js";

const EXEC_APPROVAL_GENERIC_ALERT_BODY = "Open OpenClaw to review this request.";
// APNs alert body budget in UTF-8 bytes, not UTF-16 code units. The overall
// push payload must stay under 4KB, and the alert body is one of the larger
// fields. Using code units (body.length) overcounts for strings containing
// emoji or CJK characters, where each 2-unit surrogate pair is 4 UTF-8 bytes.
const PLUGIN_APPROVAL_ALERT_BODY_MAX_BYTES = 256;

function toPushMetadata(params: {
  kind: "push.test" | "node.wake";
  nodeId: string;
  reason?: string;
}): { kind: "push.test" | "node.wake"; nodeId: string; ts: number; reason?: string } {
  return {
    kind: params.kind,
    nodeId: params.nodeId,
    ts: Date.now(),
    ...(params.reason ? { reason: params.reason } : {}),
  };
}

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
    openclaw: toPushMetadata({
      kind: "push.test",
      nodeId: params.nodeId,
    }),
  };
}

export function createApnsBackgroundPayload(params: {
  nodeId: string;
  wakeReason?: string;
}): object {
  return {
    aps: {
      "content-available": 1,
    },
    openclaw: toPushMetadata({
      kind: "node.wake",
      reason: params.wakeReason ?? "node.invoke",
      nodeId: params.nodeId,
    }),
  };
}

export function resolveExecApprovalAlertBody(): string {
  return EXEC_APPROVAL_GENERIC_ALERT_BODY;
}

export function createApnsApprovalAlertPayload(params: {
  kind: "exec" | "plugin";
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
  if (Buffer.byteLength(body, "utf8") <= PLUGIN_APPROVAL_ALERT_BODY_MAX_BYTES) {
    return body;
  }
  return `${truncateUtf8Prefix(body, PLUGIN_APPROVAL_ALERT_BODY_MAX_BYTES - 3).trimEnd()}…`;
}

export function createApnsApprovalResolvedPayload(params: {
  kind: "exec" | "plugin";
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
