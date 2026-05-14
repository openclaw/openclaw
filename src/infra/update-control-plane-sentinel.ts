import fs from "node:fs/promises";
import {
  markUpdateRestartSentinelFailure,
  writeRestartSentinel,
  type RestartSentinelPayload,
} from "./restart-sentinel.js";
import {
  buildUpdateRestartSentinelPayload,
  type UpdateRestartSentinelMeta,
} from "./update-restart-sentinel-payload.js";
import type { UpdateRunResult } from "./update-runner.js";

export const CONTROL_PLANE_UPDATE_SENTINEL_META_ENV = "OPENCLAW_CONTROL_PLANE_UPDATE_SENTINEL_META";

export type ControlPlaneUpdateSentinelMetaFile = {
  version: 1;
  meta: UpdateRestartSentinelMeta;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function normalizeMeta(value: unknown): UpdateRestartSentinelMeta | null {
  if (!isRecord(value)) {
    return null;
  }
  const sessionKey = normalizeText(value.sessionKey);
  const threadId = normalizeText(value.threadId);
  const channel = isRecord(value.deliveryContext)
    ? normalizeText(value.deliveryContext.channel)
    : undefined;
  const to = isRecord(value.deliveryContext) ? normalizeText(value.deliveryContext.to) : undefined;
  const accountId = isRecord(value.deliveryContext)
    ? normalizeText(value.deliveryContext.accountId)
    : undefined;
  const deliveryContext =
    channel || to || accountId
      ? {
          ...(channel ? { channel } : {}),
          ...(to ? { to } : {}),
          ...(accountId ? { accountId } : {}),
        }
      : undefined;
  return {
    ...(sessionKey ? { sessionKey } : {}),
    ...(deliveryContext ? { deliveryContext } : {}),
    ...(threadId ? { threadId } : {}),
    note: typeof value.note === "string" ? value.note : null,
    continuationMessage:
      typeof value.continuationMessage === "string" ? value.continuationMessage : null,
  };
}

export async function readControlPlaneUpdateSentinelMeta(
  env: NodeJS.ProcessEnv = process.env,
): Promise<UpdateRestartSentinelMeta | null> {
  const filePath = env[CONTROL_PLANE_UPDATE_SENTINEL_META_ENV]?.trim();
  if (!filePath) {
    return null;
  }
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || parsed.version !== 1) {
      return null;
    }
    return normalizeMeta(parsed.meta);
  } catch {
    return null;
  }
}

export async function writeControlPlaneUpdateRestartSentinel(params: {
  result: UpdateRunResult;
  meta: UpdateRestartSentinelMeta;
}): Promise<string> {
  return await writeRestartSentinel(
    buildUpdateRestartSentinelPayload({
      result: params.result,
      meta: params.meta,
    }),
  );
}

export async function markControlPlaneUpdateRestartSentinelFailure(
  reason: string,
): Promise<RestartSentinelPayload | null> {
  return (await markUpdateRestartSentinelFailure(reason))?.payload ?? null;
}
