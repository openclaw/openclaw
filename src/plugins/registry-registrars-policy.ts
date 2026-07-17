import type { AuthorizationPolicyRegistration } from "./authorization-policy.types.js";
import {
  normalizePluginHostHookId,
  type PluginTrustedToolPolicyRegistration,
} from "./host-hooks.js";
import type { PluginRegistryState } from "./registry-state.js";
import type {
  PluginAuthorizationPolicyRegistryRegistration,
  PluginRecord,
  PluginTrustedToolPolicyRegistryRegistration,
} from "./registry-types.js";

function normalizePolicyString(value: unknown): string {
  return typeof value === "string" ? normalizePluginHostHookId(value) : "";
}

const AUTHORIZATION_POLICY_OPERATIONS = new Set(["tool.call", "message.action", "command.invoke"]);

function snapshotAuthorizationPolicyHandlers(
  value: unknown,
): AuthorizationPolicyRegistration["handlers"] | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  let keys: readonly PropertyKey[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return undefined;
  }
  const snapshot: AuthorizationPolicyRegistration["handlers"] = {};
  for (const key of keys) {
    if (typeof key !== "string" || !AUTHORIZATION_POLICY_OPERATIONS.has(key)) {
      return undefined;
    }
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      return undefined;
    }
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function") {
      return undefined;
    }
    Object.defineProperty(snapshot, key, {
      configurable: false,
      enumerable: true,
      value: descriptor.value,
      writable: false,
    });
  }
  return snapshot;
}

export function createPolicyRegistrars(state: PluginRegistryState) {
  const { registry, pushDiagnostic } = state;

  const registerTrustedToolPolicy = (
    record: PluginRecord,
    policy: PluginTrustedToolPolicyRegistration,
  ) => {
    if (!policy || typeof policy !== "object") {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "trusted tool policy registration requires id, description, and evaluate()",
      });
      return;
    }
    const id = normalizePolicyString(policy.id);
    const description = normalizePolicyString(policy.description);
    if (!id || !description || typeof policy.evaluate !== "function") {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "trusted tool policy registration requires id, description, and evaluate()",
      });
      return;
    }
    if (
      record.origin !== "bundled" &&
      !(record.contracts?.trustedToolPolicies ?? []).includes(id)
    ) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `plugin must declare contracts.trustedToolPolicies for: ${id}`,
      });
      return;
    }
    if (record.origin !== "bundled" && !(record.enabled && record.explicitlyEnabled === true)) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `plugin must be explicitly enabled to register trusted tool policy: ${id}`,
      });
      return;
    }
    const policies = registry.trustedToolPolicies;
    const existing = policies.find(
      (entry) => entry.pluginId === record.id && entry.policy.id === id,
    );
    if (existing) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `trusted tool policy already registered: ${id} (${existing.pluginId})`,
      });
      return;
    }
    const registration: PluginTrustedToolPolicyRegistryRegistration = {
      pluginId: record.id,
      pluginName: record.name,
      policy: { ...policy, id, description },
      origin: record.origin,
      source: record.source,
      rootDir: record.rootDir,
    };
    if (record.origin === "bundled") {
      const firstInstalledPolicyIndex = policies.findIndex((entry) => entry.origin !== "bundled");
      if (firstInstalledPolicyIndex === -1) {
        policies.push(registration);
      } else {
        policies.splice(firstInstalledPolicyIndex, 0, registration);
      }
      return;
    }
    policies.push(registration);
  };

  const registerAuthorizationPolicy = (
    record: PluginRecord,
    policy: AuthorizationPolicyRegistration,
  ) => {
    if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "authorization policy registration requires id, description, and handlers",
      });
      return;
    }
    const id = normalizePolicyString(policy.id);
    const description = normalizePolicyString(policy.description);
    const unhandled = policy.unhandled;
    const handlers = snapshotAuthorizationPolicyHandlers(policy.handlers);
    const handlersValid =
      handlers !== undefined && (Reflect.ownKeys(handlers).length > 0 || unhandled === "deny");
    const unhandledValid = unhandled === undefined || unhandled === "pass" || unhandled === "deny";
    const timeoutValid =
      policy.timeoutMs === undefined ||
      (typeof policy.timeoutMs === "number" &&
        Number.isFinite(policy.timeoutMs) &&
        policy.timeoutMs > 0);
    if (!id || !description || !handlersValid || !unhandledValid || !timeoutValid) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "authorization policy registration requires valid id, description, and handlers",
      });
      return;
    }
    if (
      record.origin !== "bundled" &&
      !(record.contracts?.authorizationPolicies ?? []).includes(id)
    ) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `plugin must declare contracts.authorizationPolicies for: ${id}`,
      });
      return;
    }
    if (record.origin !== "bundled" && !(record.enabled && record.explicitlyEnabled === true)) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `plugin must be explicitly enabled to register authorization policy: ${id}`,
      });
      return;
    }
    const duplicateAuthorization = registry.authorizationPolicies.find(
      (entry) => entry.pluginId === record.id && entry.policy.id === id,
    );
    if (duplicateAuthorization) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `authorization policy id already registered: ${id}`,
      });
      return;
    }
    const registration: PluginAuthorizationPolicyRegistryRegistration = {
      pluginId: record.id,
      pluginName: record.name,
      policy: {
        id,
        description,
        ...(policy.unhandled ? { unhandled: policy.unhandled } : {}),
        ...(policy.timeoutMs !== undefined ? { timeoutMs: policy.timeoutMs } : {}),
        handlers: handlers!,
      },
      origin: record.origin,
      source: record.source,
      rootDir: record.rootDir,
    };
    const policies = registry.authorizationPolicies;
    if (record.origin === "bundled") {
      const firstInstalledPolicyIndex = policies.findIndex((entry) => entry.origin !== "bundled");
      if (firstInstalledPolicyIndex === -1) {
        policies.push(registration);
      } else {
        policies.splice(firstInstalledPolicyIndex, 0, registration);
      }
    } else {
      policies.push(registration);
    }
  };

  return { registerTrustedToolPolicy, registerAuthorizationPolicy };
}
