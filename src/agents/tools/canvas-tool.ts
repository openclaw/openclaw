import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { writeBase64ToFile } from "../../cli/nodes-camera.js";
import { canvasSnapshotTempPath, parseCanvasSnapshotPayload } from "../../cli/nodes-canvas.js";
import type { OpenClawConfig } from "../../config/config.js";
import { logVerbose, shouldLogVerbose } from "../../globals.js";
import { isInboundPathAllowed } from "../../media/inbound-path-policy.js";
import { getDefaultMediaLocalRoots } from "../../media/local-roots.js";
import { imageMimeFromFormat } from "../../media/mime.js";
import { resolveImageSanitizationLimits } from "../image-sanitization.js";
import { optionalStringEnum, stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, imageResult, jsonResult, readStringParam } from "./common.js";
import { callGatewayTool, readGatewayCallOptions } from "./gateway.js";
import { resolveNodeId } from "./nodes-utils.js";
import { dispatchNodeInvokeGuarded, NodeInvokeBlockedError } from "./node-invoke-guard.js";

const CANVAS_ACTIONS = [
  "present",
  "hide",
  "navigate",
  "eval",
  "snapshot",
  "a2ui_push",
  "a2ui_reset",
] as const;

const CANVAS_SNAPSHOT_FORMATS = ["png", "jpg", "jpeg"] as const;

async function readJsonlFromPath(jsonlPath: string): Promise<string> {
  const trimmed = jsonlPath.trim();
  if (!trimmed) {
    return "";
  }
  const resolved = path.resolve(trimmed);
  const roots = getDefaultMediaLocalRoots();
  if (!isInboundPathAllowed({ filePath: resolved, roots })) {
    if (shouldLogVerbose()) {
      logVerbose(`Blocked canvas jsonlPath outside allowed roots: ${resolved}`);
    }
    throw new Error("jsonlPath outside allowed roots");
  }
  const canonical = await fs.realpath(resolved).catch(() => resolved);
  if (!isInboundPathAllowed({ filePath: canonical, roots })) {
    if (shouldLogVerbose()) {
      logVerbose(`Blocked canvas jsonlPath outside allowed roots: ${canonical}`);
    }
    throw new Error("jsonlPath outside allowed roots");
  }
  return await fs.readFile(canonical, "utf8");
}

// Flattened schema: runtime validates per-action requirements.
const CanvasToolSchema = Type.Object({
  action: stringEnum(CANVAS_ACTIONS),
  gatewayUrl: Type.Optional(Type.String()),
  gatewayToken: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Number()),
  node: Type.Optional(Type.String()),
  // present
  target: Type.Optional(Type.String()),
  x: Type.Optional(Type.Number()),
  y: Type.Optional(Type.Number()),
  width: Type.Optional(Type.Number()),
  height: Type.Optional(Type.Number()),
  // navigate
  url: Type.Optional(Type.String()),
  // eval
  javaScript: Type.Optional(Type.String()),
  // snapshot
  outputFormat: optionalStringEnum(CANVAS_SNAPSHOT_FORMATS),
  maxWidth: Type.Optional(Type.Number()),
  quality: Type.Optional(Type.Number()),
  delayMs: Type.Optional(Type.Number()),
  // a2ui_push
  jsonl: Type.Optional(Type.String()),
  jsonlPath: Type.Optional(Type.String()),
});

// Helper to detect blocked responses (contains outcome field indicating block)
const isBlockedResponse = (result: unknown): boolean => {
  if (!result || typeof result !== "object") {
    return false;
  }
  const obj = result as Record<string, unknown>;
  return (
    obj.outcome === "ABSTAIN_CONFIRM" ||
    obj.outcome === "ABSTAIN_CLARIFY" ||
    obj.status === "blocked"
  );
};

export function createCanvasTool(options?: { config?: OpenClawConfig }): AnyAgentTool {
  const imageSanitization = resolveImageSanitizationLimits(options?.config);
  return {
    label: "Canvas",
    name: "canvas",
    description:
      "Control node canvases (present/hide/navigate/eval/snapshot/A2UI). Use snapshot to capture the rendered UI.",
    parameters: CanvasToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const gatewayOpts = readGatewayCallOptions(params);

      const nodeId = await resolveNodeId(
        gatewayOpts,
        readStringParam(params, "node", { trim: true }),
        true,
      );

      const invoke = async (command: string, invokeParams?: Record<string, unknown>) => {
        try {
          // Dispatch through NODE_INVOKE guarded wrapper (handles gating and fail-closed behavior)
          return await dispatchNodeInvokeGuarded(
            command,
            nodeId,
            {
              nodeId,
              command,
              params: invokeParams,
              idempotencyKey: crypto.randomUUID(),
            },
            gatewayOpts,
          );
        } catch (err: unknown) {
          // Handle blocked NODE_INVOKE outcomes via structured error
          if (err instanceof NodeInvokeBlockedError) {
            // Return blocked response instead of throwing
            return jsonResult({
              status: "blocked",
              outcome: err.data.outcome,
              reason: err.data.reason,
              contractId: err.data.contractId ?? null,
              instructions: err.data.instructions ?? "",
              stageId: "NODE_INVOKE",
            });
          }
          // Re-throw if not a gating error
          throw err;
        }
      };
      
             // SECURITY INVARIANT:
             // All canvas actions MUST propagate blocked responses returned by the ClarityBurst gate.
             // A blocked gate outcome (ABSTAIN_CONFIRM or ABSTAIN_CLARIFY) must be returned immediately
             // before any success payload is constructed. Returning success after a blocked outcome
             // would violate ClarityBurst execution authorization guarantees and allow unsafe
             // operations to appear successful. All canvas actions must therefore call
             // `invokeWithBlockCheck()` before formatting action-specific success responses.

             // Helper: wrap invoke() and guarantee blocked responses are returned first
             // Returns { blocked, invokeResult } where blocked is the response if blocked, else null
             const invokeWithBlockCheck = async (
               command: string,
               invokeParams?: Record<string, unknown>
             ): Promise<{ blocked: AgentToolResult<unknown> | null; invokeResult: AgentToolResult<unknown> }> => {
               const invokeResult = (await invoke(command, invokeParams)) as AgentToolResult<unknown>;
               const blocked = isBlockedResponse(invokeResult?.details) ? invokeResult : null;
               return { blocked, invokeResult };
             };

      switch (action) {
        case "present": {
          const placement = {
            x: typeof params.x === "number" ? params.x : undefined,
            y: typeof params.y === "number" ? params.y : undefined,
            width: typeof params.width === "number" ? params.width : undefined,
            height: typeof params.height === "number" ? params.height : undefined,
          };
          const invokeParams: Record<string, unknown> = {};
          // Accept both `target` and `url` for present to match common caller expectations.
          // `target` remains the canonical field for CLI compatibility.
          const presentTarget =
            readStringParam(params, "target", { trim: true }) ??
            readStringParam(params, "url", { trim: true });
          if (presentTarget) {
            invokeParams.url = presentTarget;
          }
          if (
            Number.isFinite(placement.x) ||
            Number.isFinite(placement.y) ||
            Number.isFinite(placement.width) ||
            Number.isFinite(placement.height)
          ) {
            invokeParams.placement = placement;
          }
          const { blocked } = await invokeWithBlockCheck("canvas.present", invokeParams);
          if (blocked) {
            return blocked;
          }
          return jsonResult({ ok: true });
        }
        case "hide": {
          const { blocked } = await invokeWithBlockCheck("canvas.hide", undefined);
          if (blocked) {
            return blocked;
          }
          return jsonResult({ ok: true });
        }
        case "navigate": {
          // Support `target` as an alias so callers can reuse the same field across present/navigate.
          const url =
            readStringParam(params, "url", { trim: true }) ??
            readStringParam(params, "target", { required: true, trim: true, label: "url" });
          const { blocked } = await invokeWithBlockCheck("canvas.navigate", { url });
          if (blocked) {
            return blocked;
          }
          return jsonResult({ ok: true });
        }
        case "eval": {
          const javaScript = readStringParam(params, "javaScript", {
            required: true,
          });
          const { blocked, invokeResult } = await invokeWithBlockCheck("canvas.eval", { javaScript });
          if (blocked) {
            return blocked;
          }
          const raw = invokeResult?.details as {
            payload?: { result?: string };
          } | undefined;
          const result = raw?.payload?.result;
          if (result) {
            return {
              content: [{ type: "text", text: result }],
              details: { result },
            };
          }
          return jsonResult({ ok: true });
        }
        case "snapshot": {
          const formatRaw =
            typeof params.outputFormat === "string" ? params.outputFormat.toLowerCase() : "png";
          const format = formatRaw === "jpg" || formatRaw === "jpeg" ? "jpeg" : "png";
          const maxWidth =
            typeof params.maxWidth === "number" && Number.isFinite(params.maxWidth)
              ? params.maxWidth
              : undefined;
          const quality =
            typeof params.quality === "number" && Number.isFinite(params.quality)
              ? params.quality
              : undefined;
          const { blocked, invokeResult } = await invokeWithBlockCheck("canvas.snapshot", {
            format,
            maxWidth,
            quality,
          });
          if (blocked) {
            return blocked;
          }
          const raw = invokeResult?.details as { payload?: unknown } | undefined;
          const payload = parseCanvasSnapshotPayload(raw?.payload);
          const filePath = canvasSnapshotTempPath({
            ext: payload.format === "jpeg" ? "jpg" : payload.format,
          });
          await writeBase64ToFile(filePath, payload.base64);
          const mimeType = imageMimeFromFormat(payload.format) ?? "image/png";
          return await imageResult({
            label: "canvas:snapshot",
            path: filePath,
            base64: payload.base64,
            mimeType,
            details: { format: payload.format },
            imageSanitization,
          });
        }
        case "a2ui_push": {
          const jsonl =
            typeof params.jsonl === "string" && params.jsonl.trim()
              ? params.jsonl
              : typeof params.jsonlPath === "string" && params.jsonlPath.trim()
                ? await readJsonlFromPath(params.jsonlPath)
                : "";
          if (!jsonl.trim()) {
            throw new Error("jsonl or jsonlPath required");
          }
          const { blocked } = await invokeWithBlockCheck("canvas.a2ui.pushJSONL", { jsonl });
          if (blocked) {
            return blocked;
          }
          return jsonResult({ ok: true });
        }
        case "a2ui_reset": {
          const { blocked } = await invokeWithBlockCheck("canvas.a2ui.reset", undefined);
          if (blocked) {
            return blocked;
          }
          return jsonResult({ ok: true });
        }
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    },
  };
}
