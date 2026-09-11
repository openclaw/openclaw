import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { PluginInvocationInstance } from "./plugin-instance.types.js";

// SDK source transforms and native chunks must enter and exit the same call token.
export const pluginInstanceInvocation = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginInstanceInvocation"),
  () => new AsyncLocalStorage<{ instance: PluginInvocationInstance; token: object }>(),
);
