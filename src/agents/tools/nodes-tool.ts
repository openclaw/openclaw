import crypto from "node:crypto";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import {
  type CameraFacing,
  cameraTempPath,
  parseCameraClipPayload,
  parseCameraSnapPayload,
  writeCameraClipPayloadToFile,
  writeCameraPayloadToFile,
} from "../../cli/nodes-camera.js";
import {
  parseScreenRecordPayload,
  screenRecordTempPath,
  writeScreenRecordToFile,
} from "../../cli/nodes-screen.js";
import { parseDurationMs } from "../../cli/parse-duration.js";
import { parseTimeoutMs } from "../../cli/parse-timeout.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { OperatorScope } from "../../gateway/method-scopes.js";
import { NODE_SYSTEM_RUN_COMMANDS } from "../../infra/node-commands.js";
import { imageMimeFromFormat } from "../../media/mime.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { resolveImageSanitizationLimits } from "../image-sanitization.js";
import { optionalStringEnum, stringEnum } from "../schema/typebox.js";
import { sanitizeToolResultImages } from "../tool-images.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";
import { callGatewayTool, readGatewayCallOptions } from "./gateway.js";
import { resolveNode, resolveNodeId } from "./nodes-utils.js";

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
  "photos_latest",
  "screen_record",
  "location_get",
  "notifications_list",
  "notifications_action",
  "device_status",
  "device_info",
  "device_permissions",
  "device_health",
  "invoke",
] as const;

const NOTIFY_PRIORITIES = ["passive", "active", "timeSensitive"] as const;
const NOTIFY_DELIVERIES = ["system", "overlay", "auto"] as const;
const NOTIFICATIONS_ACTIONS = ["open", "dismiss", "reply"] as const;
const CAMERA_FACING = ["front", "back", "both"] as const;
const LOCATION_ACCURACY = ["coarse", "balanced", "precise"] as const;
const MEDIA_INVOKE_ACTIONS = {
  "camera.snap": "camera_snap",
  "camera.clip": "camera_clip",
  "photos.latest": "photos_latest",
  "screen.record": "screen_record",
} as const;
const BLOCKED_INVOKE_COMMANDS = new Set(["system.run", "system.run.prepare"]);
const NODE_READ_ACTION_COMMANDS = {
  camera_list: "camera.list",
  notifications_list: "notifications.list",
  device_status: "device.status",
  device_info: "device.info",
  device_permissions: "device.permissions",
  device_health: "device.health",
} as const;
type GatewayCallOptions = ReturnType<typeof readGatewayCallOptions>;

function resolveApproveScopes(commands: unknown): OperatorScope[] {
  const normalized = Array.isArray(commands)
    ? commands.filter((value): value is string => typeof value === "string")
    : [];
  if (
    normalized.some((command) => NODE_SYSTEM_RUN_COMMANDS.some((allowed) => allowed === command))
  ) {
    return ["operator.admin"];
  }
  if (normalized.length > 0) {
    return ["operator.write"];
  }
  return ["operator.write"];
}

async function resolveNodePairApproveScopes(
  gatewayOpts: GatewayCallOptions,
  requestId: string,
): Promise<OperatorScope[]> {
  const pairing = await callGatewayTool<{
    pending?: Array<{ requestId?: string; commands?: unknown }>;
  }>("node.pair.list", gatewayOpts, {}, { scopes: ["operator.pairing", "operator.write"] });
  const pending = Array.isArray(pairing?.pending) ? pairing.pending : [];
  const match = pending.find((entry) => entry?.requestId === requestId);
  return resolveApproveScopes(match?.commands);
}

async function invokeNodeCommandPayload(params: {
  gatewayOpts: GatewayCallOptions;
  node: string;
  command: string;
  commandParams?: Record<string, unknown>;
}): Promise<unknown> {
  const nodeId = await resolveNodeId(params.gatewayOpts, params.node);
  const raw = await callGatewayTool<{ payload: unknown }>("node.invoke", params.gatewayOpts, {
    nodeId,
    command: params.command,
    params: params.commandParams ?? {},
    idempotencyKey: crypto.randomUUID(),
  });
  return raw?.payload ?? {};
}

function isPairingRequiredMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("pairing required") || lower.includes("not_paired");
}

function extractPairingRequestId(message: string): string | null {
  const match = message.match(/\(requestId:\s*([^)]+)\)/i);
  if (!match) {
    return null;
  }
  const value = (match[1] ?? "").trim();
  return value.length > 0 ? value : null;
}

// Flattened schema: runtime validates per-action requirements.
const NodesToolSchema = Type.Object({
  action: stringEnum(NODES_TOOL_ACTIONS),
  gatewayUrl: Type.Optional(Type.String()),
  gatewayToken: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Number()),
  node: Type.Optional(Type.String()),
  requestId: Type.Optional(Type.String()),
  // notify
  title: Type.Optional(Type.String()),
  body: Type.Optional(Type.String()),
  sound: Type.Optional(Type.String()),
  priority: optionalStringEnum(NOTIFY_PRIORITIES),
  delivery: optionalStringEnum(NOTIFY_DELIVERIES),
  // camera_snap / camera_clip
  facing: optionalStringEnum(CAMERA_FACING, {
    description: "camera_snap: front/back/both; camera_clip: front/back only.",
  }),
  maxWidth: Type.Optional(Type.Number()),
  quality: Type.Optional(Type.Number()),
  delayMs: Type.Optional(Type.Number()),
  deviceId: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Number()),
  duration: Type.Optional(Type.String()),
  durationMs: Type.Optional(Type.Number({ maximum: 300_000 })),
  includeAudio: Type.Optional(Type.Boolean()),
  // screen_record
  fps: Type.Optional(Type.Number()),
  screenIndex: Type.Optional(Type.Number()),
  outPath: Type.Optional(Type.String()),
  // location_get
  maxAgeMs: Type.Optional(Type.Number()),
  locationTimeoutMs: Type.Optional(Type.Number()),
  desiredAccuracy: optionalStringEnum(LOCATION_ACCURACY),
  // notifications_action
  notificationAction: optionalStringEnum(NOTIFICATIONS_ACTIONS),
  notificationKey: Type.Optional(Type.String()),
  notificationReplyText: Type.Optional(Type.String()),
  // invoke
  invokeCommand: Type.Optional(Type.String()),
  invokeParamsJson: Type.Optional(Type.String()),
  invokeTimeoutMs: Type.Optional(Type.Number()),
});

export function createNodesTool(options?: {
  agentSessionKey?: string;
  agentChannel?: GatewayMessageChannel;
  agentAccountId?: string;
  currentChannelId?: string;
  currentThreadTs?: string | number;
  config?: OpenClawConfig;
  modelHasVision?: boolean;
  allowMediaInvokeCommands?: boolean;
}): AnyAgentTool {
  const agentId = resolveSessionAgentId({
    sessionKey: options?.agentSessionKey,
    config: options?.config,
  });
  const imageSanitization = resolveImageSanitizationLimits(options?.config);
  return {
    label: "Nodes",
    name: "nodes",
    ownerOnly: true,
    description:
      "Discover and control paired nodes (status/describe/pairing/notify/camera/photos/screen/location/notifications/invoke).",
    parameters: NodesToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const gatewayOpts = readGatewayCallOptions(params);

      try {
        switch (action) {
          case "status":
            return jsonResult(await callGatewayTool("node.list", gatewayOpts, {}));
          case "describe": {
            const node = readStringParam(params, "node", { required: true });
            const nodeId = await resolveNodeId(gatewayOpts, node);
            return jsonResult(await callGatewayTool("node.describe", gatewayOpts, { nodeId }));
          }
          case "pending":
            return jsonResult(await callGatewayTool("node.pair.list", gatewayOpts, {}));
          case "approve": {
            const requestId = readStringParam(params, "requestId", {
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
            const requestId = readStringParam(params, "requestId", {
              required: true,
            });
            return jsonResult(
              await callGatewayTool("node.pair.reject", gatewayOpts, {
                requestId,
              }),
            );
          }
          case "notify": {
            const node = readStringParam(params, "node", { required: true });
            const title = typeof params.title === "string" ? params.title : "";
            const body = typeof params.body === "string" ? params.body : "";
            if (!title.trim() && !body.trim()) {
              throw new Error("title or body required");
            }
            const nodeId = await resolveNodeId(gatewayOpts, node);
            await callGatewayTool("node.invoke", gatewayOpts, {
              nodeId,
              command: "system.notify",
              params: {
                title: title.trim() || undefined,
                body: body.trim() || undefined,
                sound: typeof params.sound === "string" ? params.sound : undefined,
                priority: typeof params.priority === "string" ? params.priority : undefined,
                delivery: typeof params.delivery === "string" ? params.delivery : undefined,
              },
              idempotencyKey: crypto.randomUUID(),
            });
            return jsonResult({ ok: true });
          }
          case "camera_snap": {
            const node = readStringParam(params, "node", { required: true });
            const resolvedNode = await resolveNode(gatewayOpts, node);
            const nodeId = resolvedNode.nodeId;
            const facingRaw =
              typeof params.facing === "string" ? params.facing.toLowerCase() : "front";
            const facings: CameraFacing[] =
              facingRaw === "both"
                ? ["front", "back"]
                : facingRaw === "front" || facingRaw === "back"
                  ? [facingRaw]
                  : (() => {
                      throw new Error("invalid facing (front|back|both)");
                    })();
            const maxWidth =
              typeof params.maxWidth === "number" && Number.isFinite(params.maxWidth)
                ? params.maxWidth
                : 1600;
            const quality =
              typeof params.quality === "number" && Number.isFinite(params.quality)
                ? params.quality
                : 0.95;
            const delayMs =
              typeof params.delayMs === "number" && Number.isFinite(params.delayMs)
                ? params.delayMs
                : undefined;
            const deviceId =
              typeof params.deviceId === "string" && params.deviceId.trim()
                ? params.deviceId.trim()
                : undefined;
            if (deviceId && facings.length > 1) {
              throw new Error("facing=both is not allowed when deviceId is set");
            }

            const content: AgentToolResult<unknown>["content"] = [];
            const details: Array<Record<string, unknown>> = [];

            for (const facing of facings) {
              const raw = await callGatewayTool<{ payload: unknown }>("node.invoke", gatewayOpts, {
                nodeId,
                command: "camera.snap",
                params: {
                  facing,
                  maxWidth,
                  quality,
                  format: "jpg",
                  delayMs,
                  deviceId,
                },
                idempotencyKey: crypto.randomUUID(),
              });
              const payload = parseCameraSnapPayload(raw?.payload);
              const normalizedFormat = payload.format.toLowerCase();
              if (
                normalizedFormat !== "jpg" &&
                normalizedFormat !== "jpeg" &&
                normalizedFormat !== "png"
              ) {
                throw new Error(`unsupported camera.snap format: ${payload.format}`);
              }

              const isJpeg = normalizedFormat === "jpg" || normalizedFormat === "jpeg";
              const filePath = cameraTempPath({
                kind: "snap",
                facing,
                ext: isJpeg ? "jpg" : "png",
              });
              await writeCameraPayloadToFile({
                filePath,
                payload,
                expectedHost: resolvedNode.remoteIp,
                invalidPayloadMessage: "invalid camera.snap payload",
              });
              if (options?.modelHasVision && payload.base64) {
                content.push({
                  type: "image",
                  data: payload.base64,
                  mimeType:
                    imageMimeFromFormat(payload.format) ?? (isJpeg ? "image/jpeg" : "image/png"),
                });
              }
              details.push({
                facing,
                path: filePath,
                width: payload.width,
                height: payload.height,
              });
            }

            const result: AgentToolResult<unknown> = {
              content,
              details: {
                snaps: details,
                media: {
                  mediaUrls: details
                    .map((entry) => entry.path)
                    .filter((path): path is string => typeof path === "string"),
                },
              },
            };
            return await sanitizeToolResultImages(result, "nodes:camera_snap", imageSanitization);
          }
          case "photos_latest": {
            const node = readStringParam(params, "node", { required: true });
            const resolvedNode = await resolveNode(gatewayOpts, node);
            const nodeId = resolvedNode.nodeId;
            const limitRaw =
              typeof params.limit === "number" && Number.isFinite(params.limit)
                ? Math.floor(params.limit)
                : DEFAULT_PHOTOS_LIMIT;
            const limit = Math.max(1, Math.min(limitRaw, MAX_PHOTOS_LIMIT));
            const maxWidth =
              typeof params.maxWidth === "number" && Number.isFinite(params.maxWidth)
                ? params.maxWidth
                : DEFAULT_PHOTOS_MAX_WIDTH;
            const quality =
              typeof params.quality === "number" && Number.isFinite(params.quality)
                ? params.quality
                : DEFAULT_PHOTOS_QUALITY;
            const raw = await callGatewayTool<{ payload: unknown }>("node.invoke", gatewayOpts, {
              nodeId,
              command: "photos.latest",
              params: {
                limit,
                maxWidth,
                quality,
              },
              idempotencyKey: crypto.randomUUID(),
            });
            const payload =
              raw?.payload && typeof raw.payload === "object" && !Array.isArray(raw.payload)
                ? (raw.payload as Record<string, unknown>)
                : {};
            const photos = Array.isArray(payload.photos) ? payload.photos : [];

            if (photos.length === 0) {
              const result: AgentToolResult<unknown> = {
                content: [],
                details: [],
              };
              return await sanitizeToolResultImages(
                result,
                "nodes:photos_latest",
                imageSanitization,
              );
            }

            const content: AgentToolResult<unknown>["content"] = [];
            const details: Array<Record<string, unknown>> = [];

            for (const [index, photoRaw] of photos.entries()) {
              const photo = parseCameraSnapPayload(photoRaw);
              const normalizedFormat = photo.format.toLowerCase();
              if (
                normalizedFormat !== "jpg" &&
                normalizedFormat !== "jpeg" &&
                normalizedFormat !== "png"
              ) {
                throw new Error(`unsupported photos.latest format: ${photo.format}`);
              }
              const isJpeg = normalizedFormat === "jpg" || normalizedFormat === "jpeg";
              const filePath = cameraTempPath({
                kind: "snap",
                ext: isJpeg ? "jpg" : "png",
                id: crypto.randomUUID(),
              });
              await writeCameraPayloadToFile({
                filePath,
                payload: photo,
                expectedHost: resolvedNode.remoteIp,
                invalidPayloadMessage: "invalid photos.latest payload",
              });

              if (options?.modelHasVision && photo.base64) {
                content.push({
                  type: "image",
                  data: photo.base64,
                  mimeType:
                    imageMimeFromFormat(photo.format) ?? (isJpeg ? "image/jpeg" : "image/png"),
                });
              }

              const createdAt =
                photoRaw && typeof photoRaw === "object" && !Array.isArray(photoRaw)
                  ? (photoRaw as Record<string, unknown>).createdAt
                  : undefined;
              details.push({
                index,
                path: filePath,
                width: photo.width,
                height: photo.height,
                ...(typeof createdAt === "string" ? { createdAt } : {}),
              });
            }

            const result: AgentToolResult<unknown> = {
              content,
              details: {
                photos: details,
                media: {
                  mediaUrls: details
                    .map((entry) => entry.path)
                    .filter((path): path is string => typeof path === "string"),
                },
              },
            };
            return await sanitizeToolResultImages(result, "nodes:photos_latest", imageSanitization);
          }
          case "camera_list":
          case "notifications_list":
          case "device_status":
          case "device_info":
          case "device_permissions":
          case "device_health": {
            const node = readStringParam(params, "node", { required: true });
            const command = NODE_READ_ACTION_COMMANDS[action];
            const payloadRaw = await invokeNodeCommandPayload({
              gatewayOpts,
              node,
              command,
            });
            const payload =
              payloadRaw && typeof payloadRaw === "object" && payloadRaw !== null ? payloadRaw : {};
            return jsonResult(payload);
          }
          case "notifications_action": {
            const node = readStringParam(params, "node", { required: true });
            const notificationKey = readStringParam(params, "notificationKey", { required: true });
            const notificationAction =
              typeof params.notificationAction === "string"
                ? params.notificationAction.trim().toLowerCase()
                : "";
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
            const payloadRaw = await invokeNodeCommandPayload({
              gatewayOpts,
              node,
              command: "notifications.actions",
              commandParams: {
                key: notificationKey,
                action: notificationAction,
                replyText: notificationReplyText,
              },
            });
            const payload =
              payloadRaw && typeof payloadRaw === "object" && payloadRaw !== null ? payloadRaw : {};
            return jsonResult(payload);
          }
          case "camera_clip": {
            const node = readStringParam(params, "node", { required: true });
            const resolvedNode = await resolveNode(gatewayOpts, node);
            const nodeId = resolvedNode.nodeId;
            const facing =
              typeof params.facing === "string" ? params.facing.toLowerCase() : "front";
            if (facing !== "front" && facing !== "back") {
              throw new Error("invalid facing (front|back)");
            }
            const durationMs =
              typeof params.durationMs === "number" && Number.isFinite(params.durationMs)
                ? params.durationMs
                : typeof params.duration === "string"
                  ? parseDurationMs(params.duration)
                  : 3000;
            const includeAudio =
              typeof params.includeAudio === "boolean" ? params.includeAudio : true;
            const deviceId =
              typeof params.deviceId === "string" && params.deviceId.trim()
                ? params.deviceId.trim()
                : undefined;
            const raw = await callGatewayTool<{ payload: unknown }>("node.invoke", gatewayOpts, {
              nodeId,
              command: "camera.clip",
              params: {
                facing,
                durationMs,
                includeAudio,
                format: "mp4",
                deviceId,
              },
              idempotencyKey: crypto.randomUUID(),
            });
            const payload = parseCameraClipPayload(raw?.payload);
            const filePath = await writeCameraClipPayloadToFile({
              payload,
              facing,
              expectedHost: resolvedNode.remoteIp,
            });
            return {
              content: [{ type: "text", text: `FILE:${filePath}` }],
              details: {
                facing,
                path: filePath,
                durationMs: payload.durationMs,
                hasAudio: payload.hasAudio,
              },
            };
          }
          case "screen_record": {
            const node = readStringParam(params, "node", { required: true });
            const nodeId = await resolveNodeId(gatewayOpts, node);
            const durationMs = Math.min(
              typeof params.durationMs === "number" && Number.isFinite(params.durationMs)
                ? params.durationMs
                : typeof params.duration === "string"
                  ? parseDurationMs(params.duration)
                  : 10_000,
              300_000,
            );
            const fps =
              typeof params.fps === "number" && Number.isFinite(params.fps) ? params.fps : 10;
            const screenIndex =
              typeof params.screenIndex === "number" && Number.isFinite(params.screenIndex)
                ? params.screenIndex
                : 0;
            const includeAudio =
              typeof params.includeAudio === "boolean" ? params.includeAudio : true;
            const raw = await callGatewayTool<{ payload: unknown }>("node.invoke", gatewayOpts, {
              nodeId,
              command: "screen.record",
              params: {
                durationMs,
                screenIndex,
                fps,
                format: "mp4",
                includeAudio,
              },
              idempotencyKey: crypto.randomUUID(),
            });
            const payload = parseScreenRecordPayload(raw?.payload);
            const filePath =
              typeof params.outPath === "string" && params.outPath.trim()
                ? params.outPath.trim()
                : screenRecordTempPath({ ext: payload.format || "mp4" });
            const written = await writeScreenRecordToFile(filePath, payload.base64);
            return {
              content: [{ type: "text", text: `FILE:${written.path}` }],
              details: {
                path: written.path,
                durationMs: payload.durationMs,
                fps: payload.fps,
                screenIndex: payload.screenIndex,
                hasAudio: payload.hasAudio,
              },
            };
          }
          case "location_get": {
            const node = readStringParam(params, "node", { required: true });
            const maxAgeMs =
              typeof params.maxAgeMs === "number" && Number.isFinite(params.maxAgeMs)
                ? params.maxAgeMs
                : undefined;
            const desiredAccuracy =
              params.desiredAccuracy === "coarse" ||
              params.desiredAccuracy === "balanced" ||
              params.desiredAccuracy === "precise"
                ? params.desiredAccuracy
                : undefined;
            const locationTimeoutMs =
              typeof params.locationTimeoutMs === "number" &&
              Number.isFinite(params.locationTimeoutMs)
                ? params.locationTimeoutMs
                : undefined;
            const payload = await invokeNodeCommandPayload({
              gatewayOpts,
              node,
              command: "location.get",
              commandParams: {
                maxAgeMs,
                desiredAccuracy,
                timeoutMs: locationTimeoutMs,
              },
            });
            return jsonResult(payload);
          }
          case "invoke": {
            const node = readStringParam(params, "node", { required: true });
            const nodeId = await resolveNodeId(gatewayOpts, node);
            const invokeCommand = readStringParam(params, "invokeCommand", { required: true });
            const invokeCommandNormalized = invokeCommand.trim().toLowerCase();
            if (BLOCKED_INVOKE_COMMANDS.has(invokeCommandNormalized)) {
              throw new Error(
                `invokeCommand "${invokeCommand}" is reserved for shell execution; use exec with host=node instead`,
              );
            }
            const dedicatedAction =
              MEDIA_INVOKE_ACTIONS[invokeCommandNormalized as keyof typeof MEDIA_INVOKE_ACTIONS];
            if (dedicatedAction && !options?.allowMediaInvokeCommands) {
              throw new Error(
                `invokeCommand "${invokeCommand}" returns media payloads and is blocked to prevent base64 context bloat; use action="${dedicatedAction}"`,
              );
            }
            const invokeParamsJson =
              typeof params.invokeParamsJson === "string" ? params.invokeParamsJson.trim() : "";
            let invokeParams: unknown = {};
            if (invokeParamsJson) {
              try {
                invokeParams = JSON.parse(invokeParamsJson);
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                throw new Error(`invokeParamsJson must be valid JSON: ${message}`, {
                  cause: err,
                });
              }
            }
            const invokeTimeoutMs = parseTimeoutMs(params.invokeTimeoutMs);
            const raw = await callGatewayTool("node.invoke", gatewayOpts, {
              nodeId,
              command: invokeCommand,
              params: invokeParams,
              timeoutMs: invokeTimeoutMs,
              idempotencyKey: crypto.randomUUID(),
            });
            return jsonResult(raw ?? {});
          }
          default:
            throw new Error(`Unknown action: ${action}`);
        }
      } catch (err) {
        const nodeLabel =
          typeof params.node === "string" && params.node.trim() ? params.node.trim() : "auto";
        const gatewayLabel =
          gatewayOpts.gatewayUrl && gatewayOpts.gatewayUrl.trim()
            ? gatewayOpts.gatewayUrl.trim()
            : "default";
        const agentLabel = agentId ?? "unknown";
        let message = err instanceof Error ? err.message : String(err);
        if (action === "invoke" && isPairingRequiredMessage(message)) {
          const requestId = extractPairingRequestId(message);
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

const DEFAULT_PHOTOS_LIMIT = 1;
const MAX_PHOTOS_LIMIT = 20;
const DEFAULT_PHOTOS_MAX_WIDTH = 1600;
const DEFAULT_PHOTOS_QUALITY = 0.85;
