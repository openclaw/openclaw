import { isDeepStrictEqual } from "node:util";
import { sha256Base64Url } from "../infra/crypto-digest.js";
import { isDeeplyFrozenPlainData, isPlainData } from "../shared/immutable-data.js";
import {
  cloneConfigWithResolutionFacts,
  serializeConfigResolutionFacts,
} from "./resolution-facts.js";
import { stableConfigStringify } from "./runtime-config-snapshot-match.js";
import type { OpenClawConfig } from "./types.openclaw.js";

export type RuntimeConfigValueFact = {
  value: OpenClawConfig | null;
  fingerprint: string;
  facts: ReturnType<typeof serializeConfigResolutionFacts>;
};
// Diagnostic callers stop at their raw revision; this owner accepts config objects.
// Only immutable identities share hashes across reads.
const immutableConfigHashes = new WeakMap<OpenClawConfig, string>();

export function hashRuntimeConfigValue(value: OpenClawConfig): string {
  const immutable = isDeeplyFrozenPlainData(value);
  const cached = immutable ? immutableConfigHashes.get(value) : undefined;
  if (cached !== undefined) {
    return cached;
  }
  const fingerprint = sha256Base64Url(stableConfigStringify(value));
  if (immutable) {
    immutableConfigHashes.set(value, fingerprint);
  }
  return fingerprint;
}

export function hashRuntimeConfigPreparation(config: OpenClawConfig): string {
  return sha256Base64Url(
    stableConfigStringify({ config, facts: serializeConfigResolutionFacts(config) }),
  );
}

// A detached publication value proves reuse across mutable clones without trusting their identity.
export function prepareRuntimeConfigValueFact(
  config: OpenClawConfig,
  previous: RuntimeConfigValueFact | null,
): RuntimeConfigValueFact {
  const facts = serializeConfigResolutionFacts(config);
  if (isPlainData(config)) {
    if (previous?.value && isDeepStrictEqual(previous.value, config)) {
      return isDeepStrictEqual(previous.facts, facts) ? previous : { ...previous, facts };
    }
    try {
      const value = cloneConfigWithResolutionFacts(config);
      return {
        value: isDeepStrictEqual(value, config) ? value : null,
        fingerprint: hashRuntimeConfigValue(config),
        facts,
      };
    } catch (error) {
      // Symbols can be serialized by the existing hash contract, but cannot be cloned.
      if (!(error instanceof Error && error.name === "DataCloneError")) {
        throw error;
      }
    }
  }
  return { value: null, fingerprint: hashRuntimeConfigValue(config), facts };
}

export function matchesRuntimeConfigValueFact(
  config: OpenClawConfig,
  fact: RuntimeConfigValueFact,
): boolean {
  return fact.value
    ? isDeepStrictEqual(config, fact.value)
    : hashRuntimeConfigValue(config) === fact.fingerprint;
}

export function matchesRuntimeConfigPublicationFact(
  config: OpenClawConfig,
  fact: RuntimeConfigValueFact,
): boolean {
  return (
    matchesRuntimeConfigValueFact(config, fact) &&
    isDeepStrictEqual(serializeConfigResolutionFacts(config), fact.facts)
  );
}

export function matchesRuntimeSourceConfigValueFact(
  config: OpenClawConfig,
  fact: RuntimeConfigValueFact,
): boolean {
  const project = ({ meta, ...values }: OpenClawConfig) => {
    const { lastTouchedVersion: _lastTouchedVersion, ...sourceMeta } = meta ?? {};
    return { ...values, meta: sourceMeta };
  };
  return (
    (matchesRuntimeConfigValueFact(config, fact) ||
      (fact.value !== null && isDeepStrictEqual(project(config), project(fact.value)))) &&
    isDeepStrictEqual(serializeConfigResolutionFacts(config), fact.facts)
  );
}

export function hashModelConfig(config: OpenClawConfig, sourceConfig: OpenClawConfig): string {
  const project = (value: OpenClawConfig) => {
    const { ui: _ui, meta, ...rest } = value;
    const { lastTouchedVersion: _lastTouchedVersion, ...modelMeta } = meta ?? {};
    return { config: { ...rest, meta: modelMeta }, facts: serializeConfigResolutionFacts(value) };
  };
  return sha256Base64Url(
    stableConfigStringify({ runtime: project(config), source: project(sourceConfig) }),
  );
}
