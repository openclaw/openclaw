import type fs from "node:fs";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createConfigObserveAuditRecord } from "./io.audit.js";
import type {
  ConfigHealthEntry,
  ConfigHealthFingerprint,
  ConfigHealthState,
} from "./io.health-state.types.js";
import {
  hashConfigRaw,
  hasConfigMeta,
  parseConfigJson5,
  resolveGatewayMode,
} from "./io.read-helpers.js";
import type { NormalizedConfigIoDeps } from "./io.types.js";
import { resolveConfigStatMetadata } from "./io.write-safety.js";

type ConfigFingerprintDeps = Pick<NormalizedConfigIoDeps, "fs" | "json5">;

export function readConfigHealthEntry(
  state: ConfigHealthState,
  configPath: string,
): ConfigHealthEntry {
  const entry = state.entries?.[configPath];
  return isRecord(entry) ? entry : {};
}

export function createConfigHealthFingerprint(params: {
  raw: string;
  parsed: unknown;
  resolved?: unknown;
  stat: fs.Stats | null;
  hash?: string;
  observedAt?: string;
}): ConfigHealthFingerprint {
  return {
    hash: params.hash ?? hashConfigRaw(params.raw),
    bytes: Buffer.byteLength(params.raw, "utf-8"),
    mtimeMs: params.stat?.mtimeMs ?? null,
    ctimeMs: params.stat?.ctimeMs ?? null,
    ...resolveConfigStatMetadata(params.stat),
    hasMeta: hasConfigMeta(params.parsed),
    gatewayMode: resolveGatewayMode(params.resolved ?? params.parsed),
    observedAt: params.observedAt ?? new Date().toISOString(),
  };
}

function createConfigFingerprintFromRead(params: {
  deps: ConfigFingerprintDeps;
  raw: string;
  stat: fs.Stats | null;
}): ConfigHealthFingerprint {
  const parsed = parseConfigJson5(params.raw, params.deps.json5);
  return createConfigHealthFingerprint({
    raw: params.raw,
    parsed: parsed.ok ? parsed.parsed : {},
    stat: params.stat,
  });
}

export async function readConfigFingerprintForPath(
  deps: ConfigFingerprintDeps,
  configPath: string,
): Promise<ConfigHealthFingerprint | null> {
  try {
    const raw = await deps.fs.promises.readFile(configPath, "utf-8");
    const stat = await deps.fs.promises.stat(configPath).catch(() => null);
    return createConfigFingerprintFromRead({ deps, raw, stat });
  } catch {
    return null;
  }
}

export function readConfigFingerprintForPathSync(
  deps: ConfigFingerprintDeps,
  configPath: string,
): ConfigHealthFingerprint | null {
  try {
    const raw = deps.fs.readFileSync(configPath, "utf-8");
    let stat: fs.Stats | null = null;
    try {
      stat = deps.fs.statSync(configPath, { throwIfNoEntry: false }) ?? null;
    } catch {
      // Metadata is diagnostic only; readable backup bytes remain authoritative.
    }
    return createConfigFingerprintFromRead({ deps, raw, stat });
  } catch {
    return null;
  }
}

export { createConfigObserveAuditRecord };

type ConfigObserveAuditRecordParams = Parameters<typeof createConfigObserveAuditRecord>[0];

export function createConfigObserveAuditAppendParams(
  deps: Pick<NormalizedConfigIoDeps, "env" | "homedir">,
  params: ConfigObserveAuditRecordParams,
) {
  return {
    env: deps.env,
    homedir: deps.homedir,
    record: createConfigObserveAuditRecord(params),
  };
}

export function extractRestoreErrorDetails(error: unknown): {
  code: string | null;
  message: string | null;
} {
  if (!error || typeof error !== "object") {
    return { code: null, message: typeof error === "string" ? error : null };
  }
  return {
    code: "code" in error && typeof error.code === "string" ? error.code : null,
    message: "message" in error && typeof error.message === "string" ? error.message : null,
  };
}
