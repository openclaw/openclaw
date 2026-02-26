import crypto from "node:crypto";
import type { ExecApprovalRequestPayload } from "../infra/exec-approvals.js";
import { normalizeEnvVarKey } from "../infra/host-env-security.js";

type NormalizedSystemRunEnvEntry = [key: string, value: string];

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

export type SystemRunEnvBindingMatchResult =
  | { ok: true }
  | {
      ok: false;
      code: "APPROVAL_ENV_BINDING_MISSING" | "APPROVAL_ENV_MISMATCH";
      message: string;
      details?: Record<string, unknown>;
    };

export function matchSystemRunApprovalEnvBinding(params: {
  request: Pick<ExecApprovalRequestPayload, "envHash">;
  env: unknown;
}): SystemRunEnvBindingMatchResult {
  const expectedEnvHash =
    typeof params.request.envHash === "string" && params.request.envHash.trim().length > 0
      ? params.request.envHash.trim()
      : null;
  const actual = buildSystemRunApprovalEnvBinding(params.env);
  const actualEnvHash = actual.envHash;

  if (!expectedEnvHash && !actualEnvHash) {
    return { ok: true };
  }
  if (!expectedEnvHash && actualEnvHash) {
    return {
      ok: false,
      code: "APPROVAL_ENV_BINDING_MISSING",
      message: "approval id missing env binding for requested env overrides",
      details: { envKeys: actual.envKeys },
    };
  }
  if (expectedEnvHash !== actualEnvHash) {
    return {
      ok: false,
      code: "APPROVAL_ENV_MISMATCH",
      message: "approval id env binding mismatch",
      details: {
        envKeys: actual.envKeys,
        expectedEnvHash,
        actualEnvHash,
      },
    };
  }
  return { ok: true };
}
