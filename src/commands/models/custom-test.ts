import type { ModelApi } from "../../config/types.models.js";
import { normalizeSecretInputString } from "../../config/types.secrets.js";
import type { RuntimeEnv } from "../../runtime.js";
import { writeRuntimeJson } from "../../runtime.js";
import {
  requestAnthropicVerification,
  requestOpenAiVerification,
  type VerificationResult,
} from "../onboard-custom.js";
import { pad, truncate } from "./list.format.js";
import { loadModelsConfig } from "./load-config.js";
import { formatMs } from "./shared.js";

/** API types that identify a user-configured custom provider entry. */
const CUSTOM_PROVIDER_APIS: ReadonlySet<ModelApi> = new Set<ModelApi>([
  "openai-completions",
  "anthropic-messages",
  "azure-openai-responses",
]);

type CustomModelTestStatus = "ok" | "fail" | "skip";

export type CustomModelTestResult = {
  providerId: string;
  baseUrl: string;
  modelId: string;
  compatibility: "openai" | "anthropic";
  status: CustomModelTestStatus;
  statusCode?: number;
  error?: string;
  latencyMs?: number;
};

function resolveCompatibility(api: string): "openai" | "anthropic" {
  return api === "anthropic-messages" ? "anthropic" : "openai";
}

async function runVerification(params: {
  baseUrl: string;
  apiKey: string;
  modelId: string;
  compatibility: "openai" | "anthropic";
}): Promise<{ result: VerificationResult; latencyMs: number }> {
  const start = Date.now();
  const result =
    params.compatibility === "anthropic"
      ? await requestAnthropicVerification({
          baseUrl: params.baseUrl,
          apiKey: params.apiKey,
          modelId: params.modelId,
        })
      : await requestOpenAiVerification({
          baseUrl: params.baseUrl,
          apiKey: params.apiKey,
          modelId: params.modelId,
        });
  return { result, latencyMs: Date.now() - start };
}

function formatResult(result: CustomModelTestResult): string {
  const PROVIDER_PAD = 28;
  const MODEL_PAD = 32;
  const STATUS_PAD = 6;
  const providerLabel = pad(truncate(result.providerId, PROVIDER_PAD), PROVIDER_PAD);
  const modelLabel = pad(truncate(result.modelId, MODEL_PAD), MODEL_PAD);
  const statusLabel = pad(result.status, STATUS_PAD);
  const detail =
    result.status === "ok"
      ? formatMs(result.latencyMs)
      : result.statusCode !== undefined
        ? `status ${result.statusCode}`
        : (result.error ?? "");
  return [providerLabel, modelLabel, statusLabel, detail].join(" ");
}

function printResultsTable(results: CustomModelTestResult[], runtime: RuntimeEnv) {
  const PROVIDER_PAD = 28;
  const MODEL_PAD = 32;
  const STATUS_PAD = 6;
  const header = [
    pad("Provider", PROVIDER_PAD),
    pad("Model", MODEL_PAD),
    pad("Status", STATUS_PAD),
    "Detail",
  ].join(" ");
  runtime.log(header);
  for (const result of results) {
    runtime.log(formatResult(result));
  }
}

export async function modelsCustomTestCommand(
  opts: {
    json?: boolean;
    provider?: string;
    concurrency?: string;
  },
  runtime: RuntimeEnv,
): Promise<void> {
  const concurrency = opts.concurrency ? Number(opts.concurrency) : 4;
  if (!Number.isFinite(concurrency) || concurrency <= 0) {
    throw new Error("--concurrency must be > 0");
  }

  const cfg = await loadModelsConfig({ commandName: "models custom-test", runtime });
  const providers = cfg.models?.providers ?? {};

  // Collect test targets: all models across all custom providers.
  type TestTarget = {
    providerId: string;
    baseUrl: string;
    modelId: string;
    apiKey: string;
    compatibility: "openai" | "anthropic";
  };

  const targets: TestTarget[] = [];

  for (const [providerId, providerConfig] of Object.entries(providers)) {
    if (!providerConfig) {
      continue;
    }
    const { baseUrl, api, models } = providerConfig;
    if (!baseUrl || !api || !CUSTOM_PROVIDER_APIS.has(api)) {
      continue;
    }
    // Filter by --provider if specified.
    if (opts.provider && opts.provider !== providerId) {
      continue;
    }
    const apiKey = normalizeSecretInputString(providerConfig.apiKey) ?? "";
    const compatibility = resolveCompatibility(api);

    for (const model of models ?? []) {
      if (!model.id) {
        continue;
      }
      targets.push({ providerId, baseUrl, modelId: model.id, apiKey, compatibility });
    }
  }

  if (targets.length === 0) {
    const providerFilter = opts.provider ? ` for provider "${opts.provider}"` : "";
    runtime.log(`No custom model providers found${providerFilter}.`);
    if (opts.json) {
      writeRuntimeJson(runtime, { results: [] });
    }
    return;
  }

  runtime.log(
    `Testing ${targets.length} custom model${targets.length === 1 ? "" : "s"} across ${
      new Set(targets.map((t) => t.providerId)).size
    } provider${new Set(targets.map((t) => t.providerId)).size === 1 ? "" : "s"}...`,
  );

  // Run verifications with bounded concurrency.
  const results: CustomModelTestResult[] = [];
  let idx = 0;

  async function worker() {
    while (idx < targets.length) {
      const target = targets[idx++];
      if (!target) {
        break;
      }
      let testResult: CustomModelTestResult;
      try {
        const { result, latencyMs } = await runVerification({
          baseUrl: target.baseUrl,
          apiKey: target.apiKey,
          modelId: target.modelId,
          compatibility: target.compatibility,
        });
        testResult = {
          providerId: target.providerId,
          baseUrl: target.baseUrl,
          modelId: target.modelId,
          compatibility: target.compatibility,
          status: result.ok ? "ok" : "fail",
          ...(result.status !== undefined ? { statusCode: result.status } : {}),
          latencyMs: result.ok ? latencyMs : undefined,
        };
      } catch (err) {
        testResult = {
          providerId: target.providerId,
          baseUrl: target.baseUrl,
          modelId: target.modelId,
          compatibility: target.compatibility,
          status: "fail",
          error: err instanceof Error ? err.message : String(err),
        };
      }
      results.push(testResult);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, targets.length) }, () => worker());
  await Promise.all(workers);

  // Sort: provider then model for stable output.
  results.sort((a, b) => {
    const p = a.providerId.localeCompare(b.providerId);
    return p !== 0 ? p : a.modelId.localeCompare(b.modelId);
  });

  if (opts.json) {
    writeRuntimeJson(runtime, { results });
    return;
  }

  printResultsTable(results, runtime);

  const okCount = results.filter((r) => r.status === "ok").length;
  const failCount = results.filter((r) => r.status === "fail").length;
  runtime.log(`\nResults: ${okCount} ok, ${failCount} failed out of ${results.length} total.`);

  if (failCount > 0) {
    runtime.exit(1);
  }
}
