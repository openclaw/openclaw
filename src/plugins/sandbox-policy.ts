/**
 * Sandbox policy for plugin security.
 * Restricts access to dangerous APIs for untrusted plugins.
 */

import type { PluginRuntime } from "./runtime/types.js";
import type { PluginLogger } from "./types.js";

export type PluginPermissions = {
  runCommandWithTimeout?: boolean;
  writeConfigFile?: boolean;
};

export type SandboxPolicy = {
  pluginId: string;
  permissions: {
    runCommandWithTimeout: boolean;
    writeConfigFile: boolean;
  };
};

export type RestrictedApiName = "runCommandWithTimeout" | "writeConfigFile";

/**
 * Create a sandbox policy for a plugin.
 * Logs a warning for each restricted API that is not explicitly permitted.
 */
export function createSandboxPolicy(
  pluginId: string,
  permissions: PluginPermissions | undefined,
  logger: PluginLogger,
): SandboxPolicy {
  const resolved = {
    runCommandWithTimeout: permissions?.runCommandWithTimeout ?? false,
    writeConfigFile: permissions?.writeConfigFile ?? false,
  };

  const restricted: string[] = [];
  if (!resolved.runCommandWithTimeout) {
    restricted.push("system.runCommandWithTimeout");
  }
  if (!resolved.writeConfigFile) {
    restricted.push("config.writeConfigFile");
  }

  if (restricted.length > 0) {
    logger.warn(`plugin has restricted access to: ${restricted.join(", ")}`);
  }

  return {
    pluginId,
    permissions: resolved,
  };
}

/**
 * Create a blocking function that throws when called.
 * Used to replace restricted APIs when permission is not granted.
 */
function createBlockingFunction(
  policy: SandboxPolicy,
  apiName: RestrictedApiName,
  logger: PluginLogger,
): () => never {
  return () => {
    logger.error(`blocked call to ${apiName} - plugin does not have permission`);
    throw new Error(
      `Access denied: ${apiName} requires permissions.${apiName}:true in plugin config for "${policy.pluginId}"`,
    );
  };
}

/**
 * Create a sandboxed version of the plugin runtime.
 * Wraps dangerous APIs (runCommandWithTimeout, writeConfigFile) with permission checks.
 * Each API is individually gated by its corresponding permission.
 */
export function createSandboxedRuntime(
  runtime: PluginRuntime,
  policy: SandboxPolicy,
  logger: PluginLogger,
): PluginRuntime {
  const allPermitted =
    policy.permissions.runCommandWithTimeout && policy.permissions.writeConfigFile;

  // If all permissions granted, return original runtime
  if (allPermitted) {
    return runtime;
  }

  // Create blocked versions of dangerous APIs (only block those without permission)
  const wrappedRunCommandWithTimeout = policy.permissions.runCommandWithTimeout
    ? runtime.system.runCommandWithTimeout
    : (createBlockingFunction(
        policy,
        "runCommandWithTimeout",
        logger,
      ) as typeof runtime.system.runCommandWithTimeout);

  const wrappedWriteConfigFile = policy.permissions.writeConfigFile
    ? runtime.config.writeConfigFile
    : (createBlockingFunction(
        policy,
        "writeConfigFile",
        logger,
      ) as typeof runtime.config.writeConfigFile);

  // Return a new runtime with sandboxed APIs
  return {
    ...runtime,
    system: {
      ...runtime.system,
      runCommandWithTimeout: wrappedRunCommandWithTimeout,
    },
    config: {
      ...runtime.config,
      writeConfigFile: wrappedWriteConfigFile,
    },
  };
}
