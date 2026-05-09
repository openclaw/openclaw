import fs from "node:fs/promises";
import { parseStrictNonNegativeInteger } from "../infra/parse-finite-number.js";
import { resolveGatewayLogPaths } from "./restart-logs.js";
import type { GatewayServiceEnv } from "./service-types.js";

export const DEFAULT_GATEWAY_LOG_MAX_BYTES = 64 * 1024 * 1024;
export const DEFAULT_GATEWAY_LOG_ARCHIVES = 1;
export const MAX_GATEWAY_LOG_ARCHIVES = 9;

export type GatewayLogRetentionLimits = {
  maxBytes: number;
  archives: number;
};

export function resolveGatewayLogRetentionLimits(
  env: GatewayServiceEnv,
): GatewayLogRetentionLimits {
  const rawMax = parseStrictNonNegativeInteger(env.OPENCLAW_GATEWAY_LOG_MAX_BYTES ?? "");
  const maxBytes = rawMax ?? DEFAULT_GATEWAY_LOG_MAX_BYTES;
  const rawArchives = parseStrictNonNegativeInteger(env.OPENCLAW_GATEWAY_LOG_ARCHIVES ?? "");
  const archives = Math.min(rawArchives ?? DEFAULT_GATEWAY_LOG_ARCHIVES, MAX_GATEWAY_LOG_ARCHIVES);
  return { maxBytes, archives };
}

export type DaemonLogRetentionFs = {
  stat: (path: string) => Promise<{ size: number }>;
  rename: (from: string, to: string) => Promise<void>;
  unlink: (path: string) => Promise<void>;
};

const defaultFs: DaemonLogRetentionFs = {
  stat: async (p) => {
    const info = await fs.stat(p);
    return { size: info.size };
  },
  rename: (from, to) => fs.rename(from, to),
  unlink: (p) => fs.unlink(p),
};

function isMissingFileError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  if ((err as NodeJS.ErrnoException).code === "ENOENT") {
    return true;
  }
  const message = (err as { message?: unknown }).message;
  return typeof message === "string" && message.startsWith("ENOENT");
}

export type RotateResult =
  | { rotated: false; reason: "missing" | "below-cap" | "disabled"; sizeBytes?: number }
  | { rotated: true; archivedTo: string; sizeBytes: number };

export async function rotateOversizedDaemonLog(
  params: {
    path: string;
    limits: GatewayLogRetentionLimits;
  },
  deps: DaemonLogRetentionFs = defaultFs,
): Promise<RotateResult> {
  const { path: logPath, limits } = params;
  if (limits.maxBytes <= 0) {
    return { rotated: false, reason: "disabled" };
  }
  let size: number;
  try {
    const info = await deps.stat(logPath);
    size = info.size;
  } catch (err) {
    if (isMissingFileError(err)) {
      return { rotated: false, reason: "missing" };
    }
    throw err;
  }
  if (size <= limits.maxBytes) {
    return { rotated: false, reason: "below-cap", sizeBytes: size };
  }
  if (limits.archives === 0) {
    await deps.unlink(logPath).catch((err: unknown) => {
      if (!isMissingFileError(err)) {
        throw err;
      }
    });
    return { rotated: true, archivedTo: "", sizeBytes: size };
  }
  for (let i = limits.archives; i >= 2; i -= 1) {
    const from = `${logPath}.${i - 1}`;
    const to = `${logPath}.${i}`;
    try {
      await deps.rename(from, to);
    } catch (err) {
      if (!isMissingFileError(err)) {
        throw err;
      }
    }
  }
  const archivedTo = `${logPath}.1`;
  try {
    await deps.unlink(archivedTo);
  } catch (err) {
    if (!isMissingFileError(err)) {
      throw err;
    }
  }
  await deps.rename(logPath, archivedTo);
  return { rotated: true, archivedTo, sizeBytes: size };
}

export async function applyGatewayLogRetention(
  env: GatewayServiceEnv,
  deps: DaemonLogRetentionFs = defaultFs,
): Promise<{ stdout: RotateResult; stderr: RotateResult; limits: GatewayLogRetentionLimits }> {
  const limits = resolveGatewayLogRetentionLimits(env);
  const { stdoutPath, stderrPath } = resolveGatewayLogPaths(env);
  const [stdout, stderr] = await Promise.all([
    rotateOversizedDaemonLog({ path: stdoutPath, limits }, deps),
    rotateOversizedDaemonLog({ path: stderrPath, limits }, deps),
  ]);
  return { stdout, stderr, limits };
}
