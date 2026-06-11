import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { registerPluginInteractiveHandler } from "../plugins/interactive-registry.js";
import {
  isPatternLabAssetType,
  normalizePatternLabAssetType,
  type PatternLabAssetReviewAction,
} from "./pattern-lab-dashboard-data.js";

const PATTERN_LAB_PLUGIN_ID = "pattern-lab";
export const PATTERN_LAB_DISCORD_NAMESPACE = "patternlab";
const execFileAsync = promisify(execFile);
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

type DiscordPatternLabInteractionContext = {
  auth?: {
    isAuthorizedSender?: boolean;
  };
  interaction?: {
    payload?: string;
  };
  respond?: {
    reply?: (params: { text: string; ephemeral?: boolean }) => Promise<void>;
    acknowledge?: () => Promise<void>;
  };
};

type PatternLabDiscordPayload = {
  action?: unknown;
  videoId?: unknown;
  assetType?: unknown;
  assetId?: unknown;
  filename?: unknown;
  reason?: unknown;
};

function cleanString(value: unknown): string | undefined {
  const normalized = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  return normalized || undefined;
}

function parsePatternLabDiscordPayload(raw: string | undefined): PatternLabDiscordPayload {
  const payload = cleanString(raw);
  if (!payload) {
    throw new Error("Missing Pattern Lab review payload");
  }
  const parsed = JSON.parse(payload) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Pattern Lab review payload must be an object");
  }
  return parsed as PatternLabDiscordPayload;
}

function normalizePatternLabDiscordAction(value: unknown): PatternLabAssetReviewAction {
  const action = cleanString(value);
  if (
    action === "approve" ||
    action === "approve_private_upload" ||
    action === "approve_public_publish" ||
    action === "reject" ||
    action === "regenerate" ||
    action === "repair" ||
    action === "revise_hook" ||
    action === "kill_topic" ||
    action === "status"
  ) {
    return action;
  }
  throw new Error(`Unsupported Pattern Lab Discord action: ${String(value)}`);
}

function labelForAction(action: PatternLabAssetReviewAction): string {
  if (action === "approve") {
    return "Approved";
  }
  if (action === "approve_private_upload") {
    return "Private upload approved";
  }
  if (action === "approve_public_publish") {
    return "Public publish approval logged";
  }
  if (action === "reject") {
    return "Rejected";
  }
  if (action === "revise_hook") {
    return "Hook revision queued";
  }
  if (action === "kill_topic") {
    return "Topic rejected";
  }
  if (action === "regenerate") {
    return "Regeneration queued";
  }
  if (action === "repair") {
    return "Repair queued";
  }
  return "Status checked";
}

function resolvePatternLabReviewScript(): string {
  const candidates = [
    path.resolve(MODULE_DIR, "../youtube-v1/scripts/patternlab_review_action.py"),
    path.resolve(MODULE_DIR, "../../youtube-v1/scripts/patternlab_review_action.py"),
    path.resolve(MODULE_DIR, "../../../youtube-v1/scripts/patternlab_review_action.py"),
    path.resolve(process.cwd(), "youtube-v1/scripts/patternlab_review_action.py"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[candidates.length - 1] ?? "";
}

function repoRootForPatternLabScript(scriptPath: string): string {
  return path.dirname(path.dirname(path.dirname(scriptPath)));
}

async function runPatternLabReviewAction(callbackPayload: PatternLabDiscordPayload): Promise<{
  rowsChanged: number;
  eventId?: string;
  queuePath?: string;
  gateFile?: string;
}> {
  const script = resolvePatternLabReviewScript();
  const callback = `${PATTERN_LAB_DISCORD_NAMESPACE}:${JSON.stringify(callbackPayload)}`;
  const { stdout } = await execFileAsync(
    "python3",
    [script, "--callback", callback, "--no-auto-repair", "--no-auto-upload"],
    {
      cwd: repoRootForPatternLabScript(script),
      maxBuffer: 1024 * 1024,
    },
  );
  const lines = stdout.split(/\r?\n/);
  const jsonLineIndex = lines.findIndex((line) => line.trim() === "{");
  if (jsonLineIndex < 0) {
    throw new Error(`Pattern Lab review action did not return JSON: ${stdout.trim()}`);
  }
  const parsed = JSON.parse(lines.slice(jsonLineIndex).join("\n")) as {
    rows_changed?: unknown;
    event?: { event_id?: unknown };
    repair_file?: unknown;
    gate_file?: unknown;
  };
  return {
    rowsChanged: typeof parsed.rows_changed === "number" ? parsed.rows_changed : 0,
    ...(typeof parsed.event?.event_id === "string" ? { eventId: parsed.event.event_id } : {}),
    ...(typeof parsed.repair_file === "string" && parsed.repair_file
      ? { queuePath: parsed.repair_file }
      : {}),
    ...(typeof parsed.gate_file === "string" && parsed.gate_file
      ? { gateFile: parsed.gate_file }
      : {}),
  };
}

function isRepairAction(action: PatternLabAssetReviewAction): boolean {
  return (
    action === "reject" ||
    action === "repair" ||
    action === "regenerate" ||
    action === "revise_hook" ||
    action === "kill_topic"
  );
}

function isPrivateUploadAction(action: PatternLabAssetReviewAction): boolean {
  return action === "approve_private_upload";
}

function startPatternLabRepairWorker(videoId: string, eventId: string): void {
  const reviewScript = resolvePatternLabReviewScript();
  const scriptsDir = path.dirname(reviewScript);
  const processor = path.join(scriptsDir, "process_repair_queue.py");
  if (!fs.existsSync(processor)) {
    return;
  }
  const child = spawn(
    "python3",
    [processor, "--video-id", videoId, "--limit", "1", "--event-id", eventId],
    {
      cwd: repoRootForPatternLabScript(reviewScript),
      detached: true,
      stdio: "ignore",
    },
  );
  child.unref();
}

function startPatternLabPrivateUploadWorker(videoId: string): void {
  const reviewScript = resolvePatternLabReviewScript();
  const scriptsDir = path.dirname(reviewScript);
  const uploader = path.join(scriptsDir, "upload_approved_package.py");
  if (!fs.existsSync(uploader)) {
    return;
  }
  const child = spawn("python3", [uploader, "--video-id", videoId, "--live"], {
    cwd: repoRootForPatternLabScript(reviewScript),
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

function buildResponseText(params: {
  action: PatternLabAssetReviewAction;
  assetType: string;
  rowsMatched: number;
  queuePath?: string;
  gateFile?: string;
}): string {
  const queueLine = params.queuePath ? `\nQueue: ${params.queuePath}` : "";
  const gateLine = params.gateFile ? `\nGate file: ${params.gateFile}` : "";
  return [
    `${labelForAction(params.action)} ${params.assetType}.`,
    `Updated ${params.rowsMatched} rights-ledger row${params.rowsMatched === 1 ? "" : "s"}.`,
    "Public publishing is still blocked until explicit owner approval.",
    queueLine,
    gateLine,
  ]
    .filter(Boolean)
    .join("\n");
}

export function registerPatternLabDiscordInteractiveHandler(): void {
  const result = registerPluginInteractiveHandler(PATTERN_LAB_PLUGIN_ID, {
    channel: "discord",
    namespace: PATTERN_LAB_DISCORD_NAMESPACE,
    handler: async (rawContext: unknown) => {
      const context = rawContext as DiscordPatternLabInteractionContext;
      if (!context.auth?.isAuthorizedSender) {
        await context.respond?.reply?.({
          text: "Pattern Lab review controls are owner-only.",
          ephemeral: true,
        });
        return { handled: true };
      }

      try {
        const payload = parsePatternLabDiscordPayload(context.interaction?.payload);
        const action = normalizePatternLabDiscordAction(payload.action);
        const rawAssetType = cleanString(payload.assetType);
        const assetType =
          rawAssetType && isPatternLabAssetType(rawAssetType)
            ? normalizePatternLabAssetType(rawAssetType)
            : (rawAssetType ?? "gate");
        const result = await runPatternLabReviewAction({
          ...payload,
          action,
          assetType: rawAssetType,
          reason: cleanString(payload.reason) ?? "discord-review-button",
        });
        await context.respond?.reply?.({
          text: buildResponseText({
            action,
            assetType,
            rowsMatched: result.rowsChanged,
            queuePath: result.queuePath,
            gateFile: result.gateFile,
          }),
          ephemeral: true,
        });
        if (isRepairAction(action) && result.eventId) {
          startPatternLabRepairWorker(cleanString(payload.videoId) ?? "01", result.eventId);
        }
        if (isPrivateUploadAction(action)) {
          startPatternLabPrivateUploadWorker(cleanString(payload.videoId) ?? "01");
        }
      } catch (error) {
        await context.respond?.reply?.({
          text: `Pattern Lab review action failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          ephemeral: true,
        });
      }
      return { handled: true };
    },
  });

  if (
    !result.ok &&
    !result.error?.includes(`already registered by plugin "${PATTERN_LAB_PLUGIN_ID}"`)
  ) {
    throw new Error(result.error ?? "Pattern Lab Discord interactive handler registration failed");
  }
}

export function buildPatternLabDiscordCallbackData(params: {
  action: PatternLabAssetReviewAction;
  assetType: unknown;
  videoId?: string;
  assetId?: string;
  filename?: string;
  reason?: string;
}): string {
  if (!isPatternLabAssetType(params.assetType)) {
    throw new Error(`Unsupported Pattern Lab asset type: ${String(params.assetType)}`);
  }
  return `${PATTERN_LAB_DISCORD_NAMESPACE}:${JSON.stringify({
    action: params.action,
    assetType: params.assetType,
    videoId: params.videoId,
    ...(params.assetId ? { assetId: params.assetId } : {}),
    ...(params.filename ? { filename: params.filename } : {}),
    ...(params.reason ? { reason: params.reason } : {}),
  })}`;
}
