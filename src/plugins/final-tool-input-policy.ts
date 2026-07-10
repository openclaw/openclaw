// Final tool-input policy runner.
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginHookBeforeToolCallEvent, PluginHookToolContext } from "./hook-types.js";
import { getPluginSessionExtensionStateSync } from "./host-hook-state.js";
import { hasPluginJsonContainerShape, isPluginJsonValue } from "./host-hook-json.js";
import type { PluginFinalToolInputPolicyRegistration, PluginJsonValue } from "./host-hooks.js";
import type {
  PluginFinalToolInputPolicyRegistryRegistration,
  PluginRegistry,
} from "./registry-types.js";
import { getActivatedFinalToolInputPolicies } from "./registry-lifecycle.js";
import { getActivePluginRegistry } from "./runtime.js";
import {
  DEFAULT_FINAL_TOOL_INPUT_POLICY_TIMEOUT_MS,
  MAX_FINAL_TOOL_INPUT_POLICY_TIMEOUT_MS,
  MIN_FINAL_TOOL_INPUT_POLICY_TIMEOUT_MS,
} from "./final-tool-input-policy-constants.js";

const FINAL_TOOL_INPUT_POLICY_BLOCK_REASON = "Tool call blocked by final input policy";
const FINAL_TOOL_INPUT_POLICY_REASON_CODE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

type FinalToolInputPolicyRegistryRegistration =
  PluginFinalToolInputPolicyRegistryRegistration;

type FinalToolInputPolicyRegistry =
  | { finalToolInputPolicies?: PluginRegistry["finalToolInputPolicies"] }
  | null
  | undefined;

export type FinalToolInputPolicyBlock = {
  block: true;
  blockReason: typeof FINAL_TOOL_INPUT_POLICY_BLOCK_REASON;
  kind: "deny" | "error" | "abort";
  pluginId: string;
  policyId: string;
  reasonCode: string;
};

/** True when the supplied or active plugin registry has final tool-input policies. */
export function hasFinalToolInputPolicies(
  registry: FinalToolInputPolicyRegistry = getActivePluginRegistry(),
): boolean {
  return copyPolicyRegistrations(registry).length > 0;
}

function unreadableRegistration(): FinalToolInputPolicyRegistryRegistration {
  return {
    pluginId: "unknown-plugin",
    source: "runtime",
    get policy(): PluginFinalToolInputPolicyRegistration {
      throw new Error("final tool input policy registration is unreadable");
    },
  };
}

function copyPolicyRegistrations(
  registry: FinalToolInputPolicyRegistry,
): FinalToolInputPolicyRegistryRegistration[] {
  let policies: unknown;
  try {
    policies = registry
      ? (getActivatedFinalToolInputPolicies(registry) ?? registry.finalToolInputPolicies)
      : undefined;
  } catch {
    return [unreadableRegistration()];
  }
  if (!policies) {
    return [];
  }
  try {
    return Array.isArray(policies) ? policies.map((policy) => policy) : [unreadableRegistration()];
  } catch {
    return [unreadableRegistration()];
  }
}

function readPolicyOwnerPluginId(
  registration: FinalToolInputPolicyRegistryRegistration,
): string | undefined {
  try {
    const pluginId = registration.pluginId;
    const normalized = typeof pluginId === "string" ? pluginId.trim() : "";
    return normalized || undefined;
  } catch {
    return undefined;
  }
}

function readPolicy(registration: FinalToolInputPolicyRegistryRegistration):
  | {
      ok: true;
      policy: PluginFinalToolInputPolicyRegistration;
      evaluate: PluginFinalToolInputPolicyRegistration["evaluate"];
      timeoutMs: number | undefined;
    }
  | { ok: false } {
  try {
    const policy = registration.policy;
    if (!policy) {
      return { ok: false };
    }
    const evaluate = policy.evaluate;
    const timeoutMs = policy.timeoutMs;
    return typeof evaluate === "function"
      ? { ok: true, policy, evaluate, timeoutMs }
      : { ok: false };
  } catch {
    return { ok: false };
  }
}

function readPolicyId(registration: FinalToolInputPolicyRegistryRegistration): string {
  const fallback = readPolicyOwnerPluginId(registration) ?? "unknown-policy";
  const policy = readPolicy(registration);
  if (!policy.ok) {
    return fallback;
  }
  try {
    const id = policy.policy.id;
    const normalized = typeof id === "string" ? id.trim() : "";
    return normalized || fallback;
  } catch {
    return fallback;
  }
}

function blocked(
  registration: FinalToolInputPolicyRegistryRegistration,
  kind: FinalToolInputPolicyBlock["kind"],
  reasonCode: string,
): FinalToolInputPolicyBlock {
  return {
    block: true,
    blockReason: FINAL_TOOL_INPUT_POLICY_BLOCK_REASON,
    kind,
    pluginId: readPolicyOwnerPluginId(registration) ?? "unknown-plugin",
    policyId: readPolicyId(registration),
    reasonCode,
  };
}

function resolveTimeoutMs(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_FINAL_TOOL_INPUT_POLICY_TIMEOUT_MS;
  }
  return Math.min(
    MAX_FINAL_TOOL_INPUT_POLICY_TIMEOUT_MS,
    Math.max(MIN_FINAL_TOOL_INPUT_POLICY_TIMEOUT_MS, Math.floor(value)),
  );
}

class FinalToolInputPolicyTimeoutError extends Error {}
class FinalToolInputPolicyAbortError extends Error {}

async function evaluateWithTimeout<T>(params: {
  run: (signal: AbortSignal) => Promise<T> | T;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new FinalToolInputPolicyTimeoutError();
      reject(error);
      controller.abort(error);
    }, params.timeoutMs);
    timer.unref?.();
  });
  let removeParentAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    const rejectAborted = () => {
      reject(new FinalToolInputPolicyAbortError());
      controller.abort(params.signal?.reason);
    };
    if (params.signal?.aborted) {
      rejectAborted();
      return;
    }
    params.signal?.addEventListener("abort", rejectAborted, { once: true });
    removeParentAbort = () => params.signal?.removeEventListener("abort", rejectAborted);
  });
  const evaluation = Promise.resolve().then(() => {
    if (controller.signal.aborted) {
      throw new FinalToolInputPolicyAbortError();
    }
    return params.run(controller.signal);
  });
  try {
    return await Promise.race([evaluation, timeout, aborted]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    removeParentAbort?.();
  }
}

function clonePolicyEvent(
  event: PluginHookBeforeToolCallEvent,
): PluginHookBeforeToolCallEvent | undefined {
  try {
    const toolName = event.toolName;
    const params = event.params;
    const toolKind = event.toolKind;
    const toolInputKind = event.toolInputKind;
    const runId = event.runId;
    const toolCallId = event.toolCallId;
    const derivedPaths = event.derivedPaths;
    if (!hasPluginJsonContainerShape(params)) {
      return undefined;
    }
    return Object.freeze({
      toolName,
      params: structuredClone(params),
      ...(toolKind ? { toolKind } : {}),
      ...(toolInputKind ? { toolInputKind } : {}),
      ...(runId ? { runId } : {}),
      ...(toolCallId ? { toolCallId } : {}),
      ...(derivedPaths ? { derivedPaths: Object.freeze([...derivedPaths]) } : {}),
    });
  } catch {
    return undefined;
  }
}

function deepFreezePolicyJsonValue(value: PluginJsonValue): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return;
  }
  for (const entry of Array.isArray(value) ? value : Object.values(value)) {
    deepFreezePolicyJsonValue(entry);
  }
  Object.freeze(value);
}

function sealOriginalPolicyInput(
  original: Record<string, unknown>,
  canonical: Record<string, PluginJsonValue>,
): boolean {
  try {
    const canonicalKeys = Object.keys(canonical);
    const originalKeys = Object.keys(original);
    const originalPrototype = Object.getPrototypeOf(original);
    if (
      (originalPrototype !== Object.prototype && originalPrototype !== null) ||
      canonicalKeys.length !== originalKeys.length ||
      originalKeys.some((key) => !Object.hasOwn(canonical, key))
    ) {
      return false;
    }
    deepFreezePolicyJsonValue(canonical);
    const descriptors = Object.create(null) as PropertyDescriptorMap;
    for (const key of canonicalKeys) {
      descriptors[key] = {
        configurable: false,
        enumerable: true,
        value: canonical[key],
        writable: false,
      };
    }
    Object.defineProperties(original, descriptors);
    Object.freeze(original);
    return Object.isFrozen(original);
  } catch {
    return false;
  }
}

function readDecision(
  value: unknown,
): { outcome: "pass" } | { outcome: "deny"; reasonCode: string } | { outcome: "invalid" } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { outcome: "invalid" };
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return { outcome: "invalid" };
    }
    const keys = Reflect.ownKeys(value);
    const outcome = (value as { outcome?: unknown }).outcome;
    if (outcome === "pass") {
      return {
        outcome: keys.length === 1 && keys[0] === "outcome" ? "pass" : "invalid",
      };
    }
    if (outcome !== "deny") {
      return { outcome: "invalid" };
    }
    const reasonCode = (value as { reasonCode?: unknown }).reasonCode;
    return keys.length === 2 &&
      keys.includes("outcome") &&
      keys.includes("reasonCode") &&
      typeof reasonCode === "string" &&
      FINAL_TOOL_INPUT_POLICY_REASON_CODE_PATTERN.test(reasonCode)
      ? { outcome: "deny", reasonCode }
      : { outcome: "invalid" };
  } catch {
    return { outcome: "invalid" };
  }
}

/**
 * Runs final tool-input policies in registry order.
 * Policies receive detached input snapshots and can only add a final veto.
 */
export async function runFinalToolInputPolicies(
  event: PluginHookBeforeToolCallEvent,
  ctx: PluginHookToolContext,
  options?: {
    config?: OpenClawConfig;
    registry?: FinalToolInputPolicyRegistry;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<FinalToolInputPolicyBlock | undefined> {
  const policies = copyPolicyRegistrations(options?.registry ?? getActivePluginRegistry());
  if (policies.length === 0) {
    return undefined;
  }
  if (options?.signal?.aborted) {
    return blocked(policies[0], "abort", "policy-evaluation-aborted");
  }
  const canonicalEvent = clonePolicyEvent(event);
  if (!canonicalEvent) {
    return blocked(policies[0], "error", "policy-input-invalid");
  }
  try {
    if (!isPluginJsonValue(canonicalEvent.params)) {
      return blocked(policies[0], "error", "policy-input-invalid");
    }
  } catch {
    return blocked(policies[0], "error", "policy-input-invalid");
  }
  if (options?.signal?.aborted) {
    return blocked(policies[0], "abort", "policy-evaluation-aborted");
  }
  if (
    !sealOriginalPolicyInput(
      event.params,
      canonicalEvent.params as Record<string, PluginJsonValue>,
    )
  ) {
    return blocked(policies[0], "error", "policy-input-seal-failed");
  }
  const sessionExtensionStateCache = new Map<string, Record<string, PluginJsonValue> | undefined>();
  let resolvedSessionConfig: OpenClawConfig | undefined = options?.config;
  let didResolveSessionConfig = Boolean(options?.config);
  const resolveSessionConfig = (): OpenClawConfig | undefined => {
    if (!didResolveSessionConfig) {
      didResolveSessionConfig = true;
      try {
        resolvedSessionConfig = getRuntimeConfig();
      } catch {
        resolvedSessionConfig = undefined;
      }
    }
    return resolvedSessionConfig;
  };
  const ctxWithoutSessionExtension = { ...ctx };
  delete ctxWithoutSessionExtension.getSessionExtension;

  for (const registration of policies) {
    const pluginId = readPolicyOwnerPluginId(registration);
    if (!pluginId) {
      return blocked(registration, "error", "policy-owner-unreadable");
    }
    const policy = readPolicy(registration);
    if (!policy.ok) {
      return blocked(registration, "error", "policy-unreadable");
    }
    const policyEvent = clonePolicyEvent(canonicalEvent);
    if (!policyEvent) {
      return blocked(registration, "error", "policy-evaluation-failed");
    }
    const policyContext: PluginHookToolContext = Object.freeze({
      ...ctxWithoutSessionExtension,
      // Each policy can read only its own namespaced extension state.
      // oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Plugin callers type JSON reads by namespace.
      getSessionExtension: <T extends PluginJsonValue = PluginJsonValue>(namespace: string) => {
        const normalizedNamespace = namespace.trim();
        if (!sessionExtensionStateCache.has(pluginId)) {
          const config = ctx.sessionKey ? resolveSessionConfig() : undefined;
          sessionExtensionStateCache.set(
            pluginId,
            config
              ? getPluginSessionExtensionStateSync({
                  cfg: config,
                  pluginId,
                  sessionKey: ctx.sessionKey,
                })
              : undefined,
          );
        }
        const pluginState = sessionExtensionStateCache.get(pluginId);
        if (!normalizedNamespace || !pluginState) {
          return undefined;
        }
        return pluginState[normalizedNamespace] as T | undefined;
      },
    });

    let decision: Awaited<ReturnType<PluginFinalToolInputPolicyRegistration["evaluate"]>>;
    try {
      decision = await evaluateWithTimeout({
        run: (signal) => policy.evaluate.call(policy.policy, policyEvent, policyContext, signal),
        timeoutMs: resolveTimeoutMs(policy.timeoutMs ?? options?.timeoutMs),
        signal: options?.signal,
      });
    } catch (error) {
      return blocked(
        registration,
        error instanceof FinalToolInputPolicyAbortError ? "abort" : "error",
        error instanceof FinalToolInputPolicyTimeoutError
          ? "policy-evaluation-timed-out"
          : error instanceof FinalToolInputPolicyAbortError
            ? "policy-evaluation-aborted"
            : "policy-evaluation-failed",
      );
    }
    if (options?.signal?.aborted) {
      return blocked(registration, "abort", "policy-evaluation-aborted");
    }
    const outcome = readDecision(decision);
    if (options?.signal?.aborted) {
      return blocked(registration, "abort", "policy-evaluation-aborted");
    }
    if (outcome.outcome === "pass") {
      continue;
    }
    if (outcome.outcome === "deny") {
      return blocked(registration, "deny", outcome.reasonCode);
    }
    return blocked(registration, "error", "policy-decision-invalid");
  }
  if (options?.signal?.aborted) {
    return blocked(policies.at(-1) ?? policies[0], "abort", "policy-evaluation-aborted");
  }
  return undefined;
}
