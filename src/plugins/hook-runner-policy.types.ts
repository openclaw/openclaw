import type { PluginHookHandlerMap, PluginHookName, PluginHookRegistration } from "./types.js";

export type HookEvent<K extends PluginHookName> = Parameters<PluginHookHandlerMap[K]>[0];
export type HookContext<K extends PluginHookName> = Parameters<PluginHookHandlerMap[K]>[1];
export type HookResult<K extends PluginHookName> = Exclude<
  Awaited<ReturnType<PluginHookHandlerMap[K]>>,
  void
>;
export type ClaimingHookName = {
  [K in PluginHookName]: [HookResult<K>] extends [never]
    ? never
    : HookResult<K> extends { handled: boolean }
      ? K
      : never;
}[PluginHookName];

export type ModifyingHookPolicy<K extends PluginHookName, TResult = HookResult<K>> = {
  mergeResults?: (
    accumulated: TResult | undefined,
    next: TResult,
    registration: PluginHookRegistration<K>,
    event: HookEvent<K>,
  ) => TResult;
  isolateEventPerHandler?: boolean;
  eventForHandler?: (event: HookEvent<K>, result: TResult | undefined) => HookEvent<K>;
  /** Synchronous, after earlier handlers settle and immediately before this invocation. */
  contextForHandler?: (context: HookContext<K>) => HookContext<K>;
  mergeNullResults?: boolean;
  shouldStop?: (result: TResult) => boolean;
  terminalLabel?: string;
  onTerminal?: (params: { hookName: K; pluginId: string; result: TResult }) => void;
  includeRegistration?: (registration: PluginHookRegistration<K>) => boolean;
  assertHandlerBoundaryActive?: () => void;
  onHandlerResult?: (params: {
    hook: PluginHookRegistration<K>;
    result: TResult | undefined;
  }) => void;
  onHandlerError?: (hook: PluginHookRegistration<K>, failOpen: boolean) => void;
};
