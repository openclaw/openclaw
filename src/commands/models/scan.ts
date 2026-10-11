import { cancel, type CANCEL_SYMBOL, multiselect as clackMultiselect } from "@clack/prompts";
import { getEnvApiKey } from "@openclaw/ai/internal/env-api-keys";
import {
  parseStrictFiniteNumber,
  parseStrictPositiveInteger,
} from "@openclaw/normalization-core/number-coercion";
import { styleSelectParams } from "../../../packages/terminal-core/src/prompt-select-styled-params.js";
import { stylePromptTitle } from "../../../packages/terminal-core/src/prompt-style.js";
import { sanitizeTerminalText } from "../../../packages/terminal-core/src/safe-text.js";
import { resolveApiKeyForProviderCore } from "../../agents/model-auth.js";
import { type ModelScanResult, scanOpenRouterModels } from "../../agents/model-scan.js";
import { formatCliCommand } from "../../cli/command-format.js";
import { withProgressTotals } from "../../cli/progress.js";
import { logConfigUpdated } from "../../config/logging.js";
import { toAgentModelListLike } from "../../config/model-input.js";
import { type RuntimeEnv, writeRuntimeJson } from "../../runtime.js";
import { padTerminalCell, truncate } from "./list.format.js";
import { loadModelsConfig } from "./load-config.js";
import { formatMs, formatTokenK, updateConfig } from "./shared.js";

const MODEL_PAD = 42;
const CTX_PAD = 8;

function guardPromptCancel<T>(value: T | typeof CANCEL_SYMBOL, runtime: RuntimeEnv): T {
  if (typeof value === "symbol") {
    cancel(stylePromptTitle("Model scan cancelled.") ?? "Model scan cancelled.");
    runtime.exit(0);
    throw new Error("unreachable");
  }
  return value;
}

function sortScanResults(
  results: ModelScanResult[],
  capability: "tool" | "image" = "tool",
): ModelScanResult[] {
  return results.toSorted((a, b) => {
    if (capability === "tool" && a.image.ok !== b.image.ok) {
      return Number(b.image.ok) - Number(a.image.ok);
    }
    const aLatency = a[capability].latencyMs ?? Number.POSITIVE_INFINITY;
    const bLatency = b[capability].latencyMs ?? Number.POSITIVE_INFINITY;
    return aLatency === bLatency ? compareScanMetadata(a, b) : aLatency - bLatency;
  });
}

function compareScanMetadata(a: ModelScanResult, b: ModelScanResult): number {
  const aCtx = a.contextLength ?? 0;
  const bCtx = b.contextLength ?? 0;
  if (aCtx !== bCtx) {
    return bCtx - aCtx;
  }

  const aParams = a.inferredParamB ?? 0;
  const bParams = b.inferredParamB ?? 0;
  return aParams === bParams ? a.modelRef.localeCompare(b.modelRef) : bParams - aParams;
}

function buildScanHint(result: ModelScanResult): string {
  const capabilities = (["tool", "image"] as const).map((key) => {
    const probe = result[key];
    return `${key === "tool" ? "tool" : "img"} ${probe.skipped ? "skip" : probe.ok ? formatMs(probe.latencyMs) : "fail"}`;
  });
  const ctxLabel = result.contextLength ? `ctx ${formatTokenK(result.contextLength)}` : "ctx ?";
  const paramLabel = result.inferredParamB ? `${result.inferredParamB}b` : null;
  return [...capabilities, ctxLabel, paramLabel].filter(Boolean).join(" | ");
}

function printScanSummary(results: ModelScanResult[], runtime: RuntimeEnv) {
  const toolOk = results.filter((r) => r.tool.ok);
  const imageOk = results.filter((r) => r.image.ok);
  const toolImageOk = results.filter((r) => r.tool.ok && r.image.ok);
  const imageOnly = imageOk.filter((r) => !r.tool.ok);
  runtime.log(
    `Scan results: tested ${results.length}, tool ok ${toolOk.length}, image ok ${imageOk.length}, tool+image ok ${toolImageOk.length}, image only ${imageOnly.length}`,
  );
}

function printScanTable(results: ModelScanResult[], runtime: RuntimeEnv) {
  const header = [
    padTerminalCell("Model", MODEL_PAD),
    padTerminalCell("Tool", 10),
    padTerminalCell("Image", 10),
    padTerminalCell("Ctx", CTX_PAD),
    padTerminalCell("Params", 8),
    "Notes",
  ].join(" ");
  runtime.log(header);

  for (const entry of results) {
    const modelLabel = padTerminalCell(truncate(entry.modelRef, MODEL_PAD), MODEL_PAD);
    const toolLabel = padTerminalCell(
      entry.tool.skipped ? "skip" : entry.tool.ok ? formatMs(entry.tool.latencyMs) : "fail",
      10,
    );
    const imageLabel = padTerminalCell(
      entry.image.ok ? formatMs(entry.image.latencyMs) : entry.image.skipped ? "skip" : "fail",
      10,
    );
    const ctxLabel = padTerminalCell(formatTokenK(entry.contextLength), CTX_PAD);
    const paramsLabel = padTerminalCell(entry.inferredParamB ? `${entry.inferredParamB}b` : "-", 8);
    const notes = entry.modality ? `modality:${sanitizeTerminalText(entry.modality)}` : "";

    runtime.log([modelLabel, toolLabel, imageLabel, ctxLabel, paramsLabel, notes].join(" "));
  }
}

function parseOptionalFiniteOption(
  raw: unknown,
  label: string,
  allowZero = false,
): number | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  const parsed = parseStrictFiniteNumber(raw);
  if (parsed === undefined || (allowZero ? parsed < 0 : parsed <= 0)) {
    throw new Error(`${label} must be ${allowZero ? ">=" : ">"} 0`);
  }
  return parsed;
}

function parsePositiveIntegerOption(raw: unknown, label: string, fallback: number): number {
  if (raw === undefined || raw === null) {
    return fallback;
  }
  const parsed = parseStrictPositiveInteger(raw);
  if (parsed === undefined) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

export async function modelsScanCommand(
  opts: {
    minParams?: string;
    maxAgeDays?: string;
    provider?: string;
    maxCandidates?: string;
    timeout?: string;
    concurrency?: string;
    yes?: boolean;
    input?: boolean;
    setDefault?: boolean;
    setImage?: boolean;
    json?: boolean;
    probe?: boolean;
  },
  runtime: RuntimeEnv,
) {
  const minParams = parseOptionalFiniteOption(opts.minParams, "--min-params", true);
  const maxAgeDays = parseOptionalFiniteOption(opts.maxAgeDays, "--max-age-days", true);
  const maxCandidates = parsePositiveIntegerOption(opts.maxCandidates, "--max-candidates", 6);
  const timeout = parseOptionalFiniteOption(opts.timeout, "--timeout");
  const concurrency =
    opts.concurrency === undefined
      ? undefined
      : parsePositiveIntegerOption(opts.concurrency, "--concurrency", 1);

  const requestedProbe = opts.probe ?? true;
  if (!requestedProbe && (opts.setDefault || opts.setImage)) {
    throw new Error(
      "Cannot apply metadata-only OpenRouter scan results. Remove --no-probe or configure OPENROUTER_API_KEY and rerun with checks before changing defaults.",
    );
  }
  let probe = requestedProbe;
  let storedKey: string | undefined;
  if (requestedProbe) {
    storedKey = getEnvApiKey("openrouter")?.trim() || undefined;
    if (!storedKey) {
      try {
        const cfg = await loadModelsConfig({ commandName: "models scan" });
        const resolved = await resolveApiKeyForProviderCore({
          provider: "openrouter",
          cfg,
        });
        storedKey = resolved.apiKey?.trim() || undefined;
      } catch {
        storedKey = undefined;
      }
    }
    if (!storedKey) {
      if (opts.setDefault || opts.setImage) {
        throw new Error(
          "Cannot apply metadata-only OpenRouter scan results. Configure OPENROUTER_API_KEY and rerun with checks before changing defaults.",
        );
      }
      // Without a key, keep the command useful as catalog discovery only; writes
      // stay blocked because metadata-only rows have not proven runtime support.
      probe = false;
    }
  }
  const results = await withProgressTotals(
    {
      label: "Scanning OpenRouter models...",
      indeterminate: false,
      enabled: opts.json !== true,
    },
    async (update) =>
      await scanOpenRouterModels({
        apiKey: storedKey ?? undefined,
        minParamB: minParams,
        maxAgeDays,
        providerFilter: opts.provider,
        timeoutMs: timeout,
        concurrency,
        probe,
        onProgress: ({ phase, completed, total }) => {
          if (phase !== "probe") {
            return;
          }
          const labelBase = probe ? "Checking models" : "Scanning models";
          update({
            completed,
            total,
            label: `${labelBase} (${completed}/${total})`,
          });
        },
      }),
  );
  const sorted = sortScanResults(results);

  if (!probe) {
    if (!opts.json) {
      if (requestedProbe) {
        runtime.log(
          "OpenRouter free models still require OPENROUTER_API_KEY for live checks and inference. Listing public catalog metadata only.",
        );
      }
      runtime.log(
        `Found ${results.length} OpenRouter free models (metadata only; configure OPENROUTER_API_KEY to test tools/images).`,
      );
      printScanTable(sorted, runtime);
    } else {
      writeRuntimeJson(runtime, sorted);
    }
    return;
  }

  const toolOk = results.filter((entry) => entry.tool.ok);
  if (toolOk.length === 0) {
    throw new Error(
      `No tool-capable OpenRouter free models found. Try ${formatCliCommand("openclaw models scan --no-probe")} to inspect metadata-only candidates, or configure OPENROUTER_API_KEY before checking.`,
    );
  }

  const toolSorted = sortScanResults(toolOk);
  const imageOk = results.filter((entry) => entry.image.ok);
  const imageSorted = sortScanResults(imageOk, "image");
  const imagePreferred = toolSorted.filter((entry) => entry.image.ok);
  const preselectPool = imagePreferred.length > 0 ? imagePreferred : toolSorted;
  const preselected = preselectPool
    .slice(0, Math.floor(maxCandidates))
    .map((entry) => entry.modelRef);
  const imagePreselected = imageSorted
    .slice(0, Math.floor(maxCandidates))
    .map((entry) => entry.modelRef);

  if (!opts.json) {
    printScanSummary(results, runtime);
    printScanTable(sorted, runtime);
  }

  const noInput = opts.input === false;
  const canPrompt = process.stdin.isTTY && !opts.yes && !noInput && !opts.json;
  let selected: string[] = preselected;
  let selectedImages: string[] = imagePreselected;

  if (canPrompt) {
    const choose = async (
      message: string,
      candidates: ModelScanResult[],
      initialValues: string[],
    ) =>
      guardPromptCancel(
        await clackMultiselect(
          styleSelectParams({
            message,
            options: candidates.map((entry) => ({
              value: entry.modelRef,
              label: entry.modelRef,
              hint: buildScanHint(entry),
            })),
            initialValues,
          }),
        ),
        runtime,
      );
    selected = await choose("Select fallback models (ordered)", toolSorted, preselected);
    if (imageSorted.length > 0) {
      selectedImages = await choose(
        "Select image fallback models (ordered)",
        imageSorted,
        imagePreselected,
      );
    }
  } else if (!process.stdin.isTTY && !opts.yes && !noInput && !opts.json) {
    throw new Error("Non-interactive scan: pass --yes to apply defaults.");
  }

  if (selected.length === 0) {
    throw new Error("No models selected for fallbacks.");
  }
  if (opts.setImage && selectedImages.length === 0) {
    throw new Error("No image-capable models selected for image model.");
  }

  await updateConfig((cfg) => {
    const nextModels = { ...cfg.agents?.defaults?.models };
    for (const entry of [...selected, ...selectedImages]) {
      if (!nextModels[entry]) {
        nextModels[entry] = {};
      }
    }
    const withFallbacks = (
      field: "model" | "imageModel",
      fallbacks: string[],
      setPrimary?: boolean,
    ) => {
      const existing = toAgentModelListLike(cfg.agents?.defaults?.[field]);
      return {
        ...(existing?.primary ? { primary: existing.primary } : {}),
        fallbacks,
        ...(setPrimary ? { primary: fallbacks[0] } : {}),
      };
    };
    const nextImageModel =
      selectedImages.length > 0
        ? withFallbacks("imageModel", selectedImages, opts.setImage)
        : cfg.agents?.defaults?.imageModel;
    const nextModel = withFallbacks("model", selected, opts.setDefault);
    cfg.agents ??= {};
    cfg.agents.defaults = {
      ...cfg.agents.defaults,
      model: nextModel,
      ...(nextImageModel ? { imageModel: nextImageModel } : {}),
      models: nextModels,
    };
    return cfg;
  });

  if (opts.json) {
    writeRuntimeJson(runtime, {
      selected,
      selectedImages,
      setDefault: Boolean(opts.setDefault),
      setImage: Boolean(opts.setImage),
      results: sorted,
      warnings: [],
    });
    return;
  }

  logConfigUpdated(runtime);
  runtime.log(`Fallbacks: ${selected.join(", ")}`);
  if (selectedImages.length > 0) {
    runtime.log(`Image fallbacks: ${selectedImages.join(", ")}`);
  }
  if (opts.setDefault) {
    runtime.log(`Default model: ${selected[0]}`);
  }
  if (opts.setImage && selectedImages.length > 0) {
    runtime.log(`Image model: ${selectedImages[0]}`);
  }
}
