import type { BotConfig } from "../../config/config.js";
import {
  normalizeOptionalSecretInput,
  normalizeSecretInput,
} from "../../utils/normalize-secret-input.js";
import { resolveFetch } from "../fetch.js";

type KmsSecretsExtension = {
  kms?: {
    siteUrl?: string;
    projectId?: string;
    projectSlug?: string;
    environment?: string;
    secretPath?: string;
    accessToken?: string;
    machineIdentity?: {
      clientId?: string;
      clientSecret?: string;
    };
    cacheTtlMs?: number;
    requestTimeoutMs?: number;
  };
};

const DEFAULT_SITE_URL = "https://kms.hanzo.ai";
const DEFAULT_SECRET_PATH = "/";
const DEFAULT_CACHE_TTL_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_TOKEN_TTL_MS = 10 * 60_000;

type ParsedKmsSecretRef = {
  secretName: string;
  projectId?: string;
  projectSlug?: string;
  environment?: string;
  secretPath?: string;
  siteUrl?: string;
  version?: number;
};

type EffectiveKmsConfig = {
  siteUrl: string;
  projectId?: string;
  projectSlug?: string;
  environment: string;
  secretPath: string;
  accessToken?: string;
  clientId?: string;
  clientSecret?: string;
  cacheTtlMs: number;
  requestTimeoutMs: number;
};

type CachedToken = {
  token: string;
  expiresAt: number;
};

type CachedSecretValue = {
  value: string;
  expiresAt: number;
};

const tokenCache = new Map<string, CachedToken>();
const secretCache = new Map<string, CachedSecretValue>();

function trim(value: unknown): string | undefined {
  const normalized = normalizeOptionalSecretInput(value);
  return normalized ? normalized : undefined;
}

function firstDefined(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value) {
      return value;
    }
  }
  return undefined;
}

function normalizeSiteUrl(value?: string): string {
  const siteUrl = trim(value) ?? DEFAULT_SITE_URL;
  return siteUrl.replace(/\/+$/, "");
}

function normalizeSecretPath(value?: string): string {
  const raw = trim(value) ?? DEFAULT_SECRET_PATH;
  if (!raw || raw === "/") {
    return "/";
  }
  const withLeadingSlash = raw.startsWith("/") ? raw : `/${raw}`;
  const trimmed = withLeadingSlash.replace(/\/+$/, "");
  return trimmed || "/";
}

function parsePositiveInteger(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function isKmsSecretReference(value: unknown): value is string {
  return typeof value === "string" && value.trim().toLowerCase().startsWith("kms://");
}

export function parseKmsSecretReference(reference: string): ParsedKmsSecretRef {
  const trimmedRef = reference.trim();
  if (!isKmsSecretReference(trimmedRef)) {
    throw new Error(`Invalid KMS secret reference: ${reference}`);
  }

  const parsed = new URL(trimmedRef);
  const hostPart = parsed.hostname.trim();
  const pathPart = parsed.pathname.replace(/^\/+/, "").trim();
  const secretName = decodeURIComponent(hostPart || pathPart);
  if (!secretName) {
    throw new Error(`KMS secret reference missing secret name: ${reference}`);
  }

  const projectId = firstDefined(
    trim(parsed.searchParams.get("projectId")),
    trim(parsed.searchParams.get("workspaceId")),
  );
  const projectSlug = firstDefined(
    trim(parsed.searchParams.get("projectSlug")),
    trim(parsed.searchParams.get("workspaceSlug")),
  );
  const environment = firstDefined(
    trim(parsed.searchParams.get("environment")),
    trim(parsed.searchParams.get("env")),
  );
  const secretPath = firstDefined(
    trim(parsed.searchParams.get("secretPath")),
    trim(parsed.searchParams.get("path")),
  );
  const siteUrl = trim(parsed.searchParams.get("siteUrl"));
  const version = parsePositiveInteger(parsed.searchParams.get("version"));

  return {
    secretName,
    projectId,
    projectSlug,
    environment,
    secretPath,
    siteUrl,
    version,
  };
}

function resolveEffectiveKmsConfig(params: {
  cfg?: BotConfig;
  env?: NodeJS.ProcessEnv;
  ref: ParsedKmsSecretRef;
}): EffectiveKmsConfig {
  const env = params.env ?? process.env;
  const secrets = params.cfg?.secrets as (BotConfig["secrets"] & KmsSecretsExtension) | undefined;
  const kmsCfg = secrets?.kms;

  const projectId = firstDefined(
    params.ref.projectId,
    trim(kmsCfg?.projectId),
    trim(env.BOT_SECRETS_KMS_PROJECT_ID),
    trim(env.KMS_PROJECT_ID),
  );
  const projectSlug = firstDefined(
    params.ref.projectSlug,
    trim(kmsCfg?.projectSlug),
    trim(env.BOT_SECRETS_KMS_PROJECT_SLUG),
    trim(env.KMS_PROJECT_SLUG),
    trim(env.BOT_SECRETS_KMS_WORKSPACE_SLUG),
    trim(env.KMS_WORKSPACE_SLUG),
  );
  const environment = firstDefined(
    params.ref.environment,
    trim(kmsCfg?.environment),
    trim(env.BOT_SECRETS_KMS_ENVIRONMENT),
    trim(env.KMS_ENVIRONMENT),
    trim(env.BOT_SECRETS_KMS_ENV),
    trim(env.KMS_ENV),
  );
  const secretPath = normalizeSecretPath(
    firstDefined(
      params.ref.secretPath,
      trim(kmsCfg?.secretPath),
      trim(env.BOT_SECRETS_KMS_SECRET_PATH),
      trim(env.KMS_SECRET_PATH),
    ),
  );

  const siteUrl = normalizeSiteUrl(
    firstDefined(
      params.ref.siteUrl,
      trim(kmsCfg?.siteUrl),
      trim(env.BOT_SECRETS_KMS_SITE_URL),
      trim(env.KMS_SITE_URL),
      trim(env.INFISICAL_URL),
    ),
  );

  const accessToken = firstDefined(
    trim(kmsCfg?.accessToken),
    trim(env.BOT_SECRETS_KMS_ACCESS_TOKEN),
    trim(env.KMS_ACCESS_TOKEN),
    trim(env.INFISICAL_TOKEN),
  );
  const clientId = firstDefined(
    trim(kmsCfg?.machineIdentity?.clientId),
    trim(env.BOT_SECRETS_KMS_CLIENT_ID),
    trim(env.KMS_CLIENT_ID),
    trim(env.KMS_MACHINE_IDENTITY_CLIENT_ID),
    trim(env.INFISICAL_CLIENT_ID),
  );
  const clientSecret = firstDefined(
    trim(kmsCfg?.machineIdentity?.clientSecret),
    trim(env.BOT_SECRETS_KMS_CLIENT_SECRET),
    trim(env.KMS_CLIENT_SECRET),
    trim(env.KMS_MACHINE_IDENTITY_CLIENT_SECRET),
    trim(env.INFISICAL_CLIENT_SECRET),
  );

  if (!projectId && !projectSlug) {
    throw new Error(
      "KMS secret reference requires project id or slug. Set secrets.kms.projectId/projectSlug or include ?projectId=... in the reference.",
    );
  }
  if (!environment) {
    throw new Error(
      "KMS secret reference requires environment. Set secrets.kms.environment or include ?environment=... in the reference.",
    );
  }

  return {
    siteUrl,
    projectId,
    projectSlug,
    environment,
    secretPath,
    accessToken,
    clientId,
    clientSecret,
    cacheTtlMs: Math.max(0, kmsCfg?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS),
    requestTimeoutMs: Math.max(1_000, kmsCfg?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
  };
}

async function requestJson(params: {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: Record<string, string>;
  timeoutMs: number;
  fetchFn?: typeof fetch;
}): Promise<unknown> {
  const fetchFn = resolveFetch(params.fetchFn);
  if (!fetchFn) {
    throw new Error("KMS fetch unavailable in this runtime.");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const response = await fetchFn(params.url, {
      method: params.method ?? "GET",
      headers: {
        ...(params.body ? { "Content-Type": "application/json" } : {}),
        ...params.headers,
      },
      ...(params.body ? { body: JSON.stringify(params.body) } : {}),
      signal: controller.signal,
    });
    const body = await response.text();
    if (!response.ok) {
      const summary = body.trim().slice(0, 300);
      throw new Error(
        `KMS request failed (${response.status} ${response.statusText}) for ${params.url}${
          summary ? `: ${summary}` : ""
        }`,
      );
    }
    if (!body.trim()) {
      return {};
    }
    return JSON.parse(body) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

function getTokenCacheKey(config: EffectiveKmsConfig): string {
  return `${config.siteUrl}|${config.clientId}`;
}

async function resolveAccessToken(params: {
  config: EffectiveKmsConfig;
  fetchFn?: typeof fetch;
}): Promise<string> {
  const { config } = params;
  if (config.accessToken) {
    return config.accessToken;
  }
  if (!config.clientId || !config.clientSecret) {
    throw new Error(
      "KMS secret reference needs auth credentials. Set secrets.kms.accessToken or machine identity credentials.",
    );
  }

  const cacheKey = getTokenCacheKey(config);
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  const payload = (await requestJson({
    url: `${config.siteUrl}/api/v1/auth/universal-auth/login`,
    method: "POST",
    body: {
      clientId: config.clientId,
      clientSecret: config.clientSecret,
    },
    timeoutMs: config.requestTimeoutMs,
    fetchFn: params.fetchFn,
  })) as Record<string, unknown>;

  const token = normalizeSecretInput(
    String(
      (payload.accessToken as string | undefined) ??
        (payload.token as string | undefined) ??
        ((payload.data as Record<string, unknown> | undefined)?.accessToken as
          | string
          | undefined) ??
        "",
    ),
  );
  if (!token) {
    throw new Error("KMS universal auth login returned no access token.");
  }

  const expiresIn =
    Number(payload.expiresIn) ||
    Number(payload.expiresInSeconds) ||
    Number((payload.data as Record<string, unknown> | undefined)?.expiresIn) ||
    DEFAULT_TOKEN_TTL_MS / 1000;
  const expiresAt = Date.now() + Math.max(60_000, Math.floor(expiresIn * 1000));
  tokenCache.set(cacheKey, { token, expiresAt });
  return token;
}

function getSecretCacheKey(params: {
  config: EffectiveKmsConfig;
  ref: ParsedKmsSecretRef;
}): string {
  return [
    params.config.siteUrl,
    params.config.projectId ?? "",
    params.config.projectSlug ?? "",
    params.config.environment,
    params.config.secretPath,
    params.ref.secretName,
    String(params.ref.version ?? ""),
  ].join("|");
}

async function fetchSecretValue(params: {
  config: EffectiveKmsConfig;
  ref: ParsedKmsSecretRef;
  token: string;
  fetchFn?: typeof fetch;
}): Promise<string> {
  const url = new URL(
    `/api/v3/secrets/raw/${encodeURIComponent(params.ref.secretName)}`,
    `${params.config.siteUrl}/`,
  );
  if (params.config.projectId) {
    url.searchParams.set("workspaceId", params.config.projectId);
  }
  if (params.config.projectSlug) {
    url.searchParams.set("workspaceSlug", params.config.projectSlug);
  }
  url.searchParams.set("environment", params.config.environment);
  url.searchParams.set("secretPath", params.config.secretPath);
  url.searchParams.set("expandSecretReferences", "true");
  url.searchParams.set("include_imports", "true");
  url.searchParams.set("viewSecretValue", "true");
  if (params.ref.version) {
    url.searchParams.set("version", String(params.ref.version));
  }

  const payload = (await requestJson({
    url: url.toString(),
    headers: { Authorization: `Bearer ${params.token}` },
    timeoutMs: params.config.requestTimeoutMs,
    fetchFn: params.fetchFn,
  })) as {
    secret?: {
      secretValue?: string;
    };
  };

  const value = payload.secret?.secretValue;
  if (typeof value !== "string") {
    throw new Error(`KMS did not return a string secret value for "${params.ref.secretName}".`);
  }

  const normalized = normalizeSecretInput(value);
  if (!normalized) {
    throw new Error(`KMS secret "${params.ref.secretName}" resolved to an empty value.`);
  }
  return normalized;
}

export async function resolveKmsSecretReference(params: {
  reference: string;
  cfg?: BotConfig;
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
}): Promise<string> {
  const ref = parseKmsSecretReference(params.reference);
  const config = resolveEffectiveKmsConfig({ cfg: params.cfg, env: params.env, ref });
  const cacheKey = getSecretCacheKey({ config, ref });

  const cached = secretCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const token = await resolveAccessToken({ config, fetchFn: params.fetchFn });
  const value = await fetchSecretValue({ config, ref, token, fetchFn: params.fetchFn });
  secretCache.set(cacheKey, {
    value,
    expiresAt: Date.now() + config.cacheTtlMs,
  });
  return value;
}

export async function resolveSecretReferenceValue(params: {
  value: string | undefined;
  cfg?: BotConfig;
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
}): Promise<string | undefined> {
  const value = normalizeOptionalSecretInput(params.value);
  if (!value) {
    return undefined;
  }
  if (!isKmsSecretReference(value)) {
    return value;
  }
  return await resolveKmsSecretReference({
    reference: value,
    cfg: params.cfg,
    env: params.env,
    fetchFn: params.fetchFn,
  });
}
