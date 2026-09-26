import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { PluginHookGatewayCronService } from "./hook-cron.types.js";
import type { PluginHookCronReconciledContext, PluginHookGatewayContext } from "./hook-types.js";
import { createPluginHookCronGetter, type PluginServiceCronHost } from "./service-cron.js";

type HookCronGetter = () => PluginHookGatewayCronService | PluginServiceCronHost | undefined;

export type PluginCoreGatewayHookContext = Omit<PluginHookGatewayContext, "getCron"> & {
  getCron?: HookCronGetter;
};

export type PluginCoreCronReconciledContext = Omit<PluginHookCronReconciledContext, "getCron"> & {
  getCron?: HookCronGetter;
};

export function isPluginServiceCronHost(value: unknown): value is PluginServiceCronHost {
  if (!isRecord(value)) {
    return false;
  }
  return [
    "list",
    "getJob",
    "run",
    "add",
    "update",
    "updateWithPrecondition",
    "remove",
    "removeStaleJobFamily",
  ].every((method) => typeof value[method] === "function");
}

export function createPluginCronHookInvocation<T>(params: {
  context: unknown;
  pluginId: string;
  invoke: (context: unknown) => T | Promise<T>;
}): { invoke: () => Promise<T>; expire: () => void } {
  let active = true;
  return {
    expire: () => {
      active = false;
    },
    invoke: async () => {
      try {
        const context = params.context;
        if (!isRecord(context) || typeof context.getCron !== "function") {
          return await params.invoke(context);
        }
        const rawGetCron = context.getCron;
        const initialCron = rawGetCron();
        if (!isPluginServiceCronHost(initialCron)) {
          return await params.invoke(context);
        }
        const getCron = createPluginHookCronGetter({
          getCron: () => {
            const cron = rawGetCron();
            return isPluginServiceCronHost(cron) ? cron : undefined;
          },
          pluginId: params.pluginId,
          assertActive: () => {
            if (!active) {
              throw new Error(`Plugin hook ${params.pluginId} cron scheduler is no longer active`);
            }
          },
        });
        return await params.invoke({ ...context, getCron });
      } finally {
        active = false;
      }
    },
  };
}
