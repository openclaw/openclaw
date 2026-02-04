import fs from "node:fs";
import type { CronJob } from "../types.js";
import type { CronServiceState } from "./state.js";
import { parseAbsoluteTimeMs } from "../parse.js";
import { migrateLegacyCronPayload } from "../payload-migration.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { recomputeNextRuns } from "./jobs.js";
import { inferLegacyName, normalizeOptionalText } from "./normalize.js";

function hasLegacyDeliveryHints(payload: Record<string, unknown>) {
  if (typeof payload.deliver === "boolean") {
    return true;
  }
  if (typeof payload.bestEffortDeliver === "boolean") {
    return true;
  }
  if (typeof payload.to === "string" && payload.to.trim()) {
    return true;
  }
  return false;
}

function buildDeliveryFromLegacyPayload(payload: Record<string, unknown>) {
  const deliver = payload.deliver;
  const mode = deliver === false ? "none" : "announce";
  const channelRaw =
    typeof payload.channel === "string" ? payload.channel.trim().toLowerCase() : "";
  const toRaw = typeof payload.to === "string" ? payload.to.trim() : "";
  const next: Record<string, unknown> = { mode };
  if (channelRaw) {
    next.channel = channelRaw;
  }
  if (toRaw) {
    next.to = toRaw;
  }
  if (typeof payload.bestEffortDeliver === "boolean") {
    next.bestEffort = payload.bestEffortDeliver;
  }
  return next;
}

function stripLegacyDeliveryFields(payload: Record<string, unknown>) {
  if ("deliver" in payload) {
    delete payload.deliver;
  }
  if ("channel" in payload) {
    delete payload.channel;
  }
  if ("to" in payload) {
    delete payload.to;
  }
  if ("bestEffortDeliver" in payload) {
    delete payload.bestEffortDeliver;
  }
}

async function getFileMtimeMs(path: string): Promise<number | null> {
  try {
    const stats = await fs.promises.stat(path);
    return stats.mtimeMs;
  } catch {
    return null;
  }
}

export async function ensureLoaded(state: CronServiceState) {
  const fileMtimeMs = await getFileMtimeMs(state.deps.storePath);

  // Check if we need to reload:
  // - No store loaded yet
  // - File modification time has changed
  // - File was modified after we last loaded (external edit)
  const needsReload =
    !state.store ||
    (fileMtimeMs !== null &&
      state.storeFileMtimeMs !== null &&
      fileMtimeMs > state.storeFileMtimeMs);

  if (!needsReload) {
    return;
  }

  const loaded = await loadCronStore(state.deps.storePath);
  const jobs = (loaded.jobs ?? []) as unknown as Array<Record<string, unknown>>;
  let mutated = false;
  for (const raw of jobs) {
    const nameRaw = raw.name;
    if (typeof nameRaw !== "string" || nameRaw.trim().length === 0) {
      raw.name = inferLegacyName({
        schedule: raw.schedule as never,
        payload: raw.payload as never,
      });
      mutated = true;
    } else {
      raw.name = nameRaw.trim();
    }

    const desc = normalizeOptionalText(raw.description);
    if (raw.description !== desc) {
      raw.description = desc;
      mutated = true;
    }

    if (typeof raw.enabled !== "boolean") {
      raw.enabled = true;
      mutated = true;
    }

    const payload = raw.payload;
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      if (migrateLegacyCronPayload(payload as Record<string, unknown>)) {
        mutated = true;
      }
    }

    const schedule = raw.schedule;
    if (schedule && typeof schedule === "object" && !Array.isArray(schedule)) {
      const sched = schedule as Record<string, unknown>;
      const kind = typeof sched.kind === "string" ? sched.kind.trim().toLowerCase() : "";
      if (!kind && ("at" in sched || "atMs" in sched)) {
        sched.kind = "at";
        mutated = true;
      }
      const atRaw = typeof sched.at === "string" ? sched.at.trim() : "";
      const atMsRaw = sched.atMs;
      const parsedAtMs =
        typeof atMsRaw === "number"
          ? atMsRaw
          : typeof atMsRaw === "string"
            ? parseAbsoluteTimeMs(atMsRaw)
            : atRaw
              ? parseAbsoluteTimeMs(atRaw)
              : null;
      if (parsedAtMs !== null) {
        sched.at = new Date(parsedAtMs).toISOString();
        if ("atMs" in sched) {
          delete sched.atMs;
        }
        mutated = true;
      }
    }

    const delivery = raw.delivery;
    if (delivery && typeof delivery === "object" && !Array.isArray(delivery)) {
      const modeRaw = (delivery as { mode?: unknown }).mode;
      if (typeof modeRaw === "string") {
        const lowered = modeRaw.trim().toLowerCase();
        if (lowered === "deliver") {
          (delivery as { mode?: unknown }).mode = "announce";
          mutated = true;
        }
      }
    }

    const isolation = raw.isolation;
    if (isolation && typeof isolation === "object" && !Array.isArray(isolation)) {
      delete raw.isolation;
      mutated = true;
    }

    const payloadRecord =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : null;
    const payloadKind =
      payloadRecord && typeof payloadRecord.kind === "string" ? payloadRecord.kind : "";
    const sessionTarget =
      typeof raw.sessionTarget === "string" ? raw.sessionTarget.trim().toLowerCase() : "";
    const isIsolatedAgentTurn =
      sessionTarget === "isolated" || (sessionTarget === "" && payloadKind === "agentTurn");
    const hasDelivery = delivery && typeof delivery === "object" && !Array.isArray(delivery);
    const hasLegacyDelivery = payloadRecord ? hasLegacyDeliveryHints(payloadRecord) : false;

    if (isIsolatedAgentTurn && payloadKind === "agentTurn") {
      if (!hasDelivery) {
        raw.delivery =
          payloadRecord && hasLegacyDelivery
            ? buildDeliveryFromLegacyPayload(payloadRecord)
            : { mode: "announce" };
        mutated = true;
      }
      if (payloadRecord && hasLegacyDelivery) {
        stripLegacyDeliveryFields(payloadRecord);
        mutated = true;
      }
    }
  }
  state.store = { version: 1, jobs: jobs as unknown as CronJob[] };
  state.storeLoadedAtMs = state.deps.nowMs();
  state.storeFileMtimeMs = fileMtimeMs;

  // Recompute next runs after loading to ensure accuracy
  recomputeNextRuns(state);

  if (mutated) {
    await persist(state);
  }
}

export function warnIfDisabled(state: CronServiceState, action: string) {
  if (state.deps.cronEnabled) {
    return;
  }
  if (state.warnedDisabled) {
    return;
  }
  state.warnedDisabled = true;
  state.deps.log.warn(
    { enabled: false, action, storePath: state.deps.storePath },
    "cron: scheduler disabled; jobs will not run automatically",
  );
}

export async function persist(state: CronServiceState) {
  if (!state.store) {
    return;
  }
  await saveCronStore(state.deps.storePath, state.store);
  // Update file mtime after save to prevent immediate reload
  state.storeFileMtimeMs = await getFileMtimeMs(state.deps.storePath);
}
