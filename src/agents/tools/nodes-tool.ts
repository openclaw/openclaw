import crypto from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { Type } from "typebox";
import { readConnectPairingRequiredMessage } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { OperatorScope } from "../../gateway/method-scopes.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  InstalledAppListToolParamsSchema,
  InstalledAppLaunchToolParamsSchema,
} from "../../infra/installed-app-launch.js";
import { resolveNodePairApprovalScopes } from "../../infra/node-pairing-authz.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { resolveImageSanitizationLimits } from "../image-sanitization.js";
import {
  optionalFiniteNumberSchema,
  optionalNonNegativeIntegerSchema,
  optionalPositiveIntegerSchema,
  optionalStringEnum,
  stringEnum,
} from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readToolStringParam } from "./common.js";
import { gatewayCallOptionSchemaProperties } from "./gateway-schema.js";
import { callGatewayTool, readGatewayCallOptions, type GatewayCallOptions } from "./gateway.js";
import { executeNodeCommandAction } from "./nodes-tool-commands.js";
import type { InstalledAppToolContext } from "./nodes-tool-installed-apps.js";
import { callNodesToolNodeInvoke } from "./nodes-tool-invoke.js";
import { executeNodeMediaAction } from "./nodes-tool-media.js";
import { listNodes, resolveAgentNodeId } from "./nodes-utils.js";

const NODES_TOOL_ACTIONS = [
  "status",
  "describe",
  "pending",
  "approve",
  "reject",
  "notify",
  "camera_snap",
  "camera_list",
  "camera_clip",
  "camera_ptz",
  "photos_latest",
  "screen_record",
  "screen_snapshot",
  "location_get",
  "notifications_list",
  "notifications_action",
  "device_status",
  "device_info",
  "device_permissions",
  "device_health",
  "which",
  "invoke",
  "app_list",
  "app_launch",
] as const;

const NOTIFY_PRIORITIES = ["passive", "active", "timeSensitive"] as const;
const NOTIFY_DELIVERIES = ["system", "overlay", "auto"] as const;
const NOTIFICATIONS_ACTIONS = ["open", "dismiss", "reply"] as const;
const CAMERA_FACING = ["front", "back", "both"] as const;
const CAMERA_PTZ_OPERATIONS = ["status", "set", "move", "home"] as const;
const LOCATION_ACCURACY = ["coarse", "balanced", "precise"] as const;

async function resolveNodePairApproveScopes(
  gatewayOpts: GatewayCallOptions,
  requestId: string,
): Promise<OperatorScope[]> {
  const pairing: {
    pending?: Array<{
      requestId?: string;
      commands?: unknown;
      requiredApproveScopes?: unknown;
    }>;
  } = await callGatewayTool("node.pair.list", gatewayOpts, {}, { scopes: ["operator.pairing"] });
  const pending = Array.isArray(pairing?.pending) ? pairing.pending : [];
  const match = pending.find((entry) => entry?.requestId === requestId);
  if (Array.isArray(match?.requiredApproveScopes)) {
    const scopes = match.requiredApproveScopes.filter(
      (scope): scope is OperatorScope =>
        scope === "operator.pairing" || scope === "operator.write" || scope === "operator.admin",
    );
    if (scopes.length > 0) {
      return scopes;
    }
  }
  return resolveNodePairApprovalScopes(match?.commands);
}

// Flattened schema: runtime validates per-action requirements.
const NodesToolSchema = Type.Object({
  action: stringEnum(NODES_TOOL_ACTIONS),
  ...gatewayCallOptionSchemaProperties(),
  node: Type.Optional(
    Type.String({
      description:
        "Node ID, name, or IP. Required for describe and node-targeted actions; use status to discover nodes.",
    }),
  ),
  requestId: Type.Optional(Type.String()),
  // notify
  title: Type.Optional(Type.String()),
  body: Type.Optional(Type.String()),
  sound: Type.Optional(Type.String()),
  priority: optionalStringEnum(NOTIFY_PRIORITIES),
  delivery: optionalStringEnum(NOTIFY_DELIVERIES),
  // camera_snap / camera_clip / photos_latest / screen_snapshot
  facing: optionalStringEnum(CAMERA_FACING, {
    description: "camera_snap: front/back/both; camera_clip: front/back only.",
  }),
  maxWidth: optionalPositiveIntegerSchema(),
  quality: optionalFiniteNumberSchema({ minimum: 0, maximum: 1 }),
  delayMs: optionalNonNegativeIntegerSchema(),
  deviceId: Type.Optional(
    Type.String({
      description:
        "For camera_ptz, use a camera_list devices[].id value as deviceId; it is required and must not be guessed.",
    }),
  ),
  // camera_ptz
  ptzOperation: optionalStringEnum(CAMERA_PTZ_OPERATIONS, {
    description:
      "camera_ptz operation. Call status before any control operation. status and home accept no axes; set uses absolute axes; move uses axis deltas. Never guess unsupported axes.",
  }),
  panDegrees: optionalFiniteNumberSchema({
    description:
      "camera_ptz pan: set uses absolute degrees; move uses a degree delta. Omit when unsupported.",
  }),
  tiltDegrees: optionalFiniteNumberSchema({
    description:
      "camera_ptz tilt: set uses absolute degrees; move uses a degree delta. Omit when unsupported.",
  }),
  zoomPercent: optionalFiniteNumberSchema({
    description:
      "camera_ptz zoom: set uses absolute percent; move uses a percentage-point delta. Omit when unsupported.",
  }),
  limit: optionalPositiveIntegerSchema({ maximum: 20 }),
  duration: Type.Optional(Type.String()),
  durationMs: optionalPositiveIntegerSchema({ maximum: 300_000 }),
  includeAudio: Type.Optional(Type.Boolean()),
  // screen_record
  fps: optionalFiniteNumberSchema({ exclusiveMinimum: 0 }),
  screenIndex: optionalNonNegativeIntegerSchema(),
  outPath: Type.Optional(Type.String()),
  // location_get
  maxAgeMs: optionalNonNegativeIntegerSchema(),
  locationTimeoutMs: optionalPositiveIntegerSchema(),
  desiredAccuracy: optionalStringEnum(LOCATION_ACCURACY),
  // notifications_action
  notificationAction: optionalStringEnum(NOTIFICATIONS_ACTIONS),
  notificationKey: Type.Optional(Type.String()),
  notificationReplyText: Type.Optional(Type.String()),
  // which
  bins: Type.Optional(
    Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      maxItems: 64,
      description: "which: executable names to resolve on the selected node.",
    }),
  ),
  // invoke
  invokeCommand: Type.Optional(Type.String()),
  invokeParamsJson: Type.Optional(Type.String()),
  invokeTimeoutMs: optionalPositiveIntegerSchema(),
  query: Type.Optional(Type.String()),
  appId: Type.Optional(Type.String()),
  appRevision: Type.Optional(Type.String()),
});

export function createNodesTool(
  options?: {
    agentSessionKey?: string;
    agentId?: string;
    agentChannel?: string;
    agentAccountId?: string;
    currentChannelId?: string;
    currentThreadTs?: string | number;
    config?: OpenClawConfig;
    modelHasVision?: boolean;
    allowMediaInvokeCommands?: boolean;
  } & Partial<InstalledAppToolContext>,
): AnyAgentTool {
  const agentId = resolveSessionAgentId({
    sessionKey: options?.agentSessionKey,
    config: options?.config,
    agentId: options?.agentId,
  });
  const imageSanitization = resolveImageSanitizationLimits(options?.config);
  return {
    label: "Nodes",
    name: "nodes",
    description:
      "Paired nodes: status/list with active-computer presence; pass node to describe/control. Pairing lifecycle (pending/approve/reject), notify, camera_snap/camera_list/camera_clip (with audio), camera_ptz for physical camera pan/tilt/zoom, photos_latest, screen_snapshot, screen_record video, location_get, notifications_list + notifications_action (open/dismiss/reply), device_status/device_info/device_permissions/device_health, executable lookup (which + bins), generic invoke. app_list: eligible installed Linux apps on an exact node (query/limit optional). app_launch: exact node/appId/appRevision, no arguments or Gateway override; ordinary execution approvals apply; success means process-started, not window ready. File transfer is a separate capability.",
    parameters: NodesToolSchema,
    execute: async (_toolCallId, args, signal) => {
      const params = args as Record<string, unknown>;
      const action = readToolStringParam(params, "action", { required: true });
      const gatewayOpts = readGatewayCallOptions(params);

      try {
        switch (action) {
          case "app_list": {
            const request = InstalledAppListToolParamsSchema.parse(params);
            const node = (await listNodes({})).find((n) => n.nodeId === request.node);
            if (!node?.commands?.includes("device.apps")) {
              throw new Error("Exact paired node does not advertise installed-app inventory");
            }
            return jsonResult(
              await callNodesToolNodeInvoke(
                {},
                {
                  nodeId: node.nodeId,
                  command: "device.apps",
                  params: { query: request.query, limit: request.limit ?? 20, includeSystem: true },
                  idempotencyKey: crypto.randomUUID(),
                },
              ),
            );
          }
          case "app_launch": {
            const request = InstalledAppLaunchToolParamsSchema.parse(params);
            const { executeInstalledAppLaunch } = await import("./nodes-tool-installed-apps.js");
            return await executeInstalledAppLaunch(
              request,
              { ...options, agentId },
              _toolCallId,
              signal,
            );
          }
          case "status":
            return jsonResult(await callGatewayTool("node.list", gatewayOpts, {}));
          case "describe": {
            const node = readToolStringParam(params, "node");
            if (!node) {
              throw new Error(
                'node required for describe; call nodes with action="status" to list nodes, then retry with node',
              );
            }
            const nodeId = await resolveAgentNodeId(gatewayOpts, node);
            return jsonResult(await callGatewayTool("node.describe", gatewayOpts, { nodeId }));
          }
          case "pending":
            return jsonResult(await callGatewayTool("node.pair.list", gatewayOpts, {}));
          case "approve": {
            const requestId = readToolStringParam(params, "requestId", {
              required: true,
            });
            const scopes = await resolveNodePairApproveScopes(gatewayOpts, requestId);
            return jsonResult(
              await callGatewayTool(
                "node.pair.approve",
                gatewayOpts,
                {
                  requestId,
                },
                { scopes },
              ),
            );
          }
          case "reject": {
            const requestId = readToolStringParam(params, "requestId", {
              required: true,
            });
            return jsonResult(
              await callGatewayTool("node.pair.reject", gatewayOpts, {
                requestId,
              }),
            );
          }
          case "notify": {
            const node = readToolStringParam(params, "node", { required: true });
            const title = typeof params.title === "string" ? params.title : "";
            const body = typeof params.body === "string" ? params.body : "";
            if (!title.trim() && !body.trim()) {
              throw new Error("title or body required");
            }
            const nodeId = await resolveAgentNodeId(gatewayOpts, node);
            await callNodesToolNodeInvoke(gatewayOpts, {
              nodeId,
              command: "system.notify",
              params: {
                title: title.trim(),
                body: body.trim(),
                sound: typeof params.sound === "string" ? params.sound : undefined,
                priority: typeof params.priority === "string" ? params.priority : undefined,
                delivery: typeof params.delivery === "string" ? params.delivery : undefined,
              },
              idempotencyKey: crypto.randomUUID(),
            });
            return jsonResult({ ok: true });
          }
          case "camera_snap":
          case "photos_latest":
          case "camera_clip":
          case "screen_record":
          case "screen_snapshot": {
            return await executeNodeMediaAction({
              action,
              params,
              gatewayOpts,
              modelHasVision: options?.modelHasVision,
              imageSanitization,
            });
          }
          case "camera_list":
          case "camera_ptz":
          case "notifications_list":
          case "device_status":
          case "device_info":
          case "device_permissions":
          case "device_health":
          case "notifications_action":
          case "location_get":
          case "which":
          case "invoke": {
            return await executeNodeCommandAction({
              action,
              input: params,
              gatewayOpts,
              agentSessionKey: options?.agentSessionKey,
              allowMediaInvokeCommands: options?.allowMediaInvokeCommands,
            });
          }
          default:
            throw new Error(`Unknown action: ${action}`);
        }
      } catch (err) {
        const nodeLabel = normalizeOptionalString(params.node) ?? "auto";
        const gatewayLabel = normalizeOptionalString(gatewayOpts.gatewayUrl) ?? "default";
        const agentLabel = agentId ?? "unknown";
        let message = formatErrorMessage(err);
        const pairing =
          action === "invoke" || action === "which"
            ? readConnectPairingRequiredMessage(message)
            : null;
        if (pairing) {
          const requestId = pairing.requestId ?? null;
          const approveHint = requestId
            ? `Approve pairing request ${requestId} and retry.`
            : "Approve the pending pairing request and retry.";
          message = `pairing required before node invoke. ${approveHint}`;
        }
        throw new Error(
          `agent=${agentLabel} node=${nodeLabel} gateway=${gatewayLabel} action=${action}: ${message}`,
          { cause: err },
        );
      }
    },
  };
}
