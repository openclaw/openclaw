import crypto from "node:crypto";
import { formatErrorMessage } from "@openclaw/normalization-core/error-coercion";
import {
  normalizeOptionalString,
  normalizeLowercaseStringOrEmpty,
} from "@openclaw/normalization-core/string-coerce";
import { Type } from "typebox";
import { readConnectPairingRequiredMessage } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { OperatorScope } from "../../gateway/method-scopes.js";
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
import {
  type AnyAgentTool,
  jsonResult,
  readFiniteNumberParam,
  readNonNegativeIntegerParam,
  readPositiveIntegerParam,
  readStringArrayParam,
  readToolStringParam,
} from "./common.js";
import { gatewayCallOptionSchemaProperties } from "./gateway-schema.js";
import { callGatewayTool, readGatewayCallOptions, type GatewayCallOptions } from "./gateway.js";
import { callNodesToolNodeInvoke, resolveNodesToolInvokeTimeouts } from "./nodes-tool-invoke.js";
import { executeNodeMediaAction } from "./nodes-tool-media.js";
import { resolveAgentNodeId } from "./nodes-utils.js";

const BLOCKED_INVOKE_COMMANDS = new Set(["system.run", "system.run.prepare"]);
// File-transfer policy cannot be bypassed by opting into raw media payloads.
const MEDIA_INVOKE_ACTIONS = new Map<string, { action: string; pathPolicy?: true }>([
  ["camera.snap", { action: "camera_snap" }],
  ["camera.clip", { action: "camera_clip" }],
  ["photos.latest", { action: "photos_latest" }],
  ["screen.record", { action: "screen_record" }],
  ["screen.snapshot", { action: "screen_snapshot" }],
  ["file.fetch", { action: "file_fetch", pathPolicy: true }],
  ["dir.list", { action: "dir_list", pathPolicy: true }],
  ["dir.fetch", { action: "dir_fetch", pathPolicy: true }],
  ["file.write", { action: "file_write", pathPolicy: true }],
]);
const NODE_READ_ACTION_COMMANDS = {
  camera_list: "camera.list",
  notifications_list: "notifications.list",
  device_status: "device.status",
  device_info: "device.info",
  device_permissions: "device.permissions",
  device_health: "device.health",
};

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
  title: Type.Optional(Type.String()),
  body: Type.Optional(Type.String()),
  sound: Type.Optional(Type.String()),
  priority: optionalStringEnum(NOTIFY_PRIORITIES),
  delivery: optionalStringEnum(NOTIFY_DELIVERIES),
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
  fps: optionalFiniteNumberSchema({ exclusiveMinimum: 0 }),
  screenIndex: optionalNonNegativeIntegerSchema(),
  outPath: Type.Optional(Type.String()),
  maxAgeMs: optionalNonNegativeIntegerSchema(),
  locationTimeoutMs: optionalPositiveIntegerSchema(),
  desiredAccuracy: optionalStringEnum(LOCATION_ACCURACY),
  notificationAction: optionalStringEnum(NOTIFICATIONS_ACTIONS),
  notificationKey: Type.Optional(Type.String()),
  notificationReplyText: Type.Optional(Type.String()),
  bins: Type.Optional(
    Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      maxItems: 64,
      description: "which: executable names to resolve on the selected node.",
    }),
  ),
  invokeCommand: Type.Optional(
    Type.String({
      description: "Node command to relay. fs.listDir returns sub-directories only.",
    }),
  ),
  invokeParamsJson: Type.Optional(Type.String()),
  invokeTimeoutMs: optionalPositiveIntegerSchema(),
});

export function createNodesTool(options?: {
  agentSessionKey?: string;
  agentId?: string;
  config?: OpenClawConfig;
  modelHasVision?: boolean;
  allowMediaInvokeCommands?: boolean;
}): AnyAgentTool {
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
      "Paired nodes: status/list with active-computer presence; pass node to describe/control. Pairing lifecycle (pending/approve/reject), notify, camera_snap/camera_list/camera_clip (with audio), camera_ptz for physical camera pan/tilt/zoom, photos_latest, screen_snapshot, screen_record video, location_get, notifications_list + notifications_action (open/dismiss/reply), device_status/device_info/device_permissions/device_health, executable lookup (which + bins), generic invoke (fs.listDir returns sub-directories only). File transfer is a separate capability.",
    parameters: NodesToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readToolStringParam(params, "action", { required: true });
      const gatewayOpts = readGatewayCallOptions(params);

      try {
        switch (action) {
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
          case "approve":
          case "reject": {
            const requestId = readToolStringParam(params, "requestId", {
              required: true,
            });
            const approvalOptions =
              action === "approve"
                ? { scopes: await resolveNodePairApproveScopes(gatewayOpts, requestId) }
                : undefined;
            return jsonResult(
              await callGatewayTool(
                `node.pair.${action}`,
                gatewayOpts,
                { requestId },
                approvalOptions,
              ),
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
            const node = readToolStringParam(params, "node", { required: true });
            let command: string;
            let commandParams: unknown = {};
            let nodeId: string | undefined;
            const rawInvoke = action === "invoke";
            let invokeGatewayOpts = gatewayOpts;
            let invokeTimeoutMs: number | undefined;
            let requireObjectPayload = false;
            switch (action) {
              case "camera_ptz": {
                const deviceId = readToolStringParam(params, "deviceId", { required: true });
                const ptzOperation = normalizeLowercaseStringOrEmpty(params.ptzOperation);
                if (
                  ptzOperation !== "status" &&
                  ptzOperation !== "set" &&
                  ptzOperation !== "move" &&
                  ptzOperation !== "home"
                ) {
                  throw new Error("ptzOperation must be status|set|move|home");
                }
                const panDegrees = readFiniteNumberParam(params, "panDegrees");
                const tiltDegrees = readFiniteNumberParam(params, "tiltDegrees");
                const zoomPercent = readFiniteNumberParam(params, "zoomPercent");
                const hasAxes =
                  panDegrees !== undefined ||
                  tiltDegrees !== undefined ||
                  zoomPercent !== undefined;
                if ((ptzOperation === "status" || ptzOperation === "home") && hasAxes) {
                  throw new Error(`${ptzOperation} does not accept axis values`);
                }
                if ((ptzOperation === "set" || ptzOperation === "move") && !hasAxes) {
                  throw new Error(`${ptzOperation} requires at least one PTZ axis`);
                }
                const axes = { panDegrees, tiltDegrees, zoomPercent };
                command = ptzOperation === "status" ? "camera.ptz.status" : "camera.ptz.control";
                commandParams =
                  ptzOperation === "status"
                    ? { deviceId }
                    : ptzOperation === "home"
                      ? { deviceId, operation: "home" }
                      : {
                          deviceId,
                          operation: ptzOperation,
                          [ptzOperation === "set" ? "target" : "delta"]: axes,
                        };
                break;
              }
              case "camera_list":
              case "notifications_list":
              case "device_status":
              case "device_info":
              case "device_permissions":
              case "device_health": {
                command = NODE_READ_ACTION_COMMANDS[action];
                requireObjectPayload = true;
                break;
              }
              case "notifications_action": {
                const notificationKey = readToolStringParam(params, "notificationKey", {
                  required: true,
                });
                const notificationAction = normalizeLowercaseStringOrEmpty(
                  params.notificationAction,
                );
                if (
                  notificationAction !== "open" &&
                  notificationAction !== "dismiss" &&
                  notificationAction !== "reply"
                ) {
                  throw new Error("notificationAction must be open|dismiss|reply");
                }
                const notificationReplyText =
                  typeof params.notificationReplyText === "string"
                    ? params.notificationReplyText.trim()
                    : undefined;
                if (notificationAction === "reply" && !notificationReplyText) {
                  throw new Error("notificationReplyText required when notificationAction=reply");
                }
                command = "notifications.actions";
                commandParams = {
                  key: notificationKey,
                  action: notificationAction,
                  replyText: notificationReplyText,
                };
                requireObjectPayload = true;
                break;
              }
              case "location_get": {
                const maxAgeMs = readNonNegativeIntegerParam(params, "maxAgeMs");
                const desiredAccuracy =
                  params.desiredAccuracy === "coarse" ||
                  params.desiredAccuracy === "balanced" ||
                  params.desiredAccuracy === "precise"
                    ? params.desiredAccuracy
                    : undefined;
                const locationTimeoutMs = readPositiveIntegerParam(params, "locationTimeoutMs");
                const timeouts = resolveNodesToolInvokeTimeouts({
                  input: params,
                  gatewayOpts,
                  operationTimeoutMs: locationTimeoutMs,
                });
                invokeGatewayOpts = timeouts.gatewayOpts;
                invokeTimeoutMs = timeouts.invokeTimeoutMs;
                command = "location.get";
                commandParams = { maxAgeMs, desiredAccuracy, timeoutMs: locationTimeoutMs };
                break;
              }
              case "which": {
                const bins = readStringArrayParam(params, "bins", { required: true });
                command = "system.which";
                commandParams = { bins };
                break;
              }
              case "invoke": {
                nodeId = await resolveAgentNodeId(gatewayOpts, node);
                const invokeCommand = readToolStringParam(params, "invokeCommand", {
                  required: true,
                });
                const invokeCommandNormalized = normalizeLowercaseStringOrEmpty(invokeCommand);
                if (BLOCKED_INVOKE_COMMANDS.has(invokeCommandNormalized)) {
                  throw new Error(
                    `invokeCommand "${invokeCommand}" is reserved for shell execution; call the shell exec tool with { command, host: "node", node: "${nodeId}" } instead`,
                  );
                }
                const dedicatedAction = MEDIA_INVOKE_ACTIONS.get(invokeCommandNormalized);
                if (dedicatedAction?.pathPolicy) {
                  throw new Error(
                    `invokeCommand "${invokeCommand}" enforces a path-allowlist policy and cannot be invoked via the generic nodes.invoke surface; use the dedicated file-transfer tool "${dedicatedAction.action}"`,
                  );
                }
                if (dedicatedAction && !options?.allowMediaInvokeCommands) {
                  throw new Error(
                    `invokeCommand "${invokeCommand}" returns media payloads and is blocked to prevent base64 context bloat; use action="${dedicatedAction.action}"`,
                  );
                }
                const invokeParamsJson =
                  typeof params.invokeParamsJson === "string" ? params.invokeParamsJson.trim() : "";
                if (invokeParamsJson) {
                  try {
                    commandParams = JSON.parse(invokeParamsJson);
                  } catch (err) {
                    const message = formatErrorMessage(err);
                    throw new Error(`invokeParamsJson must be valid JSON: ${message}`, {
                      cause: err,
                    });
                  }
                }
                const timeouts = resolveNodesToolInvokeTimeouts({
                  input: params,
                  gatewayOpts,
                });
                command = invokeCommand;
                invokeGatewayOpts = timeouts.gatewayOpts;
                invokeTimeoutMs = timeouts.invokeTimeoutMs;
                break;
              }
              default:
                throw new Error("Unsupported node command action");
            }
            nodeId ??= await resolveAgentNodeId(invokeGatewayOpts, node);
            const raw = await callNodesToolNodeInvoke<{ payload: unknown }>(
              invokeGatewayOpts,
              {
                nodeId,
                command,
                params: commandParams,
                ...(rawInvoke || invokeTimeoutMs !== undefined
                  ? { timeoutMs: invokeTimeoutMs }
                  : {}),
                idempotencyKey: crypto.randomUUID(),
                ...(rawInvoke && options?.agentSessionKey
                  ? { sessionKey: options?.agentSessionKey }
                  : {}),
              },
              rawInvoke ? { rawInvoke: true } : undefined,
            );
            if (rawInvoke) {
              return jsonResult(raw ?? {});
            }
            const payload =
              raw && typeof raw === "object" && Object.hasOwn(raw, "payload") ? raw.payload : {};
            return jsonResult(
              requireObjectPayload && (payload === null || typeof payload !== "object")
                ? {}
                : payload,
            );
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
