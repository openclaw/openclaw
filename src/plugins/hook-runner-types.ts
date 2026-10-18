import type {
  PluginHookBeforeAgentFinalizeResult,
  PluginHookName,
  PluginHookRegistration,
} from "./hook-types.js";

type HookRunnerLogger = {
  debug?: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
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
  logger?: HookRunnerLogger;
  /** If true, errors in hooks will be caught and logged instead of thrown */
  catchErrors?: boolean;
  failurePolicyByHook?: Partial<Record<PluginHookName, HookFailurePolicy>>;
  voidHookTimeoutMsByHook?: Partial<Record<PluginHookName, number>>;
  modifyingHookTimeoutMsByHook?: Partial<Record<PluginHookName, number>>;
};
