import {
  createNormalizedPluginsConfig,
  type NormalizedPluginsConfig,
} from "../plugins/config-state.js";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";
import { cloneConfigWithResolutionFacts } from "./resolution-facts.js";
import { runtimeConfigPublication } from "./runtime-config-publication.js";
import type { OpenClawConfig } from "./types.openclaw.js";

type RuntimeConfigCapture = Readonly<{
  source: OpenClawConfig;
  origin: OpenClawConfig;
  /** The selected payload belonged to the live owner when captured, before preparation yields. */
  runtimeOwned: boolean;
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
  // Ordinary policy reads stay on this revision; explicit live readers retain its owner.
  captures.set(captured, {
    source: capturedSource,
    origin: config,
    runtimeOwned: config === runtimeConfigPublication.current?.config,
    plugins: createNormalizedPluginsConfig(captured.plugins),
  });
  if (capturedSource !== captured) {
    captures.set(capturedSource, {
      source: capturedSource,
      origin: source,
      runtimeOwned: source === runtimeConfigPublication.current?.config,
      plugins: createNormalizedPluginsConfig(capturedSource.plugins),
    });
  }
  return captured;
}

export type CapturedRuntimeConfigRead = { config: OpenClawConfig; env: NodeJS.ProcessEnv };
