/** Runs deny-only authorization policies over host-authoritative operations. */
import { performance } from "node:perf_hooks";
import { getRuntimeConfig, getRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  AuthorizationInvocationContext,
  AuthorizationOperation,
  AuthorizationOperationMap,
  AuthorizationPolicyDecision,
  AuthorizationPolicyRegistration,
} from "./authorization-policy.types.js";
import { normalizePluginId, normalizePluginsConfig } from "./config-state.js";
import { getGlobalHookRunnerRegistry } from "./hook-runner-global-state.js";
import { isPluginJsonValue, type PluginJsonValue } from "./host-hook-json.js";
import type {
  PluginAuthorizationPolicyRegistryRegistration,
  PluginRegistry,
} from "./registry-types.js";
import { getActivePluginRegistry } from "./runtime.js";

export const MIN_AUTHORIZATION_POLICY_TIMEOUT_MS = 1;
export const DEFAULT_AUTHORIZATION_POLICY_TIMEOUT_MS = 15_000;
export const MAX_AUTHORIZATION_POLICY_TIMEOUT_MS = 30_000;
export const AUTHORIZATION_POLICY_CHAIN_TIMEOUT_MS = 30_000;
export const AUTHORIZATION_POLICY_DENIED_MESSAGE = "Operation blocked by authorization policy.";

const CODE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

type AuthorizationPolicyRegistry =
  | { authorizationPolicies?: PluginRegistry["authorizationPolicies"] }
  | null
  | undefined;

export type AuthorizationPolicyDenial = {
  denied: true;
  kind: "deny" | "error" | "abort";
  pluginId: string;
  policyId: string;
  /** Stable machine-readable code. Policy-authored prose never crosses the host boundary. */
  code: string;
};

export type RequiredAuthorizationPolicy = {
  pluginId: string;
  policyId: string;
  operations: readonly AuthorizationOperation[];
};

function unreadableRegistration(): PluginAuthorizationPolicyRegistryRegistration {
  return {
    pluginId: "unknown-plugin",
    source: "runtime",
    get policy(): AuthorizationPolicyRegistration {
      throw new Error("authorization policy registration is unreadable");
    },
  };
}

function resolveDefaultRegistry(): AuthorizationPolicyRegistry {
  return getGlobalHookRunnerRegistry() ?? getActivePluginRegistry();
}

function copyRegistrations(
  registry: AuthorizationPolicyRegistry,
): PluginAuthorizationPolicyRegistryRegistration[] {
  let policies: unknown;
  try {
    policies = registry?.authorizationPolicies;
  } catch {
    return [unreadableRegistration()];
  }
  if (policies === undefined) {
    return [];
  }
  try {
    if (!Array.isArray(policies)) {
      return [unreadableRegistration()];
    }
    const copied: PluginAuthorizationPolicyRegistryRegistration[] = [];
    for (let index = 0; index < policies.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(policies, String(index));
      const entry = descriptor && "value" in descriptor ? descriptor.value : undefined;
      copied.push(
        descriptor?.enumerable && entry && typeof entry === "object"
          ? (entry as PluginAuthorizationPolicyRegistryRegistration)
          : unreadableRegistration(),
      );
    }
    return copied;
  } catch {
    return [unreadableRegistration()];
  }
}

export function resolveRequiredAuthorizationPolicies(
  config: OpenClawConfig | undefined,
): RequiredAuthorizationPolicy[] {
  const entries = normalizePluginsConfig(config?.plugins).entries;
  const required: RequiredAuthorizationPolicy[] = [];
  const seen = new Set<string>();
  for (const [pluginId, entry] of Object.entries(entries)) {
    for (const policy of entry.authorization?.requiredPolicies ?? []) {
      const policyId = policy.id.trim();
      const operations = [...new Set(policy.operations)];
      if (!policyId || operations.length === 0) {
        continue;
      }
      const key = `${pluginId}\u0000${policyId}\u0000${operations.join("\u0000")}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      required.push({ pluginId, policyId, operations });
    }
  }
  return required;
}

export function hasAuthorizationPolicies(
  registry: AuthorizationPolicyRegistry = resolveDefaultRegistry(),
  config?: OpenClawConfig,
  operation?: AuthorizationOperation,
): boolean {
  if (operation) {
    return hasAuthorizationPoliciesForOperation({ operation, config, registry });
  }
  const registrations = copyRegistrations(registry);
  if (registrations.length > 0) {
    return true;
  }
  const resolvedConfig = resolveConfig(config);
  return (
    !resolvedConfig.ok || resolveRequiredAuthorizationPolicies(resolvedConfig.config).length > 0
  );
}

/** Whether this operation has a live veto handler or fail-closed required-policy contract. */
export function hasAuthorizationPoliciesForOperation(params: {
  operation: AuthorizationOperation;
  config?: OpenClawConfig;
  registry?: AuthorizationPolicyRegistry;
}): boolean {
  const registrations = copyRegistrations(params.registry ?? resolveDefaultRegistry());
  const resolvedConfig = resolveConfig(params.config);
  if (!resolvedConfig.ok) {
    return true;
  }
  if (
    resolveRequiredAuthorizationPolicies(resolvedConfig.config).some((required) =>
      required.operations.includes(params.operation),
    )
  ) {
    return true;
  }
  for (const registration of registrations) {
    const policyResult = readPolicy(registration);
    if (!policyResult.ok) {
      return true;
    }
    try {
      if (typeof policyResult.policy.handlers?.[params.operation] === "function") {
        return true;
      }
      const unhandled = policyResult.policy.unhandled;
      if (unhandled !== undefined && unhandled !== "pass") {
        return true;
      }
    } catch {
      return true;
    }
  }
  return false;
}

function readPluginId(registration: PluginAuthorizationPolicyRegistryRegistration): string {
  try {
    const value = registration.pluginId;
    return typeof value === "string" && value.trim() ? normalizePluginId(value) : "unknown-plugin";
  } catch {
    return "unknown-plugin";
  }
}

function readPolicy(
  registration: PluginAuthorizationPolicyRegistryRegistration,
): { ok: true; policy: AuthorizationPolicyRegistration } | { ok: false } {
  try {
    const policy = registration.policy;
    return policy && typeof policy === "object" ? { ok: true, policy } : { ok: false };
  } catch {
    return { ok: false };
  }
}

function readPolicyId(registration: PluginAuthorizationPolicyRegistryRegistration): string {
  const policy = readPolicy(registration);
  if (!policy.ok) {
    return readPluginId(registration);
  }
  try {
    const value = policy.policy.id;
    return typeof value === "string" && value.trim() ? value.trim() : readPluginId(registration);
  } catch {
    return readPluginId(registration);
  }
}

function denied(
  registration: PluginAuthorizationPolicyRegistryRegistration,
  kind: AuthorizationPolicyDenial["kind"],
  code: string,
): AuthorizationPolicyDenial {
  return {
    denied: true,
    kind,
    pluginId: readPluginId(registration),
    policyId: readPolicyId(registration),
    code,
  };
}

function requiredDenied(
  required: RequiredAuthorizationPolicy,
  code: string,
): AuthorizationPolicyDenial {
  return {
    denied: true,
    kind: "error",
    pluginId: required.pluginId,
    policyId: required.policyId,
    code,
  };
}

function resolveTimeoutMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_AUTHORIZATION_POLICY_TIMEOUT_MS;
  }
  return Math.min(
    MAX_AUTHORIZATION_POLICY_TIMEOUT_MS,
    Math.max(MIN_AUTHORIZATION_POLICY_TIMEOUT_MS, Math.floor(value)),
  );
}

class AuthorizationPolicyTimeoutError extends Error {
  constructor(readonly scope: "policy" | "chain") {
    super("authorization policy timed out");
  }
}
class AuthorizationPolicyAbortError extends Error {}

async function evaluateWithTimeout<T>(params: {
  run: (signal: AbortSignal) => T | Promise<T>;
  timeoutMs: number;
  timeoutScope: "policy" | "chain";
  signal?: AbortSignal;
}): Promise<T> {
  const controller = new AbortController();
  const startedAt = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeParentAbort: (() => void) | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    // Keep this timer referenced. A one-shot host must stay alive long enough to
    // fail closed when a policy never settles.
    timer = setTimeout(() => {
      const error = new AuthorizationPolicyTimeoutError(params.timeoutScope);
      controller.abort(error);
      reject(error);
    }, params.timeoutMs);
  });
  const aborted = new Promise<never>((_resolve, reject) => {
    const rejectAborted = () => {
      const error = new AuthorizationPolicyAbortError();
      controller.abort(params.signal?.reason ?? error);
      reject(error);
    };
    if (params.signal?.aborted) {
      rejectAborted();
      return;
    }
    params.signal?.addEventListener("abort", rejectAborted, { once: true });
    removeParentAbort = () => params.signal?.removeEventListener("abort", rejectAborted);
  });
  const evaluation = Promise.resolve()
    .then(() => {
      if (controller.signal.aborted) {
        throw new AuthorizationPolicyAbortError();
      }
      return params.run(controller.signal);
    })
    .then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
  try {
    const outcome = await Promise.race([evaluation, timeout, aborted]);
    if (performance.now() - startedAt >= params.timeoutMs) {
      const error = new AuthorizationPolicyTimeoutError(params.timeoutScope);
      controller.abort(error);
      throw error;
    }
    if (!outcome.ok) {
      throw outcome.error;
    }
    return outcome.value;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    removeParentAbort?.();
  }
}

function deepFreezeJson(value: PluginJsonValue): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return;
  }
  for (const entry of Array.isArray(value) ? value : Object.values(value)) {
    deepFreezeJson(entry);
  }
  Object.freeze(value);
}

function hasCanonicalJsonDescriptors(
  value: unknown,
  state: { ancestors: WeakSet<object>; depth: number; nodes: number } = {
    ancestors: new WeakSet(),
    depth: 0,
    nodes: 0,
  },
): boolean {
  state.nodes += 1;
  if (state.nodes > 4096 || state.depth > 32) {
    return false;
  }
  if (value === null || typeof value !== "object") {
    return true;
  }
  if (state.ancestors.has(value)) {
    return false;
  }
  state.ancestors.add(value);
  state.depth += 1;
  const finish = (result: boolean) => {
    state.depth -= 1;
    state.ancestors.delete(value);
    return result;
  };
  if (Array.isArray(value)) {
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== "string")) {
      return finish(false);
    }
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        return finish(false);
      }
      if (!hasCanonicalJsonDescriptors(descriptor.value, state)) {
        return finish(false);
      }
    }
    return finish(
      ownKeys.every(
        (key) =>
          key === "length" ||
          (typeof key === "string" && /^(?:0|[1-9]\d*)$/u.test(key) && Number(key) < value.length),
      ),
    );
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return finish(false);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      return finish(false);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      return finish(false);
    }
    if (!hasCanonicalJsonDescriptors(descriptor.value, state)) {
      return finish(false);
    }
  }
  return finish(true);
}

function cloneJson<T>(value: T): T | undefined {
  try {
    if (!hasCanonicalJsonDescriptors(value) || !isPluginJsonValue(value)) {
      return undefined;
    }
    const cloned = structuredClone(value) as T & PluginJsonValue;
    return isPluginJsonValue(cloned) ? (cloned as T) : undefined;
  } catch {
    return undefined;
  }
}

function cloneCanonicalRequest<K extends AuthorizationOperation>(
  request: AuthorizationOperationMap[K],
): AuthorizationOperationMap[K] | undefined {
  const cloned = cloneJson(request);
  if (!cloned) {
    return undefined;
  }
  let canonical: AuthorizationOperationMap[K] = cloned;
  if (cloned.operation === "tool.call") {
    if (cloned.input === null || typeof cloned.input !== "object" || Array.isArray(cloned.input)) {
      return undefined;
    }
    const inputAction = cloned.input.action;
    const action =
      typeof inputAction === "string" && inputAction.trim() ? inputAction.trim() : undefined;
    const { action: _ignored, ...withoutAction } = cloned;
    canonical = {
      ...withoutAction,
      ...(action ? { action } : {}),
    } as AuthorizationOperationMap[K];
  }
  deepFreezeJson(canonical as PluginJsonValue);
  return canonical;
}

function readDecision(value: unknown): AuthorizationPolicyDecision | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return undefined;
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) {
      return undefined;
    }
    const effectDescriptor = Object.getOwnPropertyDescriptor(value, "effect");
    if (!effectDescriptor || !("value" in effectDescriptor) || !effectDescriptor.enumerable) {
      return undefined;
    }
    const effect = effectDescriptor.value;
    if (effect === "pass") {
      return keys.length === 1 && keys[0] === "effect" ? { effect: "pass" } : undefined;
    }
    const codeDescriptor = Object.getOwnPropertyDescriptor(value, "code");
    if (
      effect !== "deny" ||
      !codeDescriptor ||
      !("value" in codeDescriptor) ||
      !codeDescriptor.enumerable ||
      typeof codeDescriptor.value !== "string" ||
      !CODE_PATTERN.test(codeDescriptor.value) ||
      keys.length !== 2 ||
      !keys.includes("effect") ||
      !keys.includes("code")
    ) {
      return undefined;
    }
    return { effect: "deny", code: codeDescriptor.value };
  } catch {
    return undefined;
  }
}

function resolveConfig(
  explicit: OpenClawConfig | undefined,
): { ok: true; config: OpenClawConfig | undefined } | { ok: false } {
  if (explicit !== undefined) {
    return { ok: true, config: explicit };
  }
  const snapshot = getRuntimeConfigSnapshot();
  if (snapshot) {
    return { ok: true, config: snapshot };
  }
  try {
    return { ok: true, config: getRuntimeConfig({ skipPluginValidation: true }) };
  } catch {
    return { ok: false };
  }
}

function findRegistration(
  registrations: readonly PluginAuthorizationPolicyRegistryRegistration[],
  required: RequiredAuthorizationPolicy,
): PluginAuthorizationPolicyRegistryRegistration | undefined {
  return registrations.find(
    (registration) =>
      readPluginId(registration) === required.pluginId &&
      readPolicyId(registration) === required.policyId,
  );
}

function findRequiredFailure(
  registrations: readonly PluginAuthorizationPolicyRegistryRegistration[],
  config: OpenClawConfig | undefined,
  operation: AuthorizationOperation,
): AuthorizationPolicyDenial | undefined {
  for (const required of resolveRequiredAuthorizationPolicies(config)) {
    if (!required.operations.includes(operation)) {
      continue;
    }
    const registration = findRegistration(registrations, required);
    if (!registration) {
      return requiredDenied(required, "required-policy-missing");
    }
    const policy = readPolicy(registration);
    if (!policy.ok) {
      return requiredDenied(required, "required-policy-unreadable");
    }
    let handler: unknown;
    try {
      handler = policy.policy.handlers?.[operation];
    } catch {
      return requiredDenied(required, "required-policy-unreadable");
    }
    if (typeof handler !== "function") {
      return requiredDenied(required, "required-policy-handler-missing");
    }
  }
  return undefined;
}

/**
 * Runs every live authorization policy in deterministic registry order.
 * Policies can only add a veto; they never override core admission, allowlists, or approvals.
 */
export async function runAuthorizationPolicies(params: {
  request: AuthorizationOperationMap[AuthorizationOperation];
  context: AuthorizationInvocationContext;
  config?: OpenClawConfig;
  registry?: AuthorizationPolicyRegistry;
  signal?: AbortSignal;
}): Promise<AuthorizationPolicyDenial | undefined> {
  const registrations = copyRegistrations(params.registry ?? resolveDefaultRegistry());
  const resolvedConfig = resolveConfig(params.config);
  if (!resolvedConfig.ok) {
    return {
      denied: true,
      kind: "error",
      pluginId: "authorization-engine",
      policyId: "runtime-config",
      code: "policy-config-unavailable",
    };
  }
  const requiredFailure = findRequiredFailure(
    registrations,
    resolvedConfig.config,
    params.request.operation,
  );
  if (requiredFailure) {
    return requiredFailure;
  }
  if (registrations.length === 0) {
    return undefined;
  }
  const firstRegistration = registrations[0] ?? unreadableRegistration();
  if (params.signal?.aborted) {
    return denied(firstRegistration, "abort", "policy-evaluation-aborted");
  }

  const canonicalRequest = cloneCanonicalRequest(params.request);
  const canonicalContext = cloneJson(params.context);
  if (!canonicalRequest || !canonicalContext) {
    return denied(firstRegistration, "error", "policy-input-invalid");
  }
  deepFreezeJson(canonicalContext as PluginJsonValue);

  const chainDeadline = performance.now() + AUTHORIZATION_POLICY_CHAIN_TIMEOUT_MS;
  for (const registration of registrations) {
    const policyResult = readPolicy(registration);
    if (!policyResult.ok) {
      return denied(registration, "error", "policy-unreadable");
    }
    const policy = policyResult.policy;
    let handler: unknown;
    let unhandled: unknown;
    let timeoutMs: unknown;
    try {
      handler = policy.handlers?.[canonicalRequest.operation] as unknown;
      unhandled = policy.unhandled;
      timeoutMs = policy.timeoutMs;
    } catch {
      return denied(registration, "error", "policy-unreadable");
    }
    if (typeof handler !== "function") {
      if (unhandled === "deny") {
        return denied(registration, "deny", "policy-unhandled-operation");
      }
      if (unhandled === undefined || unhandled === "pass") {
        continue;
      }
      return denied(registration, "error", "policy-registration-invalid");
    }

    const remainingMs = chainDeadline - performance.now();
    if (remainingMs <= 0) {
      return denied(registration, "error", "policy-chain-timed-out");
    }
    const policyTimeoutMs = resolveTimeoutMs(timeoutMs);
    const effectiveTimeoutMs = Math.min(policyTimeoutMs, remainingMs);
    const timeoutScope = remainingMs <= policyTimeoutMs ? "chain" : "policy";
    let decision: AuthorizationPolicyDecision | undefined;
    try {
      decision = await evaluateWithTimeout({
        run: async (signal) =>
          readDecision(
            await Reflect.apply(handler, policy, [canonicalRequest, canonicalContext, signal]),
          ),
        timeoutMs: effectiveTimeoutMs,
        timeoutScope,
        signal: params.signal,
      });
    } catch (error) {
      return denied(
        registration,
        error instanceof AuthorizationPolicyAbortError ? "abort" : "error",
        error instanceof AuthorizationPolicyTimeoutError
          ? error.scope === "chain"
            ? "policy-chain-timed-out"
            : "policy-evaluation-timed-out"
          : error instanceof AuthorizationPolicyAbortError
            ? "policy-evaluation-aborted"
            : "policy-evaluation-failed",
      );
    }
    if (params.signal?.aborted) {
      return denied(registration, "abort", "policy-evaluation-aborted");
    }
    if (performance.now() >= chainDeadline) {
      return denied(registration, "error", "policy-chain-timed-out");
    }
    if (!decision) {
      return denied(registration, "error", "policy-decision-invalid");
    }
    if (decision.effect === "deny") {
      return denied(registration, "deny", decision.code);
    }
  }
  return performance.now() >= chainDeadline
    ? denied(registrations.at(-1) ?? firstRegistration, "error", "policy-chain-timed-out")
    : undefined;
}
