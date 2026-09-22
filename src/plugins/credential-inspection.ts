import type {
  PluginCredentialDescriptor,
  PluginCredentialInspection,
} from "../../packages/gateway-protocol/src/schema/plugin-credentials.js";
import { hasUnresolvedConfigPath, resolveConfigSecretRef } from "../config/resolution-facts.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isValidSecretRef } from "../secrets/ref-contract.js";
import { formatConcreteConfigPath } from "../shared/dot-path.js";

/** Projection only: never call a secret resolver or return a literal from sourceConfig. */
export function inspectPluginCredentialValue(
  config: OpenClawConfig,
  descriptor: PluginCredentialDescriptor,
  env: NodeJS.ProcessEnv,
): PluginCredentialInspection {
  let value: unknown = config;
  for (const segment of descriptor.path) {
    value =
      value !== null && typeof value === "object" && Object.hasOwn(value, segment)
        ? Reflect.get(value, segment)
        : undefined;
  }
  const path = formatConcreteConfigPath(descriptor.path, config);
  const ref = resolveConfigSecretRef({
    config,
    path,
    value,
    defaults: config.secrets?.defaults,
    includeResolved: true,
  });
  if (ref && isValidSecretRef(ref)) {
    return { kind: "reference", ref, unresolved: hasUnresolvedConfigPath(config, path) };
  }
  if (typeof value === "string" && value.length) {
    return { kind: "literal" };
  }
  if (value !== undefined && value !== "") {
    return { kind: "invalid" };
  }
  const envVar = descriptor.envVars.find((name) => Boolean(env[name]?.trim()));
  return envVar ? { kind: "environment", envVar } : { kind: "missing" };
}
