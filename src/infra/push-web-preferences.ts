import { asSafeIntegerInRange } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type {
  WebPushDetailLevel,
  WebPushDevicePreferences,
  WebPushNotificationCategory,
  WebPushNotificationPreferences,
} from "../../packages/gateway-protocol/src/schema/push.js";
import { sanitizeExecApprovalDisplayText } from "./exec-approval-text-sanitize.js";

export const WEB_PUSH_USER_PREFERENCES_KEY = "notifications.web.v1";

export function normalizeWebPushDisplayLabel(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  // Redact and escape before truncation; raw IDs still own filtering and authorization.
  return truncateUtf16Safe(sanitizeExecApprovalDisplayText(value.trim()), 80) || undefined;
}

const DEFAULT_WEB_PUSH_NOTIFICATION_PREFERENCES: WebPushNotificationPreferences = {
  categories: {
    approvalRequested: true,
    agentFinished: false,
    agentQuestion: false,
    humanMentioned: false,
    scheduledTaskFailed: false,
  },
  detailLevel: "private",
  quietHours: {
    enabled: false,
    startMinute: 22 * 60,
    endMinute: 7 * 60,
    timeZone: "UTC",
  },
  agentIds: [],
};

type CategoryKey = keyof WebPushNotificationPreferences["categories"];

const CATEGORY_TO_KEY: Record<WebPushNotificationCategory, CategoryKey> = {
  "approval-requested": "approvalRequested",
  "agent-finished": "agentFinished",
  "agent-question": "agentQuestion",
  "human-mentioned": "humanMentioned",
  "scheduled-task-failed": "scheduledTaskFailed",
};
const CATEGORY_KEYS = Object.values(CATEGORY_TO_KEY);

function detailLevel(value: unknown): WebPushDetailLevel | undefined {
  return value === "private" || value === "identified" || value === "detailed" ? value : undefined;
}

function normalizeAgentIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return normalizeUniqueTrimmedStringList(value)
    .filter((entry) => entry.length <= 128)
    .slice(0, 128);
}

function normalizeQuietHours(value: unknown) {
  if (!isRecord(value)) {
    return undefined;
  }
  const startMinute = asSafeIntegerInRange(value.startMinute, { min: 0, max: 1439 });
  const endMinute = asSafeIntegerInRange(value.endMinute, { min: 0, max: 1439 });
  const timeZone = typeof value.timeZone === "string" ? value.timeZone.trim() : "";
  if (
    typeof value.enabled !== "boolean" ||
    startMinute === undefined ||
    endMinute === undefined ||
    !timeZone ||
    timeZone.length > 128
  ) {
    return undefined;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
  } catch {
    return undefined;
  }
  return {
    enabled: value.enabled,
    startMinute,
    endMinute,
    timeZone,
  };
}

function normalizeCategories(source: Record<string, unknown> | undefined) {
  return Object.fromEntries(
    CATEGORY_KEYS.flatMap<[CategoryKey, boolean]>((key) =>
      typeof source?.[key] === "boolean" ? [[key, source[key]]] : [],
    ),
  );
}

export function normalizeWebPushNotificationPreferences(
  value: unknown,
): WebPushNotificationPreferences {
  const source = isRecord(value) ? value : {};
  const categorySource = isRecord(source.categories) ? source.categories : {};
  return {
    categories: {
      ...DEFAULT_WEB_PUSH_NOTIFICATION_PREFERENCES.categories,
      ...normalizeCategories(categorySource),
    },
    detailLevel:
      detailLevel(source.detailLevel) ?? DEFAULT_WEB_PUSH_NOTIFICATION_PREFERENCES.detailLevel,
    quietHours:
      normalizeQuietHours(source.quietHours) ??
      DEFAULT_WEB_PUSH_NOTIFICATION_PREFERENCES.quietHours,
    agentIds: normalizeAgentIds(source.agentIds) ?? [],
  };
}

export function normalizeWebPushDevicePreferences(value: unknown): WebPushDevicePreferences {
  const source = isRecord(value) ? value : {};
  const categorySource = isRecord(source.categories) ? source.categories : undefined;
  const categories = normalizeCategories(categorySource);
  const normalizedDetailLevel = detailLevel(source.detailLevel);
  const normalizedQuietHours = normalizeQuietHours(source.quietHours);
  const normalizedAgentIds = normalizeAgentIds(source.agentIds);
  return {
    enabled: typeof source.enabled === "boolean" ? source.enabled : true,
    label: normalizeWebPushDisplayLabel(source.label) ?? "",
    ...(categories && Object.keys(categories).length > 0 ? { categories } : {}),
    ...(normalizedDetailLevel ? { detailLevel: normalizedDetailLevel } : {}),
    ...(normalizedQuietHours ? { quietHours: normalizedQuietHours } : {}),
    ...(normalizedAgentIds ? { agentIds: normalizedAgentIds } : {}),
  };
}

export function resolveEffectiveWebPushPreferences(params: {
  user?: unknown;
  device?: unknown;
}): WebPushNotificationPreferences & { enabled: boolean; label: string } {
  const user = normalizeWebPushNotificationPreferences(params.user);
  const device = normalizeWebPushDevicePreferences(params.device);
  return {
    enabled: device.enabled,
    label: device.label,
    categories: { ...user.categories, ...device.categories },
    detailLevel: device.detailLevel ?? user.detailLevel,
    quietHours: device.quietHours ?? user.quietHours,
    agentIds: device.agentIds ?? user.agentIds,
  };
}

export function webPushCategoryEnabled(
  preferences: ReturnType<typeof resolveEffectiveWebPushPreferences>,
  category: WebPushNotificationCategory,
): boolean {
  const key = CATEGORY_TO_KEY[category];
  return key !== undefined && preferences.enabled && preferences.categories[key] === true;
}

export function isWebPushQuietHours(
  preferences: ReturnType<typeof resolveEffectiveWebPushPreferences>,
  nowMs = Date.now(),
): boolean {
  const quiet = preferences.quietHours;
  if (!quiet.enabled || quiet.startMinute === quiet.endMinute) {
    return false;
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: quiet.timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(nowMs);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  const current = hour * 60 + minute;
  return quiet.startMinute < quiet.endMinute
    ? current >= quiet.startMinute && current < quiet.endMinute
    : current >= quiet.startMinute || current < quiet.endMinute;
}

export function webPushAgentAllowed(
  preferences: ReturnType<typeof resolveEffectiveWebPushPreferences>,
  agentId?: string | null,
): boolean {
  return (
    preferences.agentIds.length === 0 || Boolean(agentId && preferences.agentIds.includes(agentId))
  );
}
