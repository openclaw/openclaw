import type { DatabaseSync } from "node:sqlite";
import { readCurrentConfigForPolicyCheck } from "../config/io.js";
import { resolveConfigPath, resolveIsNixMode } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { updateConfigMachineStateInDatabase } from "../state/config-machine-state-write.js";
import { readConfigMachineStateRowInDatabase } from "../state/config-machine-state.js";
import { isTruthyEnvValue } from "./env.js";
import { buildUpdateResultPayload, type UpdateResultPayload } from "./update-result-payload.js";
import type { UpdateRunLedgerOptions } from "./update-run-codec.js";
import type { UpdateRunRecord } from "./update-run-record.js";

// Internal local bookkeeping key, not a user configuration or consent setting.
const KEY = "telemetry.updateResults";
const HOUR = 60 * 60 * 1000;
const MAX_ACTIVE = 16;
// One bounded singleton, not an outbox. All identity and times remain local.
type LocalState = { eligible: string[]; attempted: string[]; lastAttemptAt?: number };

function updateResultTelemetryEnabled(config: OpenClawConfig, env = process.env): boolean {
  return (
    config.update?.checkOnStart !== false &&
    !isTruthyEnvValue(env.OPENCLAW_NO_AUTO_UPDATE) &&
    !isTruthyEnvValue(env.CI) &&
    !resolveIsNixMode(env)
  );
}

function currentUpdatePolicy(env: NodeJS.ProcessEnv): boolean {
  try {
    return updateResultTelemetryEnabled(
      readCurrentConfigForPolicyCheck({ configPath: resolveConfigPath(env), env }),
      env,
    );
  } catch {
    return false;
  }
}

/** Admission is recorded only at creation, never by scanning historical update records. */
export function admitUpdateResultTelemetry(
  db: DatabaseSync,
  runId: string,
  options: UpdateRunLedgerOptions,
): void {
  try {
    if (!currentUpdatePolicy(options.env ?? process.env)) {
      return;
    }
    updateConfigMachineStateInDatabase<LocalState>(
      db,
      KEY,
      (state) => ({
        ...state,
        eligible: [...(state?.eligible ?? []).filter((id) => id !== runId), runId].slice(
          -MAX_ACTIVE,
        ),
        attempted: (state?.attempted ?? []).slice(-MAX_ACTIVE),
      }),
      Date.now(),
    );
  } catch {
    // Config/storage failure must never affect update admission or enable reporting.
  }
}

/** Claim and drop before network, atomically with the authoritative terminal write. */
export function claimUpdateResultTelemetry(
  db: DatabaseSync,
  run: UpdateRunRecord,
  options: UpdateRunLedgerOptions,
): UpdateResultPayload | undefined {
  try {
    if (run.status === "running" || !readConfigMachineStateRowInDatabase(db, KEY)) {
      return undefined;
    }
    let payload: UpdateResultPayload | undefined;
    const now = Date.now();
    updateConfigMachineStateInDatabase<LocalState>(
      db,
      KEY,
      (state) => {
        if (!state?.eligible.includes(run.runId)) {
          return state;
        }
        const next = { ...state, eligible: state.eligible.filter((id) => id !== run.runId) };
        if (
          state.attempted.includes(run.runId) ||
          !currentUpdatePolicy(options.env ?? process.env) ||
          (state.lastAttemptAt !== undefined && now - state.lastAttemptAt < HOUR) ||
          // Abandonment can subsequently be repaired; it is not a settled diagnosis.
          run.reason === "abandoned" ||
          run.reason === "superseded"
        ) {
          return next;
        }
        payload = buildUpdateResultPayload(run);
        return payload
          ? {
              ...next,
              lastAttemptAt: now,
              attempted: [...state.attempted, run.runId].slice(-MAX_ACTIVE),
            }
          : next;
      },
      now,
    );
    return payload;
  } catch {
    return undefined;
  }
}

/** Independent of daily-check cache. Never awaited by update/recovery/startup. */
export async function sendUpdateResultTelemetry(
  payload: UpdateResultPayload,
  options: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; getPolicy?: () => boolean } = {},
): Promise<void> {
  try {
    const env = options.env ?? process.env;
    if (
      !options.fetchImpl &&
      (process.env.VITEST !== undefined || process.env.NODE_ENV === "test")
    ) {
      return;
    }
    const endpoint =
      env.OPENCLAW_TELEMETRY_ENDPOINT?.trim() || "https://telemetry.openclaw.ai/api/latest-version";
    const url = new URL(endpoint);
    // No embedded credentials, redirects, cookies, or version-bearing headers.
    if (url.username || url.password || !["https:", "http:"].includes(url.protocol)) {
      return;
    }
    const body = JSON.stringify(payload);
    if (
      Buffer.byteLength(body) > 4096 ||
      !(options.getPolicy ?? (() => currentUpdatePolicy(env)))()
    ) {
      return;
    }
    const fetchImpl = options.fetchImpl ?? fetch;
    const signal = AbortSignal.timeout(3000);
    // Legacy receivers reject HEAD without recording it. Never send outcome data
    // until this exact endpoint advertises the separately configured receiver.
    const capability = await fetchImpl(endpoint, {
      method: "HEAD",
      redirect: "error",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { "User-Agent": "openclaw-update-result/1" },
      signal,
    });
    await capability.body?.cancel();
    if (
      capability.status !== 204 ||
      capability.headers.get("OpenClaw-Update-Results") !== "2" ||
      !(options.getPolicy ?? (() => currentUpdatePolicy(env)))()
    ) {
      return;
    }
    const response = await fetchImpl(endpoint, {
      method: "POST",
      redirect: "error",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json", "User-Agent": "openclaw-update-result/1" },
      body,
      signal,
    });
    await response.body?.cancel();
  } catch {
    // No retry, raw payload/error logging, or recursive telemetry on failure.
  }
}
