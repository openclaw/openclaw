import {
  createNormalizedPluginsConfig,
  type NormalizedPluginsConfig,
} from "../plugins/config-state.js";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";
import { cloneConfigWithResolutionFacts } from "./resolution-facts.js";
import type { OpenClawConfig } from "./types.openclaw.js";

type RuntimeConfigCapture = Readonly<{
  source: OpenClawConfig;
  origin: OpenClawConfig;
  plugins: NormalizedPluginsConfig;
}>;

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
  const clone = (value: OpenClawConfig) =>
    freezeJsonSnapshot(cloneConfigWithResolutionFacts(value));
  const captured = clone(config);
  const capturedSource = source === config ? captured : clone(source);
  // Captures own cloned payloads, so policy must resolve against this revision, not live config.
  captures.set(captured, {
    source: capturedSource,
    origin: config,
    plugins: createNormalizedPluginsConfig(captured.plugins),
  });
  if (capturedSource !== captured) {
    captures.set(capturedSource, {
      source: capturedSource,
      origin: source,
      plugins: createNormalizedPluginsConfig(capturedSource.plugins),
    });
  }
  return captured;
}

export type CapturedRuntimeConfigRead = { config: OpenClawConfig; env: NodeJS.ProcessEnv };
