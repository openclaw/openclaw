import { canonicalizeLocale, type TranslationMap } from "../../i18n/index.ts";
import type { OpenClawApp } from "../app.ts";

export type ControlUiI18nGeneratedLocale = {
  locale: string;
  generatedAtMs: number;
  updatedAtMs: number;
  sourceHash: string;
  stale: boolean;
};

export type ControlUiI18nJob = {
  jobId: string;
  locale: string;
  status: "queued" | "running" | "completed" | "failed";
  requestedAtMs: number;
  startedAtMs?: number;
  finishedAtMs?: number;
  error?: string;
  requesterConnId?: string;
};

export type ControlUiI18nListResult = {
  sourceLocale: "en";
  sourceHash: string;
  generatedLocales: ControlUiI18nGeneratedLocale[];
  jobs: ControlUiI18nJob[];
};

export type ControlUiI18nGetResult = {
  locale: string;
  sourceLocale: "en";
  sourceHash: string;
  stale: boolean;
  generatedAtMs: number;
  translation: Record<string, unknown>;
};

export type ControlUiI18nGenerateResult = {
  accepted: true;
  deduped?: boolean;
  job: Pick<ControlUiI18nJob, "jobId" | "locale" | "status" | "requestedAtMs">;
};

export type ControlUiI18nEventPayload = {
  jobId: string;
  locale: string;
  status: "queued" | "running" | "completed" | "failed";
  requestedAtMs?: number;
  startedAtMs?: number;
  requesterConnId?: string;
  error?: string;
  finishedAtMs?: number;
};

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseControlUiI18nEventPayload(payload: unknown): ControlUiI18nEventPayload | null {
  if (!isObjectRecord(payload)) {
    return null;
  }
  const locale = canonicalizeLocale(typeof payload.locale === "string" ? payload.locale : null);
  const status = payload.status;
  const jobId = typeof payload.jobId === "string" ? payload.jobId : "";
  if (!locale || !jobId) {
    return null;
  }
  if (
    status !== "queued" &&
    status !== "running" &&
    status !== "completed" &&
    status !== "failed"
  ) {
    return null;
  }
  return {
    jobId,
    locale,
    status,
    requesterConnId:
      typeof payload.requesterConnId === "string" ? payload.requesterConnId : undefined,
    error: typeof payload.error === "string" ? payload.error : undefined,
    finishedAtMs: typeof payload.finishedAtMs === "number" ? payload.finishedAtMs : undefined,
  };
}

export function mergeControlUiI18nJobEvent(
  jobs: readonly ControlUiI18nJob[],
  event: ControlUiI18nEventPayload,
): ControlUiI18nJob[] {
  const next = [...jobs];
  const index = next.findIndex((job) => job.jobId === event.jobId);
  const existing = index >= 0 ? next[index] : undefined;
  const merged: ControlUiI18nJob = {
    jobId: event.jobId,
    locale: event.locale,
    status: event.status,
    requestedAtMs: event.requestedAtMs ?? existing?.requestedAtMs ?? Date.now(),
    startedAtMs:
      event.status === "running"
        ? (event.startedAtMs ?? existing?.startedAtMs ?? Date.now())
        : existing?.startedAtMs,
    finishedAtMs: event.finishedAtMs ?? existing?.finishedAtMs,
    error: event.error ?? existing?.error,
    requesterConnId: event.requesterConnId ?? existing?.requesterConnId,
  };
  if (index >= 0) {
    next[index] = merged;
  } else {
    next.unshift(merged);
  }
  return next.toSorted((a, b) => b.requestedAtMs - a.requestedAtMs);
}

function normalizeTranslationMap(value: unknown): TranslationMap | null {
  if (!isObjectRecord(value)) {
    return null;
  }
  const out: Record<string, string | TranslationMap> = {};
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string") {
      out[key] = child;
      continue;
    }
    const nested = normalizeTranslationMap(child);
    if (!nested) {
      return null;
    }
    out[key] = nested;
  }
  return out as TranslationMap;
}

export async function loadControlUiI18nCatalog(
  app: OpenClawApp,
): Promise<ControlUiI18nListResult | null> {
  if (!app.client) {
    return null;
  }
  const result = await app.client.request<ControlUiI18nListResult>("controlui.i18n.list", {});
  app.controlUiI18nCatalog = result;
  app.controlUiI18nJobs = result.jobs;
  return result;
}

export async function generateControlUiLocale(
  app: OpenClawApp,
  params: { locale: string; force?: boolean },
): Promise<ControlUiI18nGenerateResult> {
  if (!app.client) {
    throw new Error("gateway not connected");
  }
  const locale = canonicalizeLocale(params.locale);
  if (!locale) {
    throw new Error("invalid locale");
  }
  const result = await app.client.request<ControlUiI18nGenerateResult>("controlui.i18n.generate", {
    locale,
    force: params.force,
  });
  app.controlUiI18nJobs = mergeControlUiI18nJobEvent(app.controlUiI18nJobs, {
    jobId: result.job.jobId,
    locale,
    status: result.job.status,
    requestedAtMs: result.job.requestedAtMs,
  });
  return result;
}

export async function loadGeneratedLocaleTranslation(
  app: OpenClawApp,
  localeRaw: string,
): Promise<TranslationMap | null> {
  if (!app.client) {
    return null;
  }
  const locale = canonicalizeLocale(localeRaw);
  if (!locale) {
    return null;
  }
  const result = await app.client.request<ControlUiI18nGetResult>("controlui.i18n.get", { locale });
  return normalizeTranslationMap(result.translation);
}
