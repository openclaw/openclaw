import { freezeJsonSnapshot } from "../shared/immutable-data.js";
import { cloneEnvWithPlatformSemantics } from "./config-env-vars.js";
import {
  getRetainedLegacyDefaultAgentId,
  setRetainedLegacyDefaultAgentId,
} from "./legacy.default-agent-owner-state.js";
import { cloneConfigWithResolutionFacts } from "./resolution-facts.js";
import type { OpenClawConfig } from "./types.openclaw.js";

type RuntimeConfigCapture = Readonly<{ source: OpenClawConfig; origin: OpenClawConfig }>;

const captures = new WeakMap<OpenClawConfig, RuntimeConfigCapture>();

export function getRuntimeConfigCapture(
  config: OpenClawConfig | undefined,
): RuntimeConfigCapture | undefined {
  return config ? captures.get(config) : undefined;
}

/** Freeze a selected runtime/source pair before its publication owner yields. */
export function captureRuntimeConfigWithSource(
  config: OpenClawConfig,
  source: OpenClawConfig,
): OpenClawConfig {
  const clone = (value: OpenClawConfig) => {
    const captured = cloneConfigWithResolutionFacts(value);
    setRetainedLegacyDefaultAgentId(captured, getRetainedLegacyDefaultAgentId(value));
    return freezeJsonSnapshot(captured);
  };
  const captured = clone(config);
  const capturedSource = source === config ? captured : clone(source);
  captures.set(captured, { source: capturedSource, origin: config });
  if (capturedSource !== captured) {
    captures.set(capturedSource, { source: capturedSource, origin: source });
  }
  return captured;
}

export type CapturedRuntimeConfigRead = { config: OpenClawConfig; env: NodeJS.ProcessEnv };

/** Retain effective environment alongside the selected config/source publication. */
export function captureRuntimeConfigRead(
  config: OpenClawConfig,
  source: OpenClawConfig,
): CapturedRuntimeConfigRead {
  return {
    config: captureRuntimeConfigWithSource(config, source),
    env: cloneEnvWithPlatformSemantics(process.env),
  };
}
