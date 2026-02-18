import { mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";

// Cache for directories we've already created to avoid repeated sync I/O
const ensuredDirs = new Set<string>();

function ensureDirOnce(dir: string): void {
  if (!ensuredDirs.has(dir)) {
    mkdirSync(dir, { recursive: true });
    ensuredDirs.add(dir);
  }
}

export type AuditModelTrafficConfig = {
  enabled?: boolean;
  path?: string;
  redact?: {
    enabled?: boolean;
    keys?: string[];
    maskChar?: string;
    headVisible?: number;
    tailVisible?: number;
  };
  granularity?: {
    headers?: boolean;
    body?: boolean;
    response?: boolean;
  };
};

// Default sensitive keys to redact
const DEFAULT_SENSITIVE_KEYS = [
  "authorization",
  "x-api-key",
  "api-key",
  "x-auth-token",
  "token",
  "access_token",
  "api_key",
];

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch (err) {
    return JSON.stringify({
      _error: "json_stringify_failed",
      message: String(err),
    });
  }
}

function maskSensitiveValue(
  value: string,
  headVisible: number = 4,
  tailVisible: number = 4,
  maskChar: string = "*",
): string {
  if (!value || value.length <= headVisible + tailVisible) {
    return value;
  }
  const head = value.slice(0, headVisible);
  const tail = value.slice(-tailVisible);
  const masked = maskChar.repeat(8); // Fixed 8 asterisks
  return `${head}${masked}${tail}`;
}

function redactObject(
  obj: Record<string, unknown>,
  sensitiveKeys: string[],
  headVisible: number,
  tailVisible: number,
  maskChar: string,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();
    if (sensitiveKeys.some((sk) => lowerKey.includes(sk))) {
      if (typeof val === "string") {
        result[key] = maskSensitiveValue(val, headVisible, tailVisible, maskChar);
      } else {
        result[key] = "[REDACTED]";
      }
    } else {
      result[key] = val;
    }
  }
  return result;
}

export type ModelTrafficRecord = {
  ts: number;
  kind: "model_traffic";
  source: string;
  direction: "in" | "out";
  id: string;
  sessionKey?: string;
  provider?: string;
  model?: string;
  stream?: boolean;
  headers?: Record<string, unknown>;
  body?: unknown;
  status?: number;
  note?: string;
};

// Config getter - will be injected from gateway
let _config: AuditModelTrafficConfig | null = null;

export function setAuditConfig(config: AuditModelTrafficConfig | undefined): void {
  _config = config || null;
}

export function getAuditConfig(): AuditModelTrafficConfig | null {
  return _config;
}

function isEnvEnabled(): boolean {
  const v = process.env.OPENCLAW_AUDIT_MODEL_TRAFFIC;
  if (!v) {
    return false;
  }
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}

function isConfigEnabled(): boolean {
  if (!_config) {
    return false;
  }
  return _config.enabled === true;
}

export function auditModelTrafficEnabled(): boolean {
  return isEnvEnabled() || isConfigEnabled();
}

export function auditModelTrafficPath(): string {
  // Config takes precedence
  if (_config?.path) {
    const base = _config.path;
    if (base.includes("%DATE%")) {
      const d = new Date();
      const yyyy = String(d.getFullYear());
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      return base.replaceAll("%DATE%", `${yyyy}-${mm}-${dd}`);
    }
    return base;
  }

  const base =
    process.env.OPENCLAW_AUDIT_MODEL_TRAFFIC_PATH || "/data/openclaw/audit/model-traffic.jsonl";
  if (base.includes("%DATE%")) {
    const d = new Date();
    const yyyy = String(d.getFullYear());
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return base.replaceAll("%DATE%", `${yyyy}-${mm}-${dd}`);
  }
  return base;
}

function shouldRedact(): boolean {
  if (_config?.redact?.enabled === false) {
    return false;
  }
  if (_config?.redact?.enabled === true) {
    return true;
  }
  // Default: enabled when audit is enabled
  return auditModelTrafficEnabled();
}

function getSensitiveKeys(): string[] {
  return _config?.redact?.keys || DEFAULT_SENSITIVE_KEYS;
}

function getRedactOptions() {
  return {
    headVisible: _config?.redact?.headVisible ?? 4,
    tailVisible: _config?.redact?.tailVisible ?? 4,
    maskChar: _config?.redact?.maskChar ?? "*",
  };
}

function getGranularity() {
  return {
    headers: _config?.granularity?.headers ?? true,
    body: _config?.granularity?.body ?? true,
    response: _config?.granularity?.response ?? true,
  };
}

function applyRedaction(rec: ModelTrafficRecord): ModelTrafficRecord {
  if (!shouldRedact()) {
    return rec;
  }

  const { headVisible, tailVisible, maskChar } = getRedactOptions();
  const sensitiveKeys = getSensitiveKeys();
  const result: ModelTrafficRecord = { ...rec };

  // Redact headers
  if (rec.headers) {
    result.headers = redactObject(rec.headers, sensitiveKeys, headVisible, tailVisible, maskChar);
  }

  // Redact body if it's an object with sensitive fields
  if (rec.body && typeof rec.body === "object" && rec.body !== null) {
    const body = rec.body as Record<string, unknown>;
    // Check for common API key fields in body
    const redactedBody: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(body)) {
      const lowerKey = key.toLowerCase();
      if (sensitiveKeys.some((sk) => lowerKey.includes(sk))) {
        if (typeof val === "string") {
          redactedBody[key] = maskSensitiveValue(val, headVisible, tailVisible, maskChar);
        } else {
          redactedBody[key] = "[REDACTED]";
        }
      } else {
        redactedBody[key] = val;
      }
    }
    result.body = redactedBody;
  }

  return result;
}

function applyGranularity(rec: ModelTrafficRecord): ModelTrafficRecord {
  const gran = getGranularity();
  const result: ModelTrafficRecord = { ...rec };

  if (!gran.headers) {
    delete result.headers;
  }
  if (!gran.body) {
    delete result.body;
  }
  // Response is handled by caller (they decide what to log as "out")

  return result;
}

export function auditModelTrafficWrite(rec: ModelTrafficRecord): void {
  if (!auditModelTrafficEnabled()) {
    return;
  }

  // Apply granularity first (remove fields)
  let processed = applyGranularity(rec);

  // Then apply redaction
  processed = applyRedaction(processed);

  const path = auditModelTrafficPath();
  try {
    ensureDirOnce(dirname(path));
    appendFileSync(path, `${safeJsonStringify(processed)}\n`, { encoding: "utf8" });
  } catch {
    // Never break the gateway on audit logging failures.
  }
}
