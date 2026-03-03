import type { OpenClawConfig } from "../config/config.js";
import {
  NODE_BROWSER_PROXY_COMMAND,
  NODE_SYSTEM_NOTIFY_COMMAND,
  NODE_SYSTEM_RUN_COMMANDS,
} from "../infra/node-commands.js";
import { normalizeDeviceMetadataForPolicy } from "./device-metadata-normalization.js";
import type { NodeSession } from "./node-registry.js";

const CANVAS_COMMANDS = [
  "canvas.present",
  "canvas.hide",
  "canvas.navigate",
  "canvas.eval",
  "canvas.snapshot",
  "canvas.a2ui.push",
  "canvas.a2ui.pushJSONL",
  "canvas.a2ui.reset",
];

const CAMERA_COMMANDS = ["camera.list"];
const CAMERA_DANGEROUS_COMMANDS = ["camera.snap", "camera.clip"];

const SCREEN_DANGEROUS_COMMANDS = ["screen.record"];

const LOCATION_COMMANDS = ["location.get"];
const NOTIFICATION_COMMANDS = ["notifications.list"];
const ANDROID_NOTIFICATION_COMMANDS = [...NOTIFICATION_COMMANDS, "notifications.actions"];

const DEVICE_COMMANDS = ["device.info", "device.status"];
const ANDROID_DEVICE_COMMANDS = [...DEVICE_COMMANDS, "device.permissions", "device.health"];

const CONTACTS_COMMANDS = ["contacts.search"];
const CONTACTS_DANGEROUS_COMMANDS = ["contacts.add"];

const CALENDAR_COMMANDS = ["calendar.events"];
const CALENDAR_DANGEROUS_COMMANDS = ["calendar.add"];

const REMINDERS_COMMANDS = ["reminders.list"];
const REMINDERS_DANGEROUS_COMMANDS = ["reminders.add"];

const PHOTOS_COMMANDS = ["photos.latest"];

const MOTION_COMMANDS = ["motion.activity", "motion.pedometer"];

// Extended iOS node commands. The OpenClaw iOS app (openclaw-app) registers
// additional read-only commands beyond the base set shared with other platforms.
// These are safe by default — all read-only, consent-gated on the device side.
const IOS_LOCATION_COMMANDS = [
  ...LOCATION_COMMANDS,
  "location.geocode",
  "location.search",
  "location.distance",
  "location.monitor.start",
  "location.monitor.stop",
  "location.status",
];
const IOS_DEVICE_COMMANDS = [
  ...DEVICE_COMMANDS,
  "device.battery",
  "device.network",
  "device.storage",
  "device.screen",
  "device.display",
  "device.locale",
];
const IOS_CONTACTS_COMMANDS = [
  ...CONTACTS_COMMANDS,
  "contacts.get",
  "contacts.count",
  "contacts.status",
];
const IOS_CALENDAR_COMMANDS = [
  ...CALENDAR_COMMANDS,
  "calendar.today",
  "calendar.upcoming",
  "calendar.search",
  "calendar.calendars",
  "calendar.status",
];
const IOS_HEALTH_COMMANDS = [
  "health.steps",
  "health.heartRate",
  "health.sleep",
  "health.workouts",
  "health.energy",
  "health.summary",
  "health.status",
];
const IOS_MOTION_COMMANDS = [...MOTION_COMMANDS, "motion.altitude", "motion.status"];

const SMS_DANGEROUS_COMMANDS = ["sms.send"];

// iOS nodes don't implement system.run/which, but they do support notifications.
const IOS_SYSTEM_COMMANDS = [NODE_SYSTEM_NOTIFY_COMMAND];

const SYSTEM_COMMANDS = [
  ...NODE_SYSTEM_RUN_COMMANDS,
  NODE_SYSTEM_NOTIFY_COMMAND,
  NODE_BROWSER_PROXY_COMMAND,
];
const UNKNOWN_PLATFORM_COMMANDS = [
  ...CANVAS_COMMANDS,
  ...CAMERA_COMMANDS,
  ...LOCATION_COMMANDS,
  NODE_SYSTEM_NOTIFY_COMMAND,
];

// "High risk" node commands. These can be enabled by explicitly adding them to
// `gateway.nodes.allowCommands` (and ensuring they're not blocked by denyCommands).
export const DEFAULT_DANGEROUS_NODE_COMMANDS = [
  ...CAMERA_DANGEROUS_COMMANDS,
  ...SCREEN_DANGEROUS_COMMANDS,
  ...CONTACTS_DANGEROUS_COMMANDS,
  ...CALENDAR_DANGEROUS_COMMANDS,
  ...REMINDERS_DANGEROUS_COMMANDS,
  ...SMS_DANGEROUS_COMMANDS,
];

const PLATFORM_DEFAULTS: Record<string, string[]> = {
  ios: [
    ...CANVAS_COMMANDS,
    ...CAMERA_COMMANDS,
    ...IOS_LOCATION_COMMANDS,
    ...IOS_DEVICE_COMMANDS,
    ...IOS_CONTACTS_COMMANDS,
    ...IOS_CALENDAR_COMMANDS,
    ...IOS_HEALTH_COMMANDS,
    ...REMINDERS_COMMANDS,
    ...PHOTOS_COMMANDS,
    ...IOS_MOTION_COMMANDS,
    ...IOS_SYSTEM_COMMANDS,
  ],
  android: [
    ...CANVAS_COMMANDS,
    ...CAMERA_COMMANDS,
    ...LOCATION_COMMANDS,
    ...ANDROID_NOTIFICATION_COMMANDS,
    NODE_SYSTEM_NOTIFY_COMMAND,
    ...ANDROID_DEVICE_COMMANDS,
    ...CONTACTS_COMMANDS,
    ...CALENDAR_COMMANDS,
    ...REMINDERS_COMMANDS,
    ...PHOTOS_COMMANDS,
    ...MOTION_COMMANDS,
  ],
  macos: [
    ...CANVAS_COMMANDS,
    ...CAMERA_COMMANDS,
    ...LOCATION_COMMANDS,
    ...DEVICE_COMMANDS,
    ...CONTACTS_COMMANDS,
    ...CALENDAR_COMMANDS,
    ...REMINDERS_COMMANDS,
    ...PHOTOS_COMMANDS,
    ...MOTION_COMMANDS,
    ...SYSTEM_COMMANDS,
  ],
  linux: [...SYSTEM_COMMANDS],
  windows: [...SYSTEM_COMMANDS],
  // Fail-safe: unknown metadata should not receive host exec defaults.
  unknown: [...UNKNOWN_PLATFORM_COMMANDS],
};

type PlatformId = "ios" | "android" | "macos" | "windows" | "linux" | "unknown";

const PLATFORM_PREFIX_RULES: ReadonlyArray<{
  id: Exclude<PlatformId, "unknown">;
  prefixes: readonly string[];
}> = [
  { id: "ios", prefixes: ["ios"] },
  { id: "android", prefixes: ["android"] },
  { id: "macos", prefixes: ["mac", "darwin"] },
  { id: "windows", prefixes: ["win"] },
  { id: "linux", prefixes: ["linux"] },
] as const;

const DEVICE_FAMILY_TOKEN_RULES: ReadonlyArray<{
  id: Exclude<PlatformId, "unknown">;
  tokens: readonly string[];
}> = [
  { id: "ios", tokens: ["iphone", "ipad", "ios"] },
  { id: "android", tokens: ["android"] },
  { id: "macos", tokens: ["mac"] },
  { id: "windows", tokens: ["windows"] },
  { id: "linux", tokens: ["linux"] },
] as const;

function resolvePlatformIdByPrefix(value: string): Exclude<PlatformId, "unknown"> | undefined {
  for (const rule of PLATFORM_PREFIX_RULES) {
    if (rule.prefixes.some((prefix) => value.startsWith(prefix))) {
      return rule.id;
    }
  }
  return undefined;
}

function resolvePlatformIdByDeviceFamily(
  value: string,
): Exclude<PlatformId, "unknown"> | undefined {
  for (const rule of DEVICE_FAMILY_TOKEN_RULES) {
    if (rule.tokens.some((token) => value.includes(token))) {
      return rule.id;
    }
  }
  return undefined;
}

function normalizePlatformId(platform?: string, deviceFamily?: string): PlatformId {
  const raw = normalizeDeviceMetadataForPolicy(platform);
  const byPlatform = resolvePlatformIdByPrefix(raw);
  if (byPlatform) {
    return byPlatform;
  }
  const family = normalizeDeviceMetadataForPolicy(deviceFamily);
  const byFamily = resolvePlatformIdByDeviceFamily(family);
  return byFamily ?? "unknown";
}

export function resolveNodeCommandAllowlist(
  cfg: OpenClawConfig,
  node?: Pick<NodeSession, "platform" | "deviceFamily">,
): Set<string> {
  const platformId = normalizePlatformId(node?.platform, node?.deviceFamily);
  const base = PLATFORM_DEFAULTS[platformId] ?? PLATFORM_DEFAULTS.unknown;
  const extra = cfg.gateway?.nodes?.allowCommands ?? [];
  const deny = new Set(cfg.gateway?.nodes?.denyCommands ?? []);
  const allow = new Set([...base, ...extra].map((cmd) => cmd.trim()).filter(Boolean));
  for (const blocked of deny) {
    const trimmed = blocked.trim();
    if (trimmed) {
      allow.delete(trimmed);
    }
  }
  return allow;
}

export function isNodeCommandAllowed(params: {
  command: string;
  declaredCommands?: string[];
  allowlist: Set<string>;
}): { ok: true } | { ok: false; reason: string } {
  const command = params.command.trim();
  if (!command) {
    return { ok: false, reason: "command required" };
  }
  if (!params.allowlist.has(command)) {
    return { ok: false, reason: "command not allowlisted" };
  }
  if (Array.isArray(params.declaredCommands) && params.declaredCommands.length > 0) {
    if (!params.declaredCommands.includes(command)) {
      return { ok: false, reason: "command not declared by node" };
    }
  } else {
    return { ok: false, reason: "node did not declare commands" };
  }
  return { ok: true };
}
