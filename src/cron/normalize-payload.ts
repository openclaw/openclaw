import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { isRecord } from "../utils.js";
import {
  TimeoutSecondsFieldSchema,
  TrimmedNonEmptyStringFieldSchema,
  parseOptionalField,
} from "./delivery-field-schemas.js";
import { snapshotOwnCronRecord } from "./own-record.js";

type UnknownRecord = Record<string, unknown>;

function normalizeTrimmedStringArray(value: unknown): string[] | null | undefined {
  if (Array.isArray(value)) {
    const normalized = normalizeTrimmedStringList(value);
    if (normalized.length === 0 && value.length > 0) {
      return undefined;
    }
    return normalized;
  }
  return value === null ? null : undefined;
}

function normalizeCommandEnv(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    throw new Error("command env must be an object with non-blank keys and string values");
  }
  const entries: Array<[string, string]> = [];
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = normalizeOptionalString(rawKey);
    if (!key || typeof rawValue !== "string") {
      throw new Error("command env must be an object with non-blank keys and string values");
    }
    entries.push([key, rawValue]);
  }
  return Object.fromEntries(entries);
}

export function normalizeCronCommandArgv(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  if (value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    return undefined;
  }
  return [...value];
}

function hasAgentTurnOnlyPayloadHint(payload: UnknownRecord): boolean {
  return (
    "model" in payload ||
    "fallbacks" in payload ||
    "thinking" in payload ||
    "timeoutSeconds" in payload ||
    typeof payload.lightContext === "boolean" ||
    typeof payload.skipIfScratchEmpty === "boolean" ||
    typeof payload.includeReasoning === "boolean" ||
    typeof payload.allowUnsafeExternalContent === "boolean"
  );
}

export function normalizeCronPayload(payload: UnknownRecord): UnknownRecord {
  const next = snapshotOwnCronRecord(payload);
  const kindRaw = normalizeLowercaseStringOrEmpty(next.kind);
  if (kindRaw === "agentturn") {
    next.kind = "agentTurn";
  } else if (kindRaw === "systemevent") {
    next.kind = "systemEvent";
  } else if (kindRaw) {
    next.kind = kindRaw;
  }
  // Preserve authored prompt bytes; blank input still fails the shared schema validation.
  if (typeof next.message === "string" && !next.message.trim()) {
    next.message = "";
  }
  if (typeof next.text === "string") {
    next.text = normalizeOptionalString(next.text) ?? "";
  }
  if (typeof next.script === "string") {
    next.script = next.script.trim();
  }
  for (const field of ["model", "thinking"] as const) {
    // Preserve explicit null so patches can clear stored overrides,
    // matching the fallbacks/toolsAllow clear paths.
    if (field in next && next[field] !== null) {
      const value = parseOptionalField(TrimmedNonEmptyStringFieldSchema, next[field]);
      if (value !== undefined) {
        next[field] = value;
      } else {
        delete next[field];
      }
    }
  }
  if ("timeoutSeconds" in next && next.timeoutSeconds !== null) {
    const timeoutSeconds = parseOptionalField(TimeoutSecondsFieldSchema, next.timeoutSeconds);
    if (timeoutSeconds !== undefined) {
      next.timeoutSeconds = timeoutSeconds;
    } else {
      delete next.timeoutSeconds;
    }
  }
  for (const field of ["fallbacks", "toolsAllow"] as const) {
    if (field in next) {
      const value = normalizeTrimmedStringArray(next[field]);
      if (value !== undefined) {
        next[field] = value;
      } else {
        delete next[field];
      }
    }
  }
  if ("argv" in next) {
    const argv = normalizeCronCommandArgv(next.argv);
    if (argv) {
      next.argv = argv;
    } else {
      delete next.argv;
    }
  }
  if ("cwd" in next) {
    const cwd = parseOptionalField(TrimmedNonEmptyStringFieldSchema, next.cwd);
    if (cwd !== undefined) {
      next.cwd = cwd;
    } else {
      delete next.cwd;
    }
  }
  if ("env" in next) {
    next.env = normalizeCommandEnv(next.env);
  }
  if ("input" in next && typeof next.input !== "string") {
    delete next.input;
  }
  if ("noOutputTimeoutSeconds" in next) {
    const noOutputTimeoutSeconds = parseOptionalField(
      TimeoutSecondsFieldSchema,
      next.noOutputTimeoutSeconds,
    );
    if (noOutputTimeoutSeconds !== undefined) {
      next.noOutputTimeoutSeconds = noOutputTimeoutSeconds;
    } else {
      delete next.noOutputTimeoutSeconds;
    }
  }
  for (const field of ["outputMaxBytes", "toolBudget"] as const) {
    if (field in next) {
      const value = parseOptionalField(TimeoutSecondsFieldSchema, next[field]);
      if (value !== undefined && value > 0) {
        next[field] = Math.floor(value);
      } else {
        delete next[field];
      }
    }
  }
  if (
    "allowUnsafeExternalContent" in next &&
    typeof next.allowUnsafeExternalContent !== "boolean"
  ) {
    delete next.allowUnsafeExternalContent;
  }
  if (!("kind" in next) && typeof next.text === "string" && hasAgentTurnOnlyPayloadHint(next)) {
    next.kind = "agentTurn";
    next.message = next.text;
  }
  const kind = next.kind;
  if (kind === "systemEvent" || kind === "agentTurn" || kind === "command" || kind === "script") {
    if (kind !== "systemEvent") {
      delete next.text;
    } else {
      delete next.timeoutSeconds;
    }
    if (kind !== "agentTurn") {
      delete next.message;
      delete next.model;
      delete next.fallbacks;
      delete next.thinking;
      delete next.lightContext;
      delete next.skipIfScratchEmpty;
      delete next.includeReasoning;
      delete next.allowUnsafeExternalContent;
    }
    if (kind !== "command") {
      delete next.argv;
      delete next.cwd;
      delete next.env;
      delete next.input;
      delete next.noOutputTimeoutSeconds;
      delete next.outputMaxBytes;
    }
    if (kind !== "script") {
      delete next.script;
      delete next.toolBudget;
    }
  }
  return { ...next };
}
