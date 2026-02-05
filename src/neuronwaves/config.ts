import type { NeuronWavesConfig } from "./types.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import { isTruthyEnvValue } from "../infra/env.js";

const DEFAULT_INACTIVITY = "20m";
const DEFAULT_BASE_INTERVAL = "45m";
const DEFAULT_JITTER = "30m";
const DEFAULT_MAX_WAVE = "10m";

function parseMs(raw: string, fallbackMs: number) {
  try {
    const ms = parseDurationMs(raw, { defaultUnit: "m" });
    if (Number.isFinite(ms) && ms > 0) {
      return ms;
    }
  } catch {
    // ignore
  }
  return fallbackMs;
}

export function resolveNeuronWavesConfigFromEnv(): NeuronWavesConfig {
  const enabled = isTruthyEnvValue(process.env.OPENCLAW_NEURONWAVES);
  const inactivityMs = parseMs(
    process.env.OPENCLAW_NEURONWAVES_INACTIVITY ?? DEFAULT_INACTIVITY,
    parseDurationMs(DEFAULT_INACTIVITY, { defaultUnit: "m" }),
  );
  const baseIntervalMs = parseMs(
    process.env.OPENCLAW_NEURONWAVES_BASE ?? DEFAULT_BASE_INTERVAL,
    parseDurationMs(DEFAULT_BASE_INTERVAL, { defaultUnit: "m" }),
  );
  const jitterMs = parseMs(
    process.env.OPENCLAW_NEURONWAVES_JITTER ?? DEFAULT_JITTER,
    parseDurationMs(DEFAULT_JITTER, { defaultUnit: "m" }),
  );
  const maxWaveMs = parseMs(
    process.env.OPENCLAW_NEURONWAVES_MAX_WAVE ?? DEFAULT_MAX_WAVE,
    parseDurationMs(DEFAULT_MAX_WAVE, { defaultUnit: "m" }),
  );
  const postPrComments = isTruthyEnvValue(process.env.OPENCLAW_NEURONWAVES_PR_COMMENTS);

  const prRepo = (process.env.OPENCLAW_NEURONWAVES_PR_REPO ?? "").trim();
  const prNumberRaw = (process.env.OPENCLAW_NEURONWAVES_PR_NUMBER ?? "").trim();
  const prNumber = prNumberRaw ? Number(prNumberRaw) : NaN;
  const pr =
    prRepo && Number.isFinite(prNumber) && prNumber > 0
      ? { repo: prRepo, number: prNumber }
      : undefined;

  return {
    enabled,
    inactivityMs,
    baseIntervalMs,
    jitterMs,
    maxWaveMs,
    postPrComments,
    pr,
  };
}
