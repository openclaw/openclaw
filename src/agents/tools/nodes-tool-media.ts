import crypto from "node:crypto";
import { extnameFromAnyPath } from "@openclaw/media-core/file-name";
import { imageMimeFromFormat } from "@openclaw/media-core/mime";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  type CameraArtifactFacing,
  cameraTempPath,
  parseCameraClipPayload,
  parseCameraSnapPayload,
  resolveCameraClipTarget,
  resolveCameraSnapTargets,
  writeCameraClipPayloadToFile,
  writeCameraPayloadToFile,
  withCameraArtifactBatch,
} from "../../cli/nodes-camera.js";
import { mediaPathMatchesFormat } from "../../cli/nodes-media-utils.js";
import {
  parseScreenRecordPayload,
  screenRecordTempPath,
  screenSnapshotFormatForPath,
  screenSnapshotTempPath,
  writeScreenRecordToFile,
  writeScreenSnapshotToFile,
} from "../../cli/nodes-screen.js";
import { parseDurationMs } from "../../cli/parse-duration.js";
import { parseScreenSnapshotResult } from "../../plugins/computer-use-contract.js";
import type { ImageSanitizationLimits } from "../image-sanitization.js";
import type { AgentToolResult } from "../runtime/index.js";
import { sanitizeToolResultImages } from "../tool-images.js";
import {
  readFiniteNumberParam,
  readNonNegativeIntegerParam,
  readPositiveIntegerParam,
  readToolStringParam,
} from "./common.js";
import type { GatewayCallOptions } from "./gateway.js";
import { callNodesToolNodeInvoke, resolveNodesToolInvokeTimeouts } from "./nodes-tool-invoke.js";
import { resolveAgentNode } from "./nodes-utils.js";
import { textResult } from "./tool-results.js";

const MAX_RECORDING_DURATION_MS = 300_000;

export async function executeNodeMediaAction(input: {
  action: "camera_snap" | "photos_latest" | "camera_clip" | "screen_record" | "screen_snapshot";
  params: Record<string, unknown>;
  gatewayOpts: GatewayCallOptions;
  modelHasVision?: boolean;
  imageSanitization: ImageSanitizationLimits;
}): Promise<AgentToolResult<unknown>> {
  const { params, modelHasVision, imageSanitization } = input;
  const resolvedNode = await resolveAgentNode(
    input.gatewayOpts,
    readToolStringParam(input.params, "node", { required: true }),
  );
  const invoke = async (
    command: string,
    commandParams: Record<string, unknown>,
    recordingDurationMs?: number,
  ) => {
    const timeouts =
      recordingDurationMs === undefined
        ? undefined
        : resolveNodesToolInvokeTimeouts({
            input: input.params,
            gatewayOpts: input.gatewayOpts,
            operationTimeoutMs: recordingDurationMs,
          });
    const raw = await callNodesToolNodeInvoke<{ payload: unknown }>(
      timeouts?.gatewayOpts ?? input.gatewayOpts,
      {
        nodeId: resolvedNode.nodeId,
        command,
        params: commandParams,
        ...(timeouts ? { timeoutMs: timeouts.invokeTimeoutMs } : {}),
        idempotencyKey: crypto.randomUUID(),
      },
    );
    return raw?.payload;
  };
  switch (input.action) {
    case "camera_snap":
    case "photos_latest": {
      let facing: "front" | "back" | "both" | undefined;
      let limit = DEFAULT_PHOTOS_LIMIT;
      if (input.action === "camera_snap") {
        const value = normalizeLowercaseStringOrEmpty(params.facing) || "front";
        if (value !== "both" && value !== "front" && value !== "back") {
          throw new Error("invalid facing (front|back|both)");
        }
        facing = value;
      } else {
        limit = Math.min(readPositiveIntegerParam(params, "limit") ?? limit, MAX_PHOTOS_LIMIT);
      }
      const maxWidth = readPositiveIntegerParam(params, "maxWidth") ?? DEFAULT_PHOTOS_MAX_WIDTH;
      const quality =
        readFiniteNumberParam(params, "quality", {
          min: 0,
          max: 1,
          message: "quality must be between 0 and 1",
        }) ?? (facing ? 0.95 : DEFAULT_PHOTOS_QUALITY);
      let photos: ValidatedNodePhoto[] = [];
      if (facing) {
        const delayMs = readNonNegativeIntegerParam(params, "delayMs");
        const deviceId = normalizeOptionalString(params.deviceId);
        if (deviceId && facing === "both" && resolvedNode.platform?.toLowerCase() !== "linux") {
          throw new Error("facing=both is not allowed when deviceId is set");
        }
        const targets = resolveCameraSnapTargets({
          facing,
          platform: resolvedNode.platform,
          deviceId,
        });
        for (const target of targets) {
          const payload = await invoke("camera.snap", {
            facing: target.requestFacing,
            maxWidth,
            quality,
            format: "jpg",
            delayMs,
            deviceId,
          });
          const photo = parseCameraSnapPayload(payload, { expectedHost: resolvedNode.remoteIp });
          photos.push({
            ...validateNodePhoto(photo, "camera.snap"),
            facing: target.artifactFacing,
          });
        }
      } else {
        const payload = await invoke("photos.latest", { limit, maxWidth, quality });
        if (!isRecord(payload) || !Array.isArray(payload.photos)) {
          throw new Error("invalid photos.latest payload");
        }
        if (payload.photos.length > limit) {
          throw new Error(
            `photos.latest returned ${payload.photos.length} photos; requested at most ${limit}`,
          );
        }
        // Validate the complete native batch before the shared owner writes private artifacts.
        photos = payload.photos.map((photoRaw) => {
          const photo = parseCameraSnapPayload(photoRaw, { expectedHost: resolvedNode.remoteIp });
          return Object.assign(validateNodePhoto(photo, "photos.latest"), {
            createdAt: isRecord(photoRaw) ? photoRaw.createdAt : undefined,
          });
        });
      }
      return await createNodePhotoResult({
        kind: facing ? "snaps" : "photos",
        photos,
        expectedHost: resolvedNode.remoteIp,
        modelHasVision,
        imageSanitization,
      });
    }
    case "camera_clip":
    case "screen_record": {
      let cameraTarget: ReturnType<typeof resolveCameraClipTarget> | undefined;
      if (input.action === "camera_clip") {
        const facing = normalizeLowercaseStringOrEmpty(params.facing) || "front";
        if (facing !== "front" && facing !== "back") {
          throw new Error("invalid facing (front|back)");
        }
        cameraTarget = resolveCameraClipTarget({ facing, platform: resolvedNode.platform });
      }
      const durationMs = Math.min(
        readPositiveIntegerParam(params, "durationMs") ??
          (typeof params.duration === "string"
            ? parseDurationMs(params.duration)
            : cameraTarget
              ? 3000
              : 10_000),
        MAX_RECORDING_DURATION_MS,
      );
      let fps: number | undefined;
      let screenIndex: number | undefined;
      if (!cameraTarget) {
        fps =
          readFiniteNumberParam(params, "fps", {
            min: 0,
            minExclusive: true,
            message: "fps must be greater than 0",
          }) ?? 10;
        screenIndex = readNonNegativeIntegerParam(params, "screenIndex") ?? 0;
      }
      const includeAudio = typeof params.includeAudio === "boolean" ? params.includeAudio : true;
      const raw = await invoke(
        cameraTarget ? "camera.clip" : "screen.record",
        cameraTarget
          ? {
              facing: cameraTarget.requestFacing,
              durationMs,
              includeAudio,
              format: "mp4",
              deviceId: normalizeOptionalString(params.deviceId),
            }
          : { durationMs, screenIndex, fps, format: "mp4", includeAudio },
        durationMs,
      );
      if (cameraTarget) {
        const payload = parseCameraClipPayload(raw);
        const filePath = await writeCameraClipPayloadToFile({
          payload,
          facing: cameraTarget.artifactFacing,
          expectedHost: resolvedNode.remoteIp,
        });
        return textResult(`FILE:${filePath}`, {
          facing: cameraTarget.artifactFacing,
          path: filePath,
          durationMs: payload.durationMs,
          hasAudio: payload.hasAudio,
        });
      }
      const payload = parseScreenRecordPayload(raw);
      const ext = payload.format || "mp4";
      const outPath = normalizeOptionalString(params.outPath);
      assertMediaOutPathFormat({ command: "screen.record", outPath, format: ext });
      const filePath = outPath ?? screenRecordTempPath({ ext });
      const written = await writeScreenRecordToFile(filePath, payload.base64);
      return textResult(`FILE:${written.path}`, {
        path: written.path,
        durationMs: payload.durationMs,
        fps: payload.fps,
        screenIndex: payload.screenIndex,
        hasAudio: payload.hasAudio,
      });
    }
    case "screen_snapshot": {
      const screenIndex = readNonNegativeIntegerParam(params, "screenIndex") ?? 0;
      const maxWidth = readPositiveIntegerParam(params, "maxWidth");
      const outPath = normalizeOptionalString(params.outPath);
      // The node owns the encoding choice, so ask for the one the caller's filename
      // already promises instead of letting the default contradict it.
      const requestedFormat = outPath ? screenSnapshotFormatForPath(outPath) : undefined;
      const payload = parseScreenSnapshotResult(
        await invoke("screen.snapshot", {
          screenIndex,
          maxWidth,
          format: requestedFormat,
        }),
      );
      const ext = payload.format === "png" ? "png" : "jpg";
      assertMediaOutPathFormat({ command: "screen.snapshot", outPath, format: ext });
      const filePath = outPath ?? screenSnapshotTempPath({ ext });
      const written = await writeScreenSnapshotToFile(filePath, payload.base64);
      return textResult(`FILE:${written.path}`, {
        path: written.path,
        format: payload.format,
        displayFrameId: payload.displayFrameId,
        screenIndex: payload.screenIndex,
        width: payload.width,
        height: payload.height,
        media: {
          mediaUrl: written.path,
        },
      });
    }
    default:
      throw new Error(`Unknown action: ${String(input.action satisfies never)}`);
  }
}

function validateNodePhoto(
  photo: ReturnType<typeof parseCameraSnapPayload>,
  command: "camera.snap" | "photos.latest",
) {
  const format = normalizeLowercaseStringOrEmpty(photo.format);
  if (format !== "jpg" && format !== "jpeg" && format !== "png") {
    throw new Error(`unsupported ${command} format: ${photo.format}`);
  }
  return { photo, isJpeg: format !== "png" };
}

type ValidatedNodePhoto = ReturnType<typeof validateNodePhoto> & {
  facing?: CameraArtifactFacing;
  createdAt?: unknown;
};

async function createNodePhotoResult(params: {
  kind: "snaps" | "photos";
  photos: ValidatedNodePhoto[];
  expectedHost?: string;
  modelHasVision?: boolean;
  imageSanitization: ImageSanitizationLimits;
}): Promise<AgentToolResult<unknown>> {
  const generatedPaths = params.photos.map(({ facing, isJpeg }) =>
    cameraTempPath({
      kind: "snap",
      ...(facing ? { facing } : { id: crypto.randomUUID() }),
      ext: isJpeg ? "jpg" : "png",
    }),
  );
  return await withCameraArtifactBatch(generatedPaths, async (filePaths) => {
    const command = params.kind === "snaps" ? "camera.snap" : "photos.latest";
    const content: AgentToolResult<unknown>["content"] = [];
    const details: Array<Record<string, unknown> & { path: string }> = [];
    for (const [index, { photo, facing, createdAt, isJpeg }] of params.photos.entries()) {
      const filePath = filePaths[index];
      if (filePath === undefined) {
        throw new Error("missing camera batch output path");
      }
      await writeCameraPayloadToFile({
        filePath,
        payload: photo,
        expectedHost: params.expectedHost,
        invalidPayloadMessage: `invalid ${command} payload`,
      });
      content.push(
        params.modelHasVision && photo.base64
          ? {
              type: "image",
              data: photo.base64,
              mimeType: imageMimeFromFormat(photo.format) ?? (isJpeg ? "image/jpeg" : "image/png"),
            }
          : {
              type: "text",
              text: `${facing ? "Camera" : "Library"} photo saved to ${filePath}.`,
            },
      );
      details.push({
        ...(facing ? { facing } : { index }),
        path: filePath,
        width: photo.width,
        height: photo.height,
        ...(typeof createdAt === "string" ? { createdAt } : {}),
      });
    }
    if (details.length === 0) {
      content.push({ type: "text", text: "No photos found." });
    }
    const mediaUrls = details.map((entry) => entry.path);
    return await sanitizeToolResultImages(
      {
        content,
        details: details.length > 0 ? { [params.kind]: details, media: { mediaUrls } } : [],
      },
      params.kind === "snaps" ? "nodes:camera_snap" : "nodes:photos_latest",
      params.imageSanitization,
    );
  });
}

/**
 * Refuses to write media whose bytes contradict the caller's filename.
 *
 * `outPath` is workspace-guarded before this tool runs and that guard
 * alias-checks the exact final segment, so the extension cannot be corrected
 * here; the caller has to name the artifact for what it is.
 */
function assertMediaOutPathFormat(params: {
  command: string;
  outPath?: string;
  format: string;
}): void {
  if (!params.outPath || mediaPathMatchesFormat(params.outPath, params.format)) {
    return;
  }
  throw new Error(
    `${params.command} returned ${params.format}; outPath must use a matching extension (got ${extnameFromAnyPath(params.outPath)})`,
  );
}

const DEFAULT_PHOTOS_LIMIT = 1;
const MAX_PHOTOS_LIMIT = 20;
const DEFAULT_PHOTOS_MAX_WIDTH = 1600;
const DEFAULT_PHOTOS_QUALITY = 0.85;
