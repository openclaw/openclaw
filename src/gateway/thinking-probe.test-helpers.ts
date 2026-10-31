// Live thinking-probe records: raw facts about what one provider route accepts per thinking level.
import { readdirSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { configureAiTransportHost, getAiTransportHost } from "@openclaw/ai";
import { MODEL_DATA_THINKING_LEVELS } from "../../packages/llm-core/src/model-data.js";
import type { ModelApi } from "../config/model-config-vocabulary.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../config/types.models.js";
import { redactSensitiveText } from "../logging/redact.js";

const ERROR_TEXT_LIMIT = 4_000;
// Conversation content is not a route fact; keep every other top-level request param.
const CONTENT_KEYS = new Set([
  "contents",
  "input",
  "instructions",
  "messages",
  "system",
  "systemInstruction",
  "tools",
]);

// Manifest rows are schema-validated in the repo; they carry config-row fields plus catalog extras.
type ManifestCatalogProvider = {
  api?: ModelApi;
  baseUrl?: string;
  headers?: Record<string, string>;
  models?: Array<Partial<ModelDefinitionConfig>>;
};

export type ThinkingProbeRoute = {
  provider: string;
  plugin: string;
  envVars: string[];
  catalog?: ManifestCatalogProvider;
};

export type ThinkingProbeRequest = {
  url: string;
  params?: Record<string, unknown>;
  status?: number;
  error?: string;
};

export type ThinkingProbeTurn = {
  level: string;
  requests: ThinkingProbeRequest[];
  model?: string;
  usage?: unknown;
  reply?: string;
  error?: string;
};

export type ThinkingProbeRecord = {
  schemaVersion: 1;
  probedAt: string;
  provider: string;
  model: string;
  envVar: string;
  /** The config-only provider row the turns ran on (key as an env reference). */
  row: unknown;
  turns: ThinkingProbeTurn[];
};

/** Finds the plugin that owns a provider route and its manifest key env var names. */
export function resolveThinkingProbeRoute(rootDir: string, provider: string): ThinkingProbeRoute {
  const extensionsDir = path.join(rootDir, "extensions");
  for (const plugin of readdirSync(extensionsDir)) {
    let manifest: {
      providers?: string[];
      setup?: { providers?: Array<{ id?: string; envVars?: string[] }> };
      modelCatalog?: { providers?: Record<string, ManifestCatalogProvider> };
    };
    try {
      manifest = JSON.parse(
        readFileSync(path.join(extensionsDir, plugin, "openclaw.plugin.json"), "utf8"),
      );
    } catch {
      continue;
    }
    if (!manifest.providers?.includes(provider)) {
      continue;
    }
    const envVars = manifest.setup?.providers?.find((entry) => entry.id === provider)?.envVars;
    if (!envVars?.length) {
      throw new Error(`${plugin} manifest has no setup.providers[].envVars for ${provider}`);
    }
    return { provider, plugin, envVars, catalog: manifest.modelCatalog?.providers?.[provider] };
  }
  throw new Error(`no plugin manifest declares provider ${provider}`);
}

const PROBE_EFFORTS = MODEL_DATA_THINKING_LEVELS.filter((level) => level !== "off");

/**
 * A config-only copy of the route's shipped row that offers every level. Provider
 * plugin hooks can narrow shipped rows; a config-only row reaches the wire with
 * each level's own value, so the record shows what the route accepts.
 */
export function buildThinkingProbeProviderConfig(params: {
  route: ThinkingProbeRoute;
  model: string;
  envVar: string;
}): ModelProviderConfig {
  const { catalog } = params.route;
  if (!catalog?.api || !catalog.baseUrl) {
    throw new Error(
      `${params.route.plugin} manifest has no modelCatalog row for ${params.route.provider}`,
    );
  }
  const shipped = catalog.models?.find((row) => row.id === params.model);
  return {
    api: catalog.api,
    baseUrl: catalog.baseUrl,
    ...(catalog.headers ? { headers: catalog.headers } : {}),
    apiKey: { source: "env", provider: "default", id: params.envVar },
    models: [
      {
        id: params.model,
        name: shipped?.name ?? params.model,
        reasoning: true,
        input: shipped?.input ?? ["text"],
        cost: shipped?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: shipped?.contextWindow,
        maxTokens: shipped?.maxTokens ?? 8_192,
        thinkingLevelMap: Object.fromEntries(PROBE_EFFORTS.map((level) => [level, level])),
        compat: {
          ...shipped?.compat,
          supportsReasoningEffort: true,
          supportedReasoningEfforts: [...PROBE_EFFORTS],
        },
      },
    ],
  };
}

// Probe files are committed: provider errors also echo account, org and key ids.
const ACCOUNT_ID_RE = /\b[A-Za-z]{2,8}[-_][A-Za-z0-9]{16,}\b/gu;

export function redactThinkingProbeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  // Decode JSON \u00XX escapes first so an escaped `<` cannot hide an id's word boundary.
  const decoded = text.replace(/\\u00([0-9a-f]{2})/giu, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
  return redactSensitiveText(decoded).replace(ACCOUNT_ID_RE, "[id]").slice(0, ERROR_TEXT_LIMIT);
}

async function readRequestParams(
  body: BodyInit | null | undefined,
): Promise<Record<string, unknown> | undefined> {
  const text =
    typeof body === "string"
      ? body
      : ArrayBuffer.isView(body)
        ? new TextDecoder().decode(body)
        : body instanceof Blob
          ? await body.text()
          : undefined;
  if (text === undefined) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    return Object.fromEntries(Object.entries(parsed).filter(([key]) => !CONTENT_KEYS.has(key)));
  } catch {
    return undefined;
  }
}

/** Observes every model HTTP request through the transport host without changing its bytes. */
export function startThinkingProbeWireCapture() {
  const host = getAiTransportHost();
  let requests: ThinkingProbeRequest[] = [];
  configureAiTransportHost({
    ...host,
    buildModelFetch: (...args) => {
      const fetchModel = host.buildModelFetch(...args) ?? globalThis.fetch;
      return (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        );
        const params = await readRequestParams(init?.body);
        // Drop the query: some routes carry keys there.
        const entry: ThinkingProbeRequest = {
          url: `${url.origin}${url.pathname}`,
          ...(params ? { params } : {}),
        };
        requests.push(entry);
        try {
          const response = await fetchModel(input, init);
          entry.status = response.status;
          if (!response.ok) {
            entry.error = redactThinkingProbeError(await response.clone().text());
          }
          return response;
        } catch (error) {
          entry.error = redactThinkingProbeError(String(error));
          throw error;
        }
      }) as typeof fetch;
    },
  });
  return {
    take(): ThinkingProbeRequest[] {
      const taken = requests;
      requests = [];
      return taken;
    },
    close() {
      configureAiTransportHost(host);
    },
  };
}

/** Writes `extensions/<plugin>/probes/<model>.<provider>.<YYYY-MM-DD>.json` and returns its path. */
export async function writeThinkingProbeRecord(params: {
  rootDir: string;
  plugin: string;
  record: ThinkingProbeRecord;
  secretValues: readonly string[];
}): Promise<string> {
  const date = params.record.probedAt.slice(0, 10);
  const text = `${JSON.stringify(params.record, null, 2)}\n`;
  if (params.secretValues.some((value) => value && text.includes(value))) {
    throw new Error("thinking probe record contains a credential value");
  }
  // One plugin can own several routes; the route provider keeps their records apart.
  const fileName = [params.record.model, params.record.provider, date, "json"]
    .map((part) => part.replace(/[^A-Za-z0-9._-]/gu, "_"))
    .join(".");
  const filePath = path.join(params.rootDir, "extensions", params.plugin, "probes", fileName);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text);
  return filePath;
}
