import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { isForegroundRestrictedPluginNodeCommand } from "../node-command-policy.js";

/** Queues only commands that iOS explicitly rejected as requiring the foreground. */
export function shouldQueueAsPendingForegroundAction(params: {
  platform?: string;
  command: string;
  error: unknown;
}): boolean {
  const platform = normalizeLowercaseStringOrEmpty(params.platform);
  if (!platform.startsWith("ios") && !platform.startsWith("ipados")) {
    return false;
  }
  if (
    !isForegroundRestrictedPluginNodeCommand(params.command) &&
    !params.command.startsWith("camera.") &&
    !params.command.startsWith("screen.") &&
    !params.command.startsWith("talk.")
  ) {
    return false;
  }
  const error =
    params.error && typeof params.error === "object"
      ? (params.error as { code?: unknown; message?: unknown })
      : null;
  const code = normalizeOptionalString(error?.code)?.toUpperCase() ?? "";
  const message = normalizeOptionalString(error?.message)?.toUpperCase() ?? "";
  return code === "NODE_BACKGROUND_UNAVAILABLE" || message.includes("BACKGROUND_UNAVAILABLE");
}

// Only fixed observations and cancellation have no independently running native work.
// Plugin commands, browser/desktop control, MCP and arbitrary execution need custody
// that the public node transport cannot currently provide.
const FOREGROUND_NODE_OBSERVATIONS = new Set([
  "system.which",
  "fs.listDir",
  "device.info",
  "device.status",
  "device.permissions",
  "device.health",
  "device.apps",
  "camera.list",
  "camera.ptz.status",
  "screen.snapshot",
  "mobile.ui.observe",
  "location.get",
  "notifications.list",
  "contacts.search",
  "calendar.events",
  "callLog.search",
  "reminders.list",
  "photos.latest",
  "motion.activity",
  "motion.pedometer",
  "watch.status",
  "talk.ptt.cancel",
]);

export function isNodeForegroundObservation(command: string): boolean {
  return FOREGROUND_NODE_OBSERVATIONS.has(command);
}
