// Resolves interactive plugin entries from registry metadata.
import {
  clearPluginInteractiveRuntimeState,
  clearPluginInteractiveRuntimeStateForPlugin,
  resolvePluginInteractiveNamespaceMatch,
  resolvePluginInteractiveRegistrationsMatch,
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

export { registerPluginInteractiveHandler } from "./interactive-registry.js";
export type { InteractiveRegistrationResult } from "./interactive-registry.js";

/** Clears all active plugin interactive handlers. */
export function clearPluginInteractiveHandlers(): void {
  clearPluginInteractiveRuntimeState();
  for (const registry of collectLivePluginRegistries()) {
    registry.interactiveHandlers = [];
  }
}

/** Clears active interactive handlers owned by one plugin. */
export function clearPluginInteractiveHandlersForPlugin(pluginId: string): void {
  clearPluginInteractiveRuntimeStateForPlugin(pluginId);
  for (const registry of collectLivePluginRegistries()) {
    const interactiveHandlers = registry.interactiveHandlers;
    if (!interactiveHandlers?.some((registration) => registration.pluginId === pluginId)) {
      continue;
    }
    registry.interactiveHandlers = interactiveHandlers.filter(
      (registration) => registration.pluginId !== pluginId,
    );
  }
}

function resolveLivePluginInteractiveNamespaceMatch(channel: string, data: string) {
  const existing = resolvePluginInteractiveNamespaceMatch(channel, data);
  if (existing && existing.registration.registryOwned !== true) {
    return existing;
  }

  // Registry membership is lifecycle-owned. Resolve registry registrations only
  // through live owners so a replaced or released registry cannot keep executing.
  for (const registry of collectLivePluginRegistries()) {
    const match = resolvePluginInteractiveRegistrationsMatch(
      registry.interactiveHandlers ?? [],
      channel,
      data,
    );
    if (match) {
      return match;
    }
  }
  return null;
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
