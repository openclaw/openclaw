import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { agentCommand } from "../commands/agent.js";
import {
  readControlUiEnglishSourceManifestSync,
  type ControlUiEnglishSourceManifest,
} from "../infra/control-ui-assets.js";
import type { ControlUiRootState } from "./control-ui.js";
import { GATEWAY_EVENT_CONTROL_UI_I18N, type GatewayControlUiI18nEventPayload } from "./events.js";
import type {
  ControlUiI18nGenerateResult,
  ControlUiI18nGetResult,
  ControlUiI18nJob,
  ControlUiI18nListResult,
} from "./protocol/index.js";

const GENERATED_LOCALE_SCHEMA_VERSION = 1;
const COMPLETED_JOB_RETENTION_MS = 60 * 60_000;
const FAILED_JOB_RETENTION_MS = 24 * 60 * 60_000;

type JobStatus = GatewayControlUiI18nEventPayload["status"];

type ControlUiI18nLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

type GeneratedLocaleFile = {
  schemaVersion: number;
  locale: string;
  sourceLocale: "en";
  sourceHash: string;
  generatedAtMs: number;
  updatedAtMs: number;
  translation: Record<string, unknown>;
};

type JobRecord = Omit<ControlUiI18nJob, "status"> & {
  status: JobStatus;
  force: boolean;
};

function getNoopRuntime() {
  return {
    log: () => {},
    error: () => {},
    exit: (code: number) => {
      throw new Error(`unexpected exit ${code}`);
    },
  } as const;
}

function canonicalizeLocaleCode(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("locale is required");
  }
  if (trimmed.length > 64) {
    throw new Error("locale too long");
  }
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..")) {
    throw new Error("invalid locale");
  }
  if (!/^[A-Za-z0-9-]+$/.test(trimmed)) {
    throw new Error("invalid locale");
  }
  const canonical = Intl.getCanonicalLocales(trimmed)[0];
  if (!canonical) {
    throw new Error("invalid locale");
  }
  if (canonical.length > 64 || canonical.includes("/") || canonical.includes("\\")) {
    throw new Error("invalid locale");
  }
  return canonical;
}

function nowMs() {
  return Date.now();
}

function extractPlaceholderTokens(input: string): string[] {
  const out = new Set<string>();
  const re = /\{([A-Za-z0-9_]+)\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(input)) !== null) {
    const token = match[1];
    if (token) {
      out.add(token);
    }
  }
  return [...out].toSorted((a, b) => a.localeCompare(b));
}

function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return match?.[1] ?? trimmed;
}

function unflattenTranslationMap(flat: Record<string, string>): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(flat)) {
    const parts = key.split(".").filter(Boolean);
    if (parts.length === 0) {
      continue;
    }
    let cursor: Record<string, unknown> = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i];
      const next = cursor[part];
      if (!next || typeof next !== "object" || Array.isArray(next)) {
        cursor[part] = {};
      }
      cursor = cursor[part] as Record<string, unknown>;
    }
    cursor[parts[parts.length - 1]] = value;
  }
  return root;
}

function validateTranslatedFlatMap(params: {
  sourceFlat: Record<string, string>;
  translated: unknown;
}): Record<string, string> {
  const { sourceFlat, translated } = params;
  if (!translated || typeof translated !== "object" || Array.isArray(translated)) {
    throw new Error("translation output must be a JSON object");
  }
  const record = translated as Record<string, unknown>;
  const sourceKeys = Object.keys(sourceFlat).toSorted((a, b) => a.localeCompare(b));
  const translatedKeys = Object.keys(record).toSorted((a, b) => a.localeCompare(b));
  if (sourceKeys.length !== translatedKeys.length) {
    throw new Error(
      `translation key mismatch (expected ${sourceKeys.length}, got ${translatedKeys.length})`,
    );
  }
  for (let i = 0; i < sourceKeys.length; i += 1) {
    if (sourceKeys[i] !== translatedKeys[i]) {
      throw new Error(`translation keys must exactly match source keys (${translatedKeys[i]})`);
    }
  }

  const out: Record<string, string> = {};
  for (const key of sourceKeys) {
    const value = record[key];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`translation value for "${key}" must be a non-empty string`);
    }
    const sourceTokens = extractPlaceholderTokens(sourceFlat[key] ?? "");
    const translatedTokens = extractPlaceholderTokens(value);
    if (sourceTokens.length !== translatedTokens.length) {
      throw new Error(`placeholder mismatch for "${key}"`);
    }
    for (let i = 0; i < sourceTokens.length; i += 1) {
      if (sourceTokens[i] !== translatedTokens[i]) {
        throw new Error(`placeholder mismatch for "${key}"`);
      }
    }
    out[key] = value;
  }
  return out;
}

function extractAgentText(result: unknown): string {
  if (!result || typeof result !== "object") {
    throw new Error("agent returned no result");
  }
  const payloads = (result as { payloads?: unknown }).payloads;
  if (!Array.isArray(payloads) || payloads.length === 0) {
    throw new Error("agent returned no payloads");
  }
  const firstText = payloads.find(
    (entry) =>
      entry && typeof entry === "object" && typeof (entry as { text?: unknown }).text === "string",
  ) as { text: string } | undefined;
  const text = firstText?.text?.trim();
  if (!text) {
    throw new Error("agent returned empty text");
  }
  return text;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function looksLikeGeneratedLocaleFile(value: unknown): value is GeneratedLocaleFile {
  if (!isObjectRecord(value)) {
    return false;
  }
  return (
    typeof value.locale === "string" &&
    value.sourceLocale === "en" &&
    typeof value.sourceHash === "string" &&
    typeof value.generatedAtMs === "number" &&
    typeof value.updatedAtMs === "number" &&
    isObjectRecord(value.translation)
  );
}

function buildGenerationPrompt(manifest: ControlUiEnglishSourceManifest, locale: string): string {
  return [
    `Translate the following OpenClaw Control UI strings from English into locale "${locale}".`,
    "Return ONLY a valid JSON object (no markdown, no explanation).",
    "Requirements:",
    "- Keep exactly the same keys.",
    "- Keys under auto.* represent literal UI text snippets from across the dashboard; translate those naturally for UI display.",
    "- Preserve placeholders like {time} exactly.",
    "- Preserve commands, URLs, code identifiers, and product name OpenClaw unless translation requires a localized common noun only.",
    "- Keep values as plain strings.",
    "",
    "JSON object to translate (keys must be identical in output):",
    JSON.stringify(manifest.flat, null, 2),
  ].join("\n");
}

export type ControlUiI18nServiceOptions = {
  stateDir: string;
  controlUiRoot: ControlUiRootState | undefined;
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
  log?: ControlUiI18nLogger;
};

export class ControlUiI18nService {
  private readonly localesDir: string;
  private readonly jobsById = new Map<string, JobRecord>();
  private readonly activeJobIdByLocale = new Map<string, string>();

  constructor(private readonly opts: ControlUiI18nServiceOptions) {
    this.localesDir = path.join(this.opts.stateDir, "control-ui", "locales");
  }

  async list(): Promise<ControlUiI18nListResult> {
    this.pruneJobs();
    const manifest = this.tryReadManifest();
    const files = await this.readGeneratedLocaleFiles();
    const generatedLocales = files
      .map((file) => ({
        locale: file.locale,
        generatedAtMs: file.generatedAtMs,
        updatedAtMs: file.updatedAtMs,
        sourceHash: file.sourceHash,
        stale: Boolean(manifest && manifest.sourceHash && file.sourceHash !== manifest.sourceHash),
      }))
      .toSorted((a, b) => a.locale.localeCompare(b.locale));

    const jobs = [...this.jobsById.values()]
      .map((job) => ({ ...job }))
      .toSorted((a, b) => b.requestedAtMs - a.requestedAtMs);

    return {
      sourceLocale: "en",
      sourceHash: manifest?.sourceHash ?? "",
      generatedLocales,
      jobs,
    };
  }

  async get(localeRaw: string): Promise<ControlUiI18nGetResult> {
    const locale = canonicalizeLocaleCode(localeRaw);
    const file = await this.readGeneratedLocaleFile(locale);
    if (!file) {
      throw new Error(`generated locale not found: ${locale}`);
    }
    const manifest = this.tryReadManifest();
    return {
      locale: file.locale,
      sourceLocale: "en",
      sourceHash: manifest?.sourceHash ?? "",
      stale: Boolean(manifest && manifest.sourceHash && file.sourceHash !== manifest.sourceHash),
      generatedAtMs: file.generatedAtMs,
      translation: file.translation,
    };
  }

  async generate(params: {
    locale: string;
    force?: boolean;
    requesterConnId?: string;
  }): Promise<ControlUiI18nGenerateResult> {
    const locale = canonicalizeLocaleCode(params.locale);
    const activeJobId = this.activeJobIdByLocale.get(locale);
    if (activeJobId) {
      const active = this.jobsById.get(activeJobId);
      if (active) {
        return {
          accepted: true,
          deduped: true,
          job: {
            jobId: active.jobId,
            locale: active.locale,
            status: active.status === "queued" ? "queued" : "running",
            requestedAtMs: active.requestedAtMs,
          },
        };
      }
      this.activeJobIdByLocale.delete(locale);
    }

    // Fail fast if Control UI manifest/assets are unavailable.
    this.readManifestOrThrow();

    const jobId = randomUUID();
    const requestedAtMs = nowMs();
    const job: JobRecord = {
      jobId,
      locale,
      status: "queued",
      requestedAtMs,
      requesterConnId: params.requesterConnId,
      force: Boolean(params.force),
    };
    this.jobsById.set(jobId, job);
    this.activeJobIdByLocale.set(locale, jobId);
    this.broadcastJob(job);

    void this.runJob(jobId);

    return {
      accepted: true,
      job: {
        jobId,
        locale,
        status: "queued",
        requestedAtMs,
      },
    };
  }

  private tryReadManifest(): ControlUiEnglishSourceManifest | null {
    try {
      return this.readManifestOrThrow();
    } catch {
      return null;
    }
  }

  private readManifestOrThrow(): ControlUiEnglishSourceManifest {
    const root = this.opts.controlUiRoot;
    if (!root || root.kind !== "resolved") {
      throw new Error(
        "Control UI assets are unavailable. Build Control UI assets (pnpm ui:build) and retry.",
      );
    }
    let parsed: unknown;
    try {
      parsed = readControlUiEnglishSourceManifestSync(root.path);
    } catch (err) {
      throw new Error(
        `Control UI i18n source manifest missing or unreadable. Rebuild Control UI assets (pnpm ui:build). ${String(err)}`,
        { cause: err },
      );
    }
    if (!isObjectRecord(parsed)) {
      throw new Error("Control UI i18n source manifest is invalid");
    }
    const flat = parsed.flat;
    if (
      parsed.sourceLocale !== "en" ||
      typeof parsed.sourceHash !== "string" ||
      !isObjectRecord(flat)
    ) {
      throw new Error("Control UI i18n source manifest is invalid");
    }
    const normalizedFlat: Record<string, string> = {};
    for (const [key, value] of Object.entries(flat)) {
      if (typeof value !== "string") {
        throw new Error("Control UI i18n source manifest is invalid");
      }
      normalizedFlat[key] = value;
    }
    return {
      schemaVersion:
        typeof parsed.schemaVersion === "number" ? Math.floor(parsed.schemaVersion) : 1,
      sourceLocale: "en",
      sourceHash: parsed.sourceHash,
      keyCount:
        typeof parsed.keyCount === "number"
          ? Math.floor(parsed.keyCount)
          : Object.keys(normalizedFlat).length,
      flat: normalizedFlat,
    };
  }

  private async runJob(jobId: string) {
    const job = this.jobsById.get(jobId);
    if (!job) {
      return;
    }

    job.status = "running";
    job.startedAtMs = nowMs();
    this.broadcastJob(job);

    try {
      const manifest = this.readManifestOrThrow();
      const translatedFlat = await this.generateTranslatedFlatMap(manifest, job.locale);
      const translation = unflattenTranslationMap(translatedFlat);
      const existing = await this.readGeneratedLocaleFile(job.locale);
      const generatedAtMs = existing?.generatedAtMs ?? nowMs();
      const updatedAtMs = nowMs();
      const payload: GeneratedLocaleFile = {
        schemaVersion: GENERATED_LOCALE_SCHEMA_VERSION,
        locale: job.locale,
        sourceLocale: "en",
        sourceHash: manifest.sourceHash,
        generatedAtMs,
        updatedAtMs,
        translation,
      };
      await this.writeGeneratedLocaleFile(payload);
      job.status = "completed";
      job.finishedAtMs = updatedAtMs;
      delete job.error;
      this.opts.log?.info?.(`controlui.i18n.generate completed locale=${job.locale}`);
    } catch (err) {
      job.status = "failed";
      job.finishedAtMs = nowMs();
      job.error = err instanceof Error ? err.message : String(err);
      this.opts.log?.warn?.(`controlui.i18n.generate failed locale=${job.locale}: ${job.error}`);
    } finally {
      this.activeJobIdByLocale.delete(job.locale);
      this.broadcastJob(job);
      this.pruneJobs();
    }
  }

  private async generateTranslatedFlatMap(
    manifest: ControlUiEnglishSourceManifest,
    locale: string,
  ): Promise<Record<string, string>> {
    const prompt = buildGenerationPrompt(manifest, locale);
    const result = await agentCommand(
      {
        message: prompt,
        sessionKey: `controlui-i18n:${locale}`,
        deliver: false,
        timeout: "120000",
        thinking: "minimal",
      },
      getNoopRuntime(),
    );
    const text = extractAgentText(result);
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripCodeFence(text));
    } catch (err) {
      throw new Error(`invalid JSON from translation model: ${String(err)}`, { cause: err });
    }
    return validateTranslatedFlatMap({ sourceFlat: manifest.flat, translated: parsed });
  }

  private async ensureLocalesDir() {
    await fs.mkdir(this.localesDir, { recursive: true });
  }

  private localeFilePath(locale: string): string {
    return path.join(this.localesDir, `${locale}.json`);
  }

  private async writeGeneratedLocaleFile(payload: GeneratedLocaleFile) {
    await this.ensureLocalesDir();
    const finalPath = this.localeFilePath(payload.locale);
    const tempPath = `${finalPath}.tmp-${randomUUID()}`;
    await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
    await fs.rename(tempPath, finalPath);
  }

  private async readGeneratedLocaleFile(locale: string): Promise<GeneratedLocaleFile | null> {
    try {
      const raw = await fs.readFile(this.localeFilePath(locale), "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      if (!looksLikeGeneratedLocaleFile(parsed)) {
        throw new Error(`invalid generated locale file format for ${locale}`);
      }
      return {
        schemaVersion:
          typeof parsed.schemaVersion === "number"
            ? Math.floor(parsed.schemaVersion)
            : GENERATED_LOCALE_SCHEMA_VERSION,
        locale: parsed.locale,
        sourceLocale: "en",
        sourceHash: parsed.sourceHash,
        generatedAtMs: parsed.generatedAtMs,
        updatedAtMs: parsed.updatedAtMs,
        translation: parsed.translation,
      };
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err
          ? String((err as { code?: unknown }).code)
          : "";
      if (code === "ENOENT") {
        return null;
      }
      this.opts.log?.warn?.(
        `controlui.i18n: ignoring unreadable locale file ${locale}: ${String(err)}`,
      );
      return null;
    }
  }

  private async readGeneratedLocaleFiles(): Promise<GeneratedLocaleFile[]> {
    try {
      const entries = await fs.readdir(this.localesDir, { withFileTypes: true });
      const out: GeneratedLocaleFile[] = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) {
          continue;
        }
        const locale = entry.name.slice(0, -5);
        const parsed = await this.readGeneratedLocaleFile(locale);
        if (parsed) {
          out.push(parsed);
        }
      }
      return out;
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err
          ? String((err as { code?: unknown }).code)
          : "";
      if (code === "ENOENT") {
        return [];
      }
      this.opts.log?.warn?.(`controlui.i18n: failed reading locales dir: ${String(err)}`);
      return [];
    }
  }

  private broadcastJob(job: JobRecord) {
    const payload: GatewayControlUiI18nEventPayload = {
      jobId: job.jobId,
      locale: job.locale,
      status: job.status,
      requesterConnId: job.requesterConnId,
      error: job.error,
      finishedAtMs: job.finishedAtMs,
    };
    this.opts.broadcast(GATEWAY_EVENT_CONTROL_UI_I18N, payload, { dropIfSlow: true });
  }

  private pruneJobs(now = nowMs()) {
    for (const [jobId, job] of this.jobsById) {
      if (job.status === "queued" || job.status === "running") {
        continue;
      }
      const finishedAtMs = job.finishedAtMs ?? job.requestedAtMs;
      const ttlMs = job.status === "failed" ? FAILED_JOB_RETENTION_MS : COMPLETED_JOB_RETENTION_MS;
      if (now - finishedAtMs > ttlMs) {
        this.jobsById.delete(jobId);
      }
    }
  }
}
