import crypto from "node:crypto";
import { redactSensitiveText } from "../../logging/redact.js";
import type { ResearchEventV1 } from "./types.js";

const MAX_STRING_LEN = 2_000;
const DROP_KEYS = new Set([
  "authorization",
  "apiKey",
  "apikey",
  "token",
  "accessToken",
  "refreshToken",
  "password",
  "secret",
]);

export function hashLargeText(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export function redactTextLoose(text: string): string {
  if (!text) {
    return text;
  }
  return redactSensitiveText(text);
}

function truncateString(value: string): string {
  if (value.length <= MAX_STRING_LEN) {
    return value;
  }
  const hashed = hashLargeText(value);
  return `${value.slice(0, MAX_STRING_LEN)}… [truncated sha256:${hashed.slice(0, 12)}]`;
}

function redactUnknown(value: unknown): unknown {
  if (typeof value === "string") {
    return truncateString(redactTextLoose(value));
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactUnknown(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(record)) {
    if (DROP_KEYS.has(key.toLowerCase())) {
      out[key] = "[redacted]";
      continue;
    }
    out[key] = redactUnknown(raw);
  }
  return out;
}

export function redactEvent(event: ResearchEventV1): ResearchEventV1 {
  return redactUnknown(event) as ResearchEventV1;
}
