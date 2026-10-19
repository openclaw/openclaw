import { loadDotEnv } from "../infra/dotenv.js";
import {
  createConfigRuntimeEnvBase,
  getPublishedConfigRuntimeEnvState,
} from "./config-env-vars.js";
import { GATEWAY_CONFIG_SELECTION_ENV_KEYS } from "./gateway-env-selection.js";
import { ConfigMutationConflictError } from "./mutation-conflict.js";
import { getRuntimeConfigSourceSnapshot } from "./runtime-snapshot.js";
import type { OpenClawConfig } from "./types.js";

export function maybeLoadDotEnvForConfig(env: NodeJS.ProcessEnv): void {
  // Injected env objects are test/diagnostic sandboxes and must stay isolated.
  if (env === process.env) {
    loadDotEnv({ quiet: true });
  }
}

export function resolveManagedRuntimeEnvBaseline(): {
  publication: ReturnType<typeof getPublishedConfigRuntimeEnvState>;
  sourceConfig: OpenClawConfig;
} {
  // Accepted restart candidates publish env before the runtime snapshot advances.
  // Managed writes must stay on that publication to avoid mixed env refs.
  const published = getPublishedConfigRuntimeEnvState();
  return {
    publication: published,
    sourceConfig: published.sourceConfig ?? getRuntimeConfigSourceSnapshot() ?? {},
  };
}

export function assertManagedRuntimeEnvPublicationCurrent(
  publication: ReturnType<typeof getPublishedConfigRuntimeEnvState>,
): void {
  if (getPublishedConfigRuntimeEnvState() !== publication) {
    throw new ConfigMutationConflictError(
      "active config environment changed while preparing write",
    );
  }
}

export function createManagedRuntimeEnvBase(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return createConfigRuntimeEnvBase(resolveManagedRuntimeEnvBaseline().sourceConfig, env, {
    // Copied caller environments still carry the published layer's recorded ownership.
    ownedEnv: getPublishedConfigRuntimeEnvState().ownedEnv,
    preservedKeys: GATEWAY_CONFIG_SELECTION_ENV_KEYS,
  });
}
