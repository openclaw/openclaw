import {
  resolvePluginInteractiveNamespaceMatch,
  type InteractiveRegistrationResult,
} from "./interactive-registry.js";
import {
  getPluginInteractiveCallbackDedupeState,
  type RegisteredInteractiveHandler,
} from "./interactive-state.js";

type InteractiveDispatchResult =
  | { matched: false; handled: false; duplicate: false }
  | { matched: true; handled: boolean; duplicate: boolean };

type PluginInteractiveDispatchRegistration = {
  channel: string;
  namespace: string;
};

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

export async function dispatchPluginInteractiveHandler<
  TRegistration extends PluginInteractiveDispatchRegistration,
>(params: {
  channel: TRegistration["channel"];
  data: string;
  dedupeId?: string;
  onMatched?: () => Promise<void> | void;
  invoke: (
    match: PluginInteractiveMatch<TRegistration>,
  ) => Promise<{ handled?: boolean } | void> | { handled?: boolean } | void;
}): Promise<InteractiveDispatchResult> {
  const callbackDedupe = getPluginInteractiveCallbackDedupeState();
  const match = resolvePluginInteractiveNamespaceMatch(params.channel, params.data);
  if (!match) {
    return { matched: false, handled: false, duplicate: false };
  }

  const dedupeKey = params.dedupeId?.trim();
  if (dedupeKey && callbackDedupe.peek(dedupeKey)) {
    return { matched: true, handled: true, duplicate: true };
  }

  await params.onMatched?.();

  const resolved = await params.invoke(match as PluginInteractiveMatch<TRegistration>);
  if (dedupeKey) {
    callbackDedupe.check(dedupeKey);
  }

  return {
    matched: true,
    handled: resolved?.handled ?? true,
    duplicate: false,
  };
}
