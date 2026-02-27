import crypto from "node:crypto";
import type { SystemRunApprovalBindingV1, SystemRunApprovalPlanV2 } from "./exec-approvals.js";
import { normalizeEnvVarKey } from "./host-env-security.js";

type NormalizedSystemRunEnvEntry = [key: string, value: string];

function normalizeString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry)) : [];
}

export function normalizeSystemRunApprovalPlanV2(value: unknown): SystemRunApprovalPlanV2 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 2) {
    return null;
  }
  const argv = normalizeStringArray(candidate.argv);
  if (argv.length === 0) {
    return null;
  }
  return {
    version: 2,
    argv,
    cwd: normalizeString(candidate.cwd),
    rawCommand: normalizeString(candidate.rawCommand),
    agentId: normalizeString(candidate.agentId),
    sessionKey: normalizeString(candidate.sessionKey),
  };
}

function normalizeSystemRunEnvEntries(env: unknown): NormalizedSystemRunEnvEntry[] {
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    return [];
  }
  const entries: NormalizedSystemRunEnvEntry[] = [];
  for (const [rawKey, rawValue] of Object.entries(env as Record<string, unknown>)) {
    if (typeof rawValue !== "string") {
      continue;
    }
    const key = normalizeEnvVarKey(rawKey, { portable: true });
    if (!key) {
      continue;
    }
    entries.push([key, rawValue]);
  }
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  return entries;
}

function hashSystemRunEnvEntries(entries: NormalizedSystemRunEnvEntry[]): string | null {
  if (entries.length === 0) {
    return null;
  }
  return crypto.createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

export function buildSystemRunApprovalEnvBinding(env: unknown): {
  envHash: string | null;
  envKeys: string[];
} {
  const entries = normalizeSystemRunEnvEntries(env);
  return {
    envHash: hashSystemRunEnvEntries(entries),
    envKeys: entries.map(([key]) => key),
  };
}

export function buildSystemRunApprovalBindingV1(params: {
  argv: unknown;
  cwd?: unknown;
  agentId?: unknown;
  sessionKey?: unknown;
  env?: unknown;
}): { binding: SystemRunApprovalBindingV1; envKeys: string[] } {
  const envBinding = buildSystemRunApprovalEnvBinding(params.env);
  return {
    binding: {
      version: 1,
      argv: normalizeStringArray(params.argv),
      cwd: normalizeString(params.cwd),
      agentId: normalizeString(params.agentId),
      sessionKey: normalizeString(params.sessionKey),
      envHash: envBinding.envHash,
    },
    envKeys: envBinding.envKeys,
  };
}

function argvMatches(expectedArgv: string[], actualArgv: string[]): boolean {
  if (expectedArgv.length === 0 || expectedArgv.length !== actualArgv.length) {
    return false;
  }
  for (let i = 0; i < expectedArgv.length; i += 1) {
    if (expectedArgv[i] !== actualArgv[i]) {
      return false;
    }
  }
  return true;
}

export type SystemRunApprovalMatchResult =
  | { ok: true }
  | {
      ok: false;
      code: "APPROVAL_REQUEST_MISMATCH" | "APPROVAL_ENV_BINDING_MISSING" | "APPROVAL_ENV_MISMATCH";
      message: string;
      details?: Record<string, unknown>;
    };

type SystemRunApprovalMismatch = Extract<SystemRunApprovalMatchResult, { ok: false }>;

const APPROVAL_REQUEST_MISMATCH_MESSAGE = "approval id does not match request";

function requestMismatch(details?: Record<string, unknown>): SystemRunApprovalMatchResult {
  return {
    ok: false,
    code: "APPROVAL_REQUEST_MISMATCH",
    message: APPROVAL_REQUEST_MISMATCH_MESSAGE,
    details,
  };
}

export function matchSystemRunApprovalEnvHash(params: {
  expectedEnvHash: string | null;
  actualEnvHash: string | null;
  actualEnvKeys: string[];
}): SystemRunApprovalMatchResult {
  if (!params.expectedEnvHash && !params.actualEnvHash) {
    return { ok: true };
  }
  if (!params.expectedEnvHash && params.actualEnvHash) {
    return {
      ok: false,
      code: "APPROVAL_ENV_BINDING_MISSING",
      message: "approval id missing env binding for requested env overrides",
      details: { envKeys: params.actualEnvKeys },
    };
  }
  if (params.expectedEnvHash !== params.actualEnvHash) {
    return {
      ok: false,
      code: "APPROVAL_ENV_MISMATCH",
      message: "approval id env binding mismatch",
      details: {
        envKeys: params.actualEnvKeys,
        expectedEnvHash: params.expectedEnvHash,
        actualEnvHash: params.actualEnvHash,
      },
    };
  }
  return { ok: true };
}

export function matchSystemRunApprovalBindingV1(params: {
  expected: SystemRunApprovalBindingV1;
  actual: SystemRunApprovalBindingV1;
  actualEnvKeys: string[];
}): SystemRunApprovalMatchResult {
  if (params.expected.version !== 1 || params.actual.version !== 1) {
    return requestMismatch({
      expectedVersion: params.expected.version,
      actualVersion: params.actual.version,
    });
  }
  if (!argvMatches(params.expected.argv, params.actual.argv)) {
    return requestMismatch();
  }
  if (params.expected.cwd !== params.actual.cwd) {
    return requestMismatch();
  }
  if (params.expected.agentId !== params.actual.agentId) {
    return requestMismatch();
  }
  if (params.expected.sessionKey !== params.actual.sessionKey) {
    return requestMismatch();
  }
  return matchSystemRunApprovalEnvHash({
    expectedEnvHash: params.expected.envHash,
    actualEnvHash: params.actual.envHash,
    actualEnvKeys: params.actualEnvKeys,
  });
}

export function missingSystemRunApprovalBindingV1(params: {
  actualEnvKeys: string[];
}): SystemRunApprovalMatchResult {
  return requestMismatch({
    requiredBindingVersion: 1,
    envKeys: params.actualEnvKeys,
  });
}

export function toSystemRunApprovalMismatchError(params: {
  runId: string;
  match: SystemRunApprovalMismatch;
}): { ok: false; message: string; details: Record<string, unknown> } {
  const details: Record<string, unknown> = {
    code: params.match.code,
    runId: params.runId,
  };
  if (params.match.details) {
    Object.assign(details, params.match.details);
  }
  return {
    ok: false,
    message: params.match.message,
    details,
  };
}
