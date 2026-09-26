// Legacy cron payload migration for provider/channel aliases and OpenAI Codex model refs.
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  readStringValue as readString,
} from "../../../../packages/normalization-core/src/string-coerce.js";
import {
  hasCronShellToolAccess,
  parseCronAgentTurnCommandPrompt,
} from "../../../cron/agent-turn-command-prompt.js";
import { toCanonicalOpenAIModelRef } from "../shared/codex-route-model-ref.js";
import {
  IMAGE_INSPECTION_TOOL_NAME_MIGRATION,
  migrateLegacyToolNameList,
  TASK_SUGGESTION_TOOL_NAME_MIGRATION,
} from "../shared/legacy-tool-name-migration.js";

type UnknownRecord = Record<string, unknown>;

const LEGACY_DELIVERY_HINT_FIELDS = [
  "deliver",
  "bestEffortDeliver",
  "channel",
  "provider",
  "to",
  "threadId",
] as const;

export function normalizePayloadKind(payload: UnknownRecord) {
  const raw = normalizeOptionalLowercaseString(payload.kind) ?? "";
  const kind =
    raw === "agentturn" ? "agentTurn" : raw === "systemevent" ? "systemEvent" : undefined;
  if (!kind || payload.kind === kind) {
    return false;
  }
  payload.kind = kind;
  return true;
}

export function inferPayloadIfMissing(raw: UnknownRecord) {
  const message = normalizeOptionalString(raw.message) ?? "";
  const text = normalizeOptionalString(raw.text) ?? "";
  const command = normalizeOptionalString(raw.command) ?? "";
  if (message) {
    raw.payload = { kind: "agentTurn", message };
    return true;
  }
  if (text) {
    raw.payload = { kind: "systemEvent", text };
    return true;
  }
  if (command) {
    raw.payload = { kind: "systemEvent", text: command };
    return true;
  }
  return false;
}

export function copyTopLevelAgentTurnFields(raw: UnknownRecord, payload: UnknownRecord) {
  let mutated = false;

  const copyTrimmedString = (field: "model" | "thinking") => {
    const existing = normalizeOptionalString(payload[field]);
    if (existing) {
      return;
    }
    const value = normalizeOptionalString(raw[field]);
    if (value) {
      payload[field] = value;
      mutated = true;
    }
  };
  copyTrimmedString("model");
  copyTrimmedString("thinking");

  if (
    typeof payload.timeoutSeconds !== "number" &&
    typeof raw.timeoutSeconds === "number" &&
    Number.isFinite(raw.timeoutSeconds)
  ) {
    payload.timeoutSeconds = Math.max(0, Math.floor(raw.timeoutSeconds));
    mutated = true;
  }

  const copyBoolean = (field: "allowUnsafeExternalContent" | "deliver" | "bestEffortDeliver") => {
    if (typeof payload[field] !== "boolean" && typeof raw[field] === "boolean") {
      payload[field] = raw[field];
      mutated = true;
    }
  };
  const copyString = (field: "channel" | "to" | "provider") => {
    const value = normalizeOptionalString(raw[field]);
    if (typeof payload[field] !== "string" && value) {
      payload[field] = value;
      mutated = true;
    }
  };
  copyBoolean("allowUnsafeExternalContent");
  copyBoolean("deliver");
  copyString("channel");
  copyString("to");
  const rawThreadId = normalizeOptionalString(raw.threadId);
  if (
    !("threadId" in payload) &&
    ((typeof raw.threadId === "number" && Number.isFinite(raw.threadId)) || Boolean(rawThreadId))
  ) {
    payload.threadId = rawThreadId ?? raw.threadId;
    mutated = true;
  }
  copyBoolean("bestEffortDeliver");
  copyString("provider");

  return mutated;
}

export function stripLegacyTopLevelFields(raw: UnknownRecord) {
  const removed = { payload: false, delivery: false };
  for (const [kind, fields] of [
    [
      "payload",
      [
        "model",
        "thinking",
        "timeoutSeconds",
        "allowUnsafeExternalContent",
        "message",
        "text",
        "command",
        "timeout",
      ],
    ],
    ["delivery", LEGACY_DELIVERY_HINT_FIELDS],
  ] as const) {
    for (const field of fields) {
      if (field in raw) {
        delete raw[field];
        removed[kind] = true;
      }
    }
  }
  return removed;
}

type LegacyOpenAICodexCronModelRoute = {
  legacyModelRef: string;
  canonicalModelRef: string;
};

function readLegacyOpenAICodexCronModelRoute(
  value: unknown,
): LegacyOpenAICodexCronModelRoute | undefined {
  const legacyModelRef = readString(value)?.trim();
  const canonicalModelRef = legacyModelRef ? toCanonicalOpenAIModelRef(legacyModelRef) : undefined;
  return legacyModelRef && canonicalModelRef ? { legacyModelRef, canonicalModelRef } : undefined;
}

/** Legacy and canonical route pairs retained for namespace-specific migration blockers. */
export function collectLegacyOpenAICodexCronModelRoutes(
  payload: UnknownRecord,
): LegacyOpenAICodexCronModelRoute[] {
  const routes = new Map<string, LegacyOpenAICodexCronModelRoute>();
  const add = (value: unknown) => {
    const route = readLegacyOpenAICodexCronModelRoute(value);
    if (route) {
      routes.set(`${route.legacyModelRef}\u0000${route.canonicalModelRef}`, route);
    }
  };
  add(payload.model);
  if (Array.isArray(payload.fallbacks)) {
    for (const fallback of payload.fallbacks) {
      add(fallback);
    }
  }
  return [...routes.values()];
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function migrateLegacyOpenAICodexModelRefs(
  payload: UnknownRecord,
  shouldMigrate: (modelRef: string, legacyModelRef: string) => boolean,
): boolean {
  let mutated = false;

  const model = readLegacyOpenAICodexCronModelRoute(payload.model);
  if (
    model &&
    shouldMigrate(model.canonicalModelRef, model.legacyModelRef) &&
    payload.model !== model.canonicalModelRef
  ) {
    payload.model = model.canonicalModelRef;
    mutated = true;
  }

  const fallbacks = payload.fallbacks;
  if (Array.isArray(fallbacks)) {
    const next = fallbacks.map((fallback) => {
      const route = readLegacyOpenAICodexCronModelRoute(fallback);
      return route && shouldMigrate(route.canonicalModelRef, route.legacyModelRef)
        ? route.canonicalModelRef
        : fallback;
    });
    if (next.some((fallback, index) => fallback !== fallbacks[index])) {
      payload.fallbacks = next;
      mutated = true;
    }
  }

  return mutated;
}

/** Normalize legacy cron payload channel/provider and model reference fields in place. */
export function migrateLegacyCronPayload(
  payload: UnknownRecord,
  options: {
    migrateCodexModelRefs?: boolean;
    shouldMigrateCodexModelRef?: (modelRef: string, legacyModelRef: string) => boolean;
  } = {},
): boolean {
  let mutated = false;

  if (migrateLegacyToolNameList(payload.toolsAllow, TASK_SUGGESTION_TOOL_NAME_MIGRATION)) {
    mutated = true;
  }
  if (migrateLegacyToolNameList(payload.toolsAllow, IMAGE_INSPECTION_TOOL_NAME_MIGRATION)) {
    mutated = true;
  }

  const channelValue = readString(payload.channel);
  const nextChannel =
    normalizeOptionalLowercaseString(channelValue) ??
    normalizeOptionalLowercaseString(payload.provider);
  if (nextChannel && channelValue !== nextChannel) {
    payload.channel = nextChannel;
    mutated = true;
  }

  if ("provider" in payload) {
    delete payload.provider;
    mutated = true;
  }

  const shouldMigrateCodexModelRef =
    options.migrateCodexModelRefs === true
      ? (options.shouldMigrateCodexModelRef ?? (() => true))
      : () => false;
  if (migrateLegacyOpenAICodexModelRefs(payload, shouldMigrateCodexModelRef)) {
    mutated = true;
  }

  return mutated;
}

export function migrateLegacyAgentTurnCommandPayload(payload: UnknownRecord): boolean {
  if (payload.kind !== "agentTurn") {
    return false;
  }
  const message = readString(payload.message);
  if (typeof message !== "string") {
    return false;
  }
  const parsed = parseCronAgentTurnCommandPrompt(message);
  if (!parsed) {
    return false;
  }
  if (!hasCronShellToolAccess(payload.toolsAllow)) {
    return false;
  }

  const timeoutSeconds = readPositiveInteger(payload.timeoutSeconds) ?? parsed.timeoutSeconds;
  const deliveryHints: UnknownRecord = {};
  for (const key of LEGACY_DELIVERY_HINT_FIELDS) {
    if (key in payload) {
      deliveryHints[key] = payload[key];
    }
  }

  for (const key of Object.keys(payload)) {
    delete payload[key];
  }

  payload.kind = "command";
  payload.argv = ["sh", "-lc", parsed.command];
  if (parsed.cwd) {
    payload.cwd = parsed.cwd;
  }
  if (timeoutSeconds !== undefined) {
    payload.timeoutSeconds = timeoutSeconds;
  }
  Object.assign(payload, deliveryHints);
  return true;
}
