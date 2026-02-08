import fs from "node:fs/promises";
import path from "node:path";
import type { GuardianConfig, GuardianRuleMode } from "./config/types.guardian.js";
import { resolveStateDir } from "./config/paths.js";
import { resolveUserPath } from "./utils.js";

export type GuardianCheckParams = {
  actionType: string;
  targetPath: string;
  caller?: string;
  targetIsDir?: boolean;
};

export type GuardianCheckResult = {
  allowed: boolean;
  mode: GuardianRuleMode;
  rulePath?: string;
  reason?: string;
};

export type GuardianAuditEvent = {
  ts?: string;
  action_type: string;
  target: string;
  caller?: string;
  allowed?: boolean;
  reason?: string;
  meta?: Record<string, unknown>;
};

export class GuardianDeniedError extends Error {
  actionType: string;
  target: string;

  constructor(actionType: string, target: string, message?: string) {
    const baseMessage =
      message ?? `Guardian denied action_type=${actionType} target=${target}`;
    super(baseMessage);
    this.name = "GuardianDeniedError";
    this.actionType = actionType;
    this.target = target;
  }
}

const DEFAULT_KEY_FILE_NAME = ".openclaw.key";
const DEFAULT_CACHE_TTL_MS = 3000;
const DEFAULT_FAIL_MODE: NonNullable<GuardianConfig["failMode"]> = "closed";
const DEFAULT_MAX_KEY_LOOKUP_DEPTH = 5;

const NOT_FOUND_CODES = new Set(["ENOENT", "ENOTDIR"]);

type ResolvedRule = {
  mode: GuardianRuleMode;
  path: string;
  normalizedPath: string;
};

type ResolvedGuardianConfig = {
  enabled: boolean;
  keyFileName: string;
  cacheTtlMs: number;
  failMode: NonNullable<GuardianConfig["failMode"]>;
  rules: ResolvedRule[];
  maxKeyLookupDepth: number;
};

type GuardianDeps = {
  env?: NodeJS.ProcessEnv;
  fs?: typeof fs;
  now?: () => number;
  maxKeyLookupDepth?: number;
};

type Guardian = {
  enabled: boolean;
  checkAction: (params: GuardianCheckParams) => Promise<GuardianCheckResult>;
};

type AuditWriter = {
  filePath: string;
  write: (line: string) => void;
};

const auditWriters = new Map<string, AuditWriter>();

function safeJsonStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value, (_key, val) => {
      if (typeof val === "bigint") {
        return val.toString();
      }
      if (typeof val === "function") {
        return "[Function]";
      }
      if (val instanceof Error) {
        return { name: val.name, message: val.message, stack: val.stack };
      }
      if (val instanceof Uint8Array) {
        return { type: "Uint8Array", data: Buffer.from(val).toString("base64") };
      }
      return val;
    });
  } catch {
    return null;
  }
}

function getAuditWriter(filePath: string, fsImpl: typeof fs): AuditWriter {
  const existing = auditWriters.get(filePath);
  if (existing) {
    return existing;
  }

  const dir = path.dirname(filePath);
  const ready = fsImpl.mkdir(dir, { recursive: true }).catch(() => undefined);
  let queue = Promise.resolve();

  const writer: AuditWriter = {
    filePath,
    write: (line: string) => {
      queue = queue
        .then(() => ready)
        .then(() => fsImpl.appendFile(filePath, line, "utf8"))
        .catch(() => undefined);
    },
  };

  auditWriters.set(filePath, writer);
  return writer;
}

function resolveAuditPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "logs", "guardian-audit.jsonl");
}

export function recordAuditEvent(
  event: GuardianAuditEvent,
  deps?: { env?: NodeJS.ProcessEnv; fs?: typeof fs },
): void {
  const fsImpl = deps?.fs ?? fs;
  const env = deps?.env ?? process.env;
  const filePath = resolveAuditPath(env);
  const writer = getAuditWriter(filePath, fsImpl);

  const payload = {
    ts: event.ts ?? new Date().toISOString(),
    action_type: event.action_type,
    target: event.target,
    caller: event.caller,
    allowed: event.allowed,
    reason: event.reason,
    meta: event.meta,
  };

  const line = safeJsonStringify(payload);
  if (!line) {
    return;
  }
  writer.write(`${line}\n`);
}

function stripTrailingSep(value: string): string {
  const sep = path.sep;
  const root = path.parse(value).root;
  let next = value;
  while (next.length > root.length && next.endsWith(sep)) {
    next = next.slice(0, -1);
  }
  return next;
}

function normalizePathForMatch(value: string): string {
  const resolved = stripTrailingSep(path.resolve(resolveUserPath(value)));
  if (process.platform === "win32") {
    return resolved.toLowerCase();
  }
  return resolved;
}

function normalizeRule(raw: unknown): ResolvedRule | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as { mode?: unknown; path?: unknown };
  const mode = record.mode;
  const pathValue = typeof record.path === "string" ? record.path.trim() : "";
  if (!pathValue) {
    return null;
  }
  if (mode !== "public" && mode !== "needs_key" && mode !== "deny") {
    return null;
  }
  return {
    mode,
    path: pathValue,
    normalizedPath: normalizePathForMatch(pathValue),
  };
}

function resolveGuardianConfig(
  config?: GuardianConfig,
  deps?: GuardianDeps,
): ResolvedGuardianConfig {
  const enabled = config?.enabled === true;
  const keyFileName = config?.keyFileName?.trim() || DEFAULT_KEY_FILE_NAME;
  const cacheTtlMs =
    typeof config?.cacheTtlMs === "number" && Number.isFinite(config.cacheTtlMs)
      ? Math.max(0, Math.floor(config.cacheTtlMs))
      : DEFAULT_CACHE_TTL_MS;
  const failMode = config?.failMode === "open" ? "open" : DEFAULT_FAIL_MODE;
  const maxKeyLookupDepth =
    typeof deps?.maxKeyLookupDepth === "number" && Number.isFinite(deps.maxKeyLookupDepth)
      ? Math.max(0, Math.floor(deps.maxKeyLookupDepth))
      : DEFAULT_MAX_KEY_LOOKUP_DEPTH;

  const rules = Array.isArray(config?.rules)
    ? config.rules.map(normalizeRule).filter((rule): rule is ResolvedRule => !!rule)
    : [];

  return {
    enabled,
    keyFileName,
    cacheTtlMs,
    failMode,
    rules,
    maxKeyLookupDepth,
  };
}

function matchesRule(target: string, rule: string): boolean {
  if (target === rule) {
    return true;
  }
  const root = path.parse(rule).root;
  if (rule === root) {
    return target.startsWith(root);
  }
  return target.startsWith(`${rule}${path.sep}`);
}

function resolveRuleMatch(
  targetPath: string,
  rules: ResolvedRule[],
): { mode: GuardianRuleMode; rulePath?: string } {
  const target = normalizePathForMatch(targetPath);
  for (const rule of rules) {
    if (matchesRule(target, rule.normalizedPath)) {
      return { mode: rule.mode, rulePath: rule.path };
    }
  }
  return { mode: "public" };
}

function isNotFoundError(err: unknown): boolean {
  return (
    Boolean(err && typeof err === "object" && "code" in (err as Record<string, unknown>)) &&
    NOT_FOUND_CODES.has(String((err as { code?: string }).code))
  );
}

function resolveKeyStartDir(params: GuardianCheckParams): string {
  const resolved = path.resolve(params.targetPath);
  if (params.targetIsDir) {
    return resolved;
  }
  if (resolved.endsWith(path.sep)) {
    return stripTrailingSep(resolved);
  }
  return path.dirname(resolved);
}

export function createGuardian(config?: GuardianConfig, deps?: GuardianDeps): Guardian {
  const resolved = resolveGuardianConfig(config, deps);
  const fsImpl = deps?.fs ?? fs;
  const now = deps?.now ?? (() => Date.now());
  const cache = new Map<string, { allowed: boolean; expiresAt: number }>();

  const checkKeyFile = async (dir: string): Promise<boolean> => {
    const cacheKey = normalizePathForMatch(dir);
    if (resolved.cacheTtlMs > 0) {
      const cached = cache.get(cacheKey);
      if (cached && cached.expiresAt > now()) {
        return cached.allowed;
      }
    }

    const keyPath = path.join(dir, resolved.keyFileName);
    let allowed = false;
    try {
      await fsImpl.stat(keyPath);
      allowed = true;
    } catch (err) {
      if (!isNotFoundError(err)) {
        throw err;
      }
      allowed = false;
    }

    if (resolved.cacheTtlMs > 0) {
      cache.set(cacheKey, { allowed, expiresAt: now() + resolved.cacheTtlMs });
    }
    return allowed;
  };

  const hasKeyFile = async (targetPath: string, params: GuardianCheckParams): Promise<boolean> => {
    let current = resolveKeyStartDir({ ...params, targetPath });
    const root = path.parse(current).root;
    for (let depth = 0; depth <= resolved.maxKeyLookupDepth; depth += 1) {
      if (await checkKeyFile(current)) {
        return true;
      }
      if (current === root) {
        break;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
    return false;
  };

  const checkAction: Guardian["checkAction"] = async (params) => {
    if (!resolved.enabled) {
      return { allowed: true, mode: "public" };
    }

    const match = resolveRuleMatch(params.targetPath, resolved.rules);
    const mode = match.mode;

    if (mode === "public") {
      return { allowed: true, mode };
    }

    if (mode === "deny") {
      return { allowed: false, mode, rulePath: match.rulePath, reason: "rule=deny" };
    }

    try {
      const allowed = await hasKeyFile(params.targetPath, params);
      return {
        allowed,
        mode,
        rulePath: match.rulePath,
        reason: allowed ? "key=present" : "key=missing",
      };
    } catch (err) {
      const allow = resolved.failMode === "open";
      return {
        allowed: allow,
        mode,
        rulePath: match.rulePath,
        reason: `guardian_error=${String(err)}`,
      };
    }
  };

  return {
    enabled: resolved.enabled,
    checkAction,
  };
}
