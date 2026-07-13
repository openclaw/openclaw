import { AsyncLocalStorage } from "node:async_hooks";
import type { GatewayAuthorizationSubject } from "../gateway/authorization/contracts.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { OpenClawPluginToolContext } from "./tool-types.js";

export type PluginToolAuthorizationInvocation = Readonly<{
  pluginId: string;
  toolName: string;
  toolCallId: string;
  context: OpenClawPluginToolContext;
  subject?: GatewayAuthorizationSubject;
}>;

const PLUGIN_TOOL_AUTHORIZATION_INVOCATION_KEY: unique symbol = Symbol.for(
  "openclaw.pluginToolAuthorizationInvocation",
);
const pluginToolAuthorizationInvocation = resolveGlobalSingleton<
  AsyncLocalStorage<PluginToolAuthorizationInvocation | undefined>
>(PLUGIN_TOOL_AUTHORIZATION_INVOCATION_KEY, () => new AsyncLocalStorage());

const contextSubjects = new WeakMap<OpenClawPluginToolContext, GatewayAuthorizationSubject>();
const invocationLifetimes = new WeakMap<PluginToolAuthorizationInvocation, { active: boolean }>();

function requiredIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} must be non-empty`);
  }
  return normalized;
}

function canonicalSubject(subject: GatewayAuthorizationSubject): GatewayAuthorizationSubject {
  const principal = subject.principal;
  const domain = subject.domain;
  const delegation = subject.delegation;
  const agentSession = subject.agentSession;
  const kind = principal.kind;
  if (kind !== "service" || !delegation || !agentSession) {
    throw new Error(
      "plugin tool authorization requires a delegated service principal with an agent-session proof",
    );
  }
  if (agentSession.invokingPrincipal.kind !== "human") {
    throw new Error("plugin tool authorization requires a human invoking principal");
  }
  return Object.freeze({
    principal: Object.freeze({
      issuer: requiredIdentifier(principal.issuer, "authorization principal issuer"),
      subject: requiredIdentifier(principal.subject, "authorization principal subject"),
      kind,
    }),
    domain: Object.freeze({
      id: requiredIdentifier(domain.id, "authorization domain id"),
    }),
    delegation: Object.freeze({
      id: requiredIdentifier(delegation.id, "authorization delegation id"),
      assignmentId: requiredIdentifier(delegation.assignmentId, "authorization assignment id"),
    }),
    agentSession: Object.freeze({
      id: requiredIdentifier(agentSession.id, "authorization agent session binding id"),
      invokingPrincipal: Object.freeze({
        issuer: requiredIdentifier(
          agentSession.invokingPrincipal.issuer,
          "authorization invoking principal issuer",
        ),
        subject: requiredIdentifier(
          agentSession.invokingPrincipal.subject,
          "authorization invoking principal subject",
        ),
        kind: agentSession.invokingPrincipal.kind,
      }),
    }),
  });
}

function sameSubject(
  first: GatewayAuthorizationSubject,
  second: GatewayAuthorizationSubject,
): boolean {
  return (
    first.principal.issuer === second.principal.issuer &&
    first.principal.subject === second.principal.subject &&
    first.principal.kind === second.principal.kind &&
    first.domain.id === second.domain.id &&
    first.delegation?.id === second.delegation?.id &&
    first.delegation?.assignmentId === second.delegation?.assignmentId &&
    first.agentSession?.id === second.agentSession?.id &&
    first.agentSession?.invokingPrincipal.issuer ===
      second.agentSession?.invokingPrincipal.issuer &&
    first.agentSession?.invokingPrincipal.subject ===
      second.agentSession?.invokingPrincipal.subject &&
    first.agentSession?.invokingPrincipal.kind === second.agentSession?.invokingPrincipal.kind
  );
}

/** Core-only binding from a trusted run subject to the exact plugin factory context object. */
export function bindPluginToolAuthorizationSubject(
  context: OpenClawPluginToolContext,
  subject: GatewayAuthorizationSubject | undefined,
): void {
  if (!subject) {
    return;
  }
  const canonical = canonicalSubject(subject);
  const existing = contextSubjects.get(context);
  if (existing && !sameSubject(existing, canonical)) {
    throw new Error("plugin tool authorization subject is already bound differently");
  }
  contextSubjects.set(context, existing ?? canonical);
}

/** True only when core bound a delegated Teams subject to this exact factory context. */
export function hasPluginToolAuthorizationSubject(context: OpenClawPluginToolContext): boolean {
  return contextSubjects.has(context);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as PromiseLike<unknown>).then === "function"
  );
}

/** Installs authority only around one owning plugin tool execute callback. */
export function withPluginToolAuthorizationInvocation<T>(
  input: {
    pluginId: string;
    toolName: string;
    toolCallId: string;
    context: OpenClawPluginToolContext;
    signal?: AbortSignal;
  },
  run: () => T,
): T {
  if (input.signal?.aborted) {
    throw new Error("plugin tool authorization invocation was aborted before execution");
  }
  const subject = contextSubjects.get(input.context);
  const invocation: PluginToolAuthorizationInvocation = Object.freeze({
    pluginId: requiredIdentifier(input.pluginId, "plugin id"),
    toolName: requiredIdentifier(input.toolName, "plugin tool name"),
    toolCallId: requiredIdentifier(input.toolCallId, "plugin tool call id"),
    context: input.context,
    ...(subject ? { subject } : {}),
  });
  const lifetime = { active: true };
  const deactivate = () => {
    lifetime.active = false;
  };
  input.signal?.addEventListener("abort", deactivate, { once: true });
  invocationLifetimes.set(invocation, lifetime);
  return pluginToolAuthorizationInvocation.run(invocation, () => {
    try {
      const result = run();
      if (isPromiseLike(result)) {
        return (async () => {
          try {
            return await result;
          } finally {
            deactivate();
            input.signal?.removeEventListener("abort", deactivate);
          }
        })() as T;
      }
      deactivate();
      input.signal?.removeEventListener("abort", deactivate);
      return result;
    } catch (error) {
      deactivate();
      input.signal?.removeEventListener("abort", deactivate);
      throw error;
    }
  });
}

/** Resolves only the current owning invocation and exact factory context object. */
export function requirePluginToolAuthorizationInvocation(input: {
  pluginId: string;
  context: OpenClawPluginToolContext;
}): PluginToolAuthorizationInvocation {
  const invocation = pluginToolAuthorizationInvocation.getStore();
  if (
    !invocation ||
    invocation.pluginId !== input.pluginId ||
    invocation.context !== input.context ||
    invocationLifetimes.get(invocation)?.active !== true ||
    !invocation.subject
  ) {
    throw new Error("an active host-authorized plugin tool invocation is required");
  }
  return invocation;
}

/** Revalidates an invocation after asynchronous authorization or lazy imports. */
export function requireCurrentPluginToolAuthorizationInvocation(
  expected: PluginToolAuthorizationInvocation,
): void {
  if (
    pluginToolAuthorizationInvocation.getStore() !== expected ||
    invocationLifetimes.get(expected)?.active !== true
  ) {
    throw new Error("the plugin tool authorization invocation is no longer active");
  }
}
