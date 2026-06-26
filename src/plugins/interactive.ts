// Resolves interactive plugin entries from registry metadata.
import {
  resolvePluginInteractiveNamespaceMatch,
  restorePluginInteractiveHandlers,
} from "./interactive-registry.js";
import {
  claimPluginInteractiveCallbackDedupe,
  commitPluginInteractiveCallbackDedupe,
  releasePluginInteractiveCallbackDedupe,
  type RegisteredInteractiveHandler,
} from "./interactive-state.js";
import { collectLivePluginRegistries } from "./runtime.js";

type InteractiveDispatchResult<TResult = unknown> =
  | { matched: false; handled: false; duplicate: false }
  | { matched: true; handled: boolean; duplicate: boolean; result?: TResult };

type PluginInteractiveDispatchRegistration = {
  channel: string;
  namespace: string;
};

/** Resolved interactive handler match passed to plugin callback dispatch. */
export type PluginInteractiveMatch<TRegistration extends PluginInteractiveDispatchRegistration> = {
  registration: RegisteredInteractiveHandler & TRegistration;
  namespace: string;
  payload: string;
};

export {
  clearPluginInteractiveHandlers,
  clearPluginInteractiveHandlersForPlugin,
  registerPluginInteractiveHandler,
} from "./interactive-registry.js";
export type { InteractiveRegistrationResult } from "./interactive-registry.js";

function resolveLivePluginInteractiveNamespaceMatch(channel: string, data: string) {
  const existing = resolvePluginInteractiveNamespaceMatch(channel, data);
  if (existing) {
    return existing;
  }

  const registrationsByKey = new Map<string, RegisteredInteractiveHandler>();
  for (const registry of collectLivePluginRegistries()) {
    for (const registration of registry.interactiveHandlers ?? []) {
      const key = `${registration.channel.toLowerCase()}:${registration.namespace}`;
      if (!registrationsByKey.has(key)) {
        registrationsByKey.set(key, registration);
      }
    }
  }
  const registrations = [...registrationsByKey.values()];
  if (registrations.length === 0) {
    return null;
  }

  restorePluginInteractiveHandlers(registrations);
  return resolvePluginInteractiveNamespaceMatch(channel, data);
}

/** Dispatches one interactive callback payload to a matching plugin handler. */
export async function dispatchPluginInteractiveHandler<
  TRegistration extends PluginInteractiveDispatchRegistration,
  TResult extends { handled?: boolean } | void = { handled?: boolean } | void,
>(params: {
  channel: TRegistration["channel"];
  data: string;
  dedupeId?: string;
  onMatched?: () => Promise<void> | void;
  invoke: (match: PluginInteractiveMatch<TRegistration>) => Promise<TResult> | TResult;
}): Promise<InteractiveDispatchResult<TResult>> {
  const match = resolveLivePluginInteractiveNamespaceMatch(params.channel, params.data);
  if (!match) {
    return { matched: false, handled: false, duplicate: false };
  }

  const dedupeKey = params.dedupeId?.trim();
  if (dedupeKey && !claimPluginInteractiveCallbackDedupe(dedupeKey)) {
    return { matched: true, handled: true, duplicate: true };
  }

  try {
    await params.onMatched?.();
    const resolved = await params.invoke(match as PluginInteractiveMatch<TRegistration>);
    if (dedupeKey) {
      commitPluginInteractiveCallbackDedupe(dedupeKey);
    }
    const shouldExposeResult =
      Boolean(resolved) &&
      typeof resolved === "object" &&
      Object.keys(resolved as Record<string, unknown>).some((key) => key !== "handled");

    return {
      matched: true,
      handled: resolved?.handled ?? true,
      duplicate: false,
      ...(shouldExposeResult ? { result: resolved } : {}),
    };
  } catch (error) {
    if (dedupeKey) {
      releasePluginInteractiveCallbackDedupe(dedupeKey);
    }
    throw error;
  }
}
