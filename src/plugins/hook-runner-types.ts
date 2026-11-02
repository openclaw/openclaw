import type {
  PluginHookBeforeAgentFinalizeResult,
  PluginHookName,
  PluginHookHandlerMap,
  PluginHookRegistration,
} from "./hook-types.js";

export type HookEvent<K extends PluginHookName> = Parameters<PluginHookHandlerMap[K]>[0];
export type HookContext<K extends PluginHookName> = Parameters<PluginHookHandlerMap[K]>[1];
export type HookResult<K extends PluginHookName> = Exclude<
  Awaited<ReturnType<PluginHookHandlerMap[K]>>,
  void
>;
export type ModifyingHookPolicy<K extends PluginHookName> = {
  mergeResults?: (
    accumulated: HookResult<K> | undefined,
    next: HookResult<K>,
    registration: PluginHookRegistration<K>,
    event: HookEvent<K>,
  ) => HookResult<K>;
  isolateEventPerHandler?: boolean;
  eventForHandler?: (event: HookEvent<K>, result: HookResult<K> | undefined) => HookEvent<K>;
  mergeNullResults?: boolean;
  shouldStop?: (result: HookResult<K>) => boolean;
  terminalLabel?: string;
  includeRegistration?: (registration: PluginHookRegistration<K>) => boolean;
  assertHandlerBoundaryActive?: () => void;
  onHandlerResult?: (params: {
    hook: PluginHookRegistration<K>;
    result: HookResult<K> | undefined;
  }) => void;
  onHandlerError?: (hook: PluginHookRegistration<K>, failOpen: boolean) => void;
};

export type HookFailurePolicy = "fail-open" | "fail-closed";

export type VoidHookRunOptions = {
  unrefTimeout?: boolean;
};

export type VoidHookContextProjection<Context, K extends PluginHookName> = (
  hook: PluginHookRegistration<K>,
  context: Context,
) => { context: Context; dispose: () => void };

export type BeforeAgentFinalizeRetry = NonNullable<PluginHookBeforeAgentFinalizeResult["retry"]>;

export type BeforeAgentFinalizeResultWithRetryCandidates = PluginHookBeforeAgentFinalizeResult & {
  retryCandidates?: BeforeAgentFinalizeRetry[];
};

export type HookRunnerOptions = {
  logger?: {
    debug?: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
  };
  /** If true, errors in hooks will be caught and logged instead of thrown */
  catchErrors?: boolean;
  failurePolicyByHook?: Partial<Record<PluginHookName, HookFailurePolicy>>;
  voidHookTimeoutMsByHook?: Partial<Record<PluginHookName, number>>;
  modifyingHookTimeoutMsByHook?: Partial<Record<PluginHookName, number>>;
};
