import crypto from "node:crypto";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  jsonResult,
  readFiniteNumberParam,
  readNonNegativeIntegerParam,
  readPositiveIntegerParam,
  readStringArrayParam,
  readToolStringParam,
} from "./common.js";
import type { GatewayCallOptions } from "./gateway.js";
import { callNodesToolNodeInvoke, resolveNodesToolInvokeTimeouts } from "./nodes-tool-invoke.js";
import { resolveAgentNodeId } from "./nodes-utils.js";

const BLOCKED_INVOKE_COMMANDS = new Set(["system.run", "system.run.prepare"]);
const MEDIA_INVOKE_ACTIONS: Readonly<Record<string, string>> = {
  "camera.snap": "camera_snap",
  "camera.clip": "camera_clip",
  "photos.latest": "photos_latest",
  "screen.record": "screen_record",
  "screen.snapshot": "screen_snapshot",
  "file.fetch": "file_fetch",
  "dir.list": "dir_list",
  "dir.fetch": "dir_fetch",
  "file.write": "file_write",
};
// File-transfer policy cannot be bypassed by opting into raw media payloads.
const POLICY_REDIRECT_INVOKE_COMMANDS: ReadonlySet<string> = new Set([
  "file.fetch",
  "dir.list",
  "dir.fetch",
  "file.write",
]);
const NODE_READ_ACTION_COMMANDS = {
  camera_list: "camera.list",
  notifications_list: "notifications.list",
  device_status: "device.status",
  device_info: "device.info",
  device_permissions: "device.permissions",
  device_health: "device.health",
} as const;

type NodeCommandAction =
  | keyof typeof NODE_READ_ACTION_COMMANDS
  | "camera_ptz"
  | "notifications_action"
  | "location_get"
  | "which"
  | "invoke";

export async function executeNodeCommandAction(params: {
  action: NodeCommandAction;
  input: Record<string, unknown>;
  gatewayOpts: GatewayCallOptions;
  agentSessionKey?: string;
  allowMediaInvokeCommands?: boolean;
}): Promise<ReturnType<typeof jsonResult>> {
  const node = readToolStringParam(params.input, "node", { required: true });
  let command: string;
  let commandParams: Record<string, unknown> = {};
  let gatewayOpts = params.gatewayOpts;
  let invokeTimeoutMs: number | undefined;
  let requireObjectPayload = false;
  switch (params.action) {
    case "camera_ptz": {
      const deviceId = readToolStringParam(params.input, "deviceId", { required: true });
      const ptzOperation = normalizeLowercaseStringOrEmpty(params.input.ptzOperation);
      if (
        ptzOperation !== "status" &&
        ptzOperation !== "set" &&
        ptzOperation !== "move" &&
        ptzOperation !== "home"
      ) {
        throw new Error("ptzOperation must be status|set|move|home");
      }
      const panDegrees = readFiniteNumberParam(params.input, "panDegrees");
      const tiltDegrees = readFiniteNumberParam(params.input, "tiltDegrees");
      const zoomPercent = readFiniteNumberParam(params.input, "zoomPercent");
      const hasAxes =
        panDegrees !== undefined || tiltDegrees !== undefined || zoomPercent !== undefined;
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
      command = NODE_READ_ACTION_COMMANDS[params.action];
      requireObjectPayload = true;
      break;
    }
    case "notifications_action": {
      const notificationKey = readToolStringParam(params.input, "notificationKey", {
        required: true,
      });
      const notificationAction = normalizeLowercaseStringOrEmpty(params.input.notificationAction);
      if (
        notificationAction !== "open" &&
        notificationAction !== "dismiss" &&
        notificationAction !== "reply"
      ) {
        throw new Error("notificationAction must be open|dismiss|reply");
      }
      const notificationReplyText =
        typeof params.input.notificationReplyText === "string"
          ? params.input.notificationReplyText.trim()
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
      const maxAgeMs = readNonNegativeIntegerParam(params.input, "maxAgeMs");
      const desiredAccuracy =
        params.input.desiredAccuracy === "coarse" ||
        params.input.desiredAccuracy === "balanced" ||
        params.input.desiredAccuracy === "precise"
          ? params.input.desiredAccuracy
          : undefined;
      const locationTimeoutMs = readPositiveIntegerParam(params.input, "locationTimeoutMs");
      const timeouts = resolveNodesToolInvokeTimeouts({
        input: params.input,
        gatewayOpts: params.gatewayOpts,
        operationTimeoutMs: locationTimeoutMs,
      });
      gatewayOpts = timeouts.gatewayOpts;
      invokeTimeoutMs = timeouts.invokeTimeoutMs;
      command = "location.get";
      commandParams = { maxAgeMs, desiredAccuracy, timeoutMs: locationTimeoutMs };
      break;
    }
    case "which": {
      const bins = readStringArrayParam(params.input, "bins", { required: true });
      command = "system.which";
      commandParams = { bins };
      break;
    }
    case "invoke": {
      const nodeId = await resolveAgentNodeId(params.gatewayOpts, node);
      const invokeCommand = readToolStringParam(params.input, "invokeCommand", { required: true });
      const invokeCommandNormalized = normalizeLowercaseStringOrEmpty(invokeCommand);
      if (BLOCKED_INVOKE_COMMANDS.has(invokeCommandNormalized)) {
        throw new Error(
          `invokeCommand "${invokeCommand}" is reserved for shell execution; use exec with host=node instead`,
        );
      }
      const dedicatedAction = MEDIA_INVOKE_ACTIONS[invokeCommandNormalized];
      if (dedicatedAction && POLICY_REDIRECT_INVOKE_COMMANDS.has(invokeCommandNormalized)) {
        throw new Error(
          `invokeCommand "${invokeCommand}" enforces a path-allowlist policy and cannot be invoked via the generic nodes.invoke surface; use the dedicated file-transfer tool "${dedicatedAction}"`,
        );
      }
      if (dedicatedAction && !params.allowMediaInvokeCommands) {
        throw new Error(
          `invokeCommand "${invokeCommand}" returns media payloads and is blocked to prevent base64 context bloat; use action="${dedicatedAction}"`,
        );
      }
      const invokeParamsJson =
        typeof params.input.invokeParamsJson === "string"
          ? params.input.invokeParamsJson.trim()
          : "";
      let invokeParams: unknown = {};
      if (invokeParamsJson) {
        try {
          invokeParams = JSON.parse(invokeParamsJson);
        } catch (err) {
          const message = formatErrorMessage(err);
          throw new Error(`invokeParamsJson must be valid JSON: ${message}`, {
            cause: err,
          });
        }
      }
      const timeouts = resolveNodesToolInvokeTimeouts({
        input: params.input,
        gatewayOpts: params.gatewayOpts,
      });
      const raw = await callNodesToolNodeInvoke(
        timeouts.gatewayOpts,
        {
          nodeId,
          command: invokeCommand,
          params: invokeParams,
          timeoutMs: timeouts.invokeTimeoutMs,
          idempotencyKey: crypto.randomUUID(),
          ...(params.agentSessionKey ? { sessionKey: params.agentSessionKey } : {}),
        },
        { rawInvoke: true },
      );
      return jsonResult(raw ?? {});
    }
    default:
      throw new Error("Unsupported node command action");
  }
  const nodeId = await resolveAgentNodeId(gatewayOpts, node);
  const raw = await callNodesToolNodeInvoke<{ payload: unknown }>(gatewayOpts, {
    nodeId,
    command,
    params: commandParams,
    ...(invokeTimeoutMs === undefined ? {} : { timeoutMs: invokeTimeoutMs }),
    idempotencyKey: crypto.randomUUID(),
  });
  const payload =
    raw && typeof raw === "object" && Object.hasOwn(raw, "payload") ? raw.payload : {};
  return jsonResult(
    requireObjectPayload && (payload === null || typeof payload !== "object") ? {} : payload,
  );
}
