import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type {
  PluginExecutionFrame,
  PluginExecutionScopes,
  PluginInstanceInvocation,
} from "./plugin-instance-invocation.types.js";

export class InvocationFrame implements PluginExecutionFrame {
  readonly invocation: PluginExecutionScopes["invocation"];
  readonly metadataScope: PluginExecutionScopes["metadataScope"];
  readonly cacheScope: PluginExecutionScopes["cacheScope"];

  constructor(scopes: PluginExecutionScopes) {
    this.invocation = scopes.invocation;
    this.metadataScope = scopes.metadataScope;
    this.cacheScope = scopes.cacheScope;
  }

  withScopes(scopes: PluginExecutionScopes): InvocationFrame {
    return new InvocationFrame(scopes);
  }
}

/** Copy core scopes through the current owner so runtime-only fields survive. */
export function createPluginExecutionFrame(
  scopes: PluginExecutionScopes,
  current: PluginExecutionFrame | undefined,
): PluginExecutionFrame {
  return current ? current.withScopes(scopes) : new InvocationFrame(scopes);
}

// SDK source transforms and native chunks share one private frame. The public
// Gateway scope remains a separate object with its existing copy/identity rules.
const pluginExecutionContext = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginInstanceInvocation"),
  () => {
    const frames = new AsyncLocalStorage<PluginExecutionFrame | undefined>();
    return {
      invocation: {
        getStore(): PluginInstanceInvocation | undefined {
          return frames.getStore()?.invocation;
        },
        run<T>(invocation: PluginInstanceInvocation, run: () => T): T {
          const current = frames.getStore();
          return frames.run(
            current?.invocation === invocation
              ? current
              : createPluginExecutionFrame({ ...current, invocation }, current),
            run,
          );
        },
        // Cache-owned retirement drops self-call admission, never the Gateway caller.
        exit<T>(run: () => T): T {
          const current = frames.getStore();
          return current?.invocation
            ? frames.run(current.withScopes({ ...current, invocation: undefined }), run)
            : run();
        },
      },
      getFrame(this: void): PluginExecutionFrame | undefined {
        return frames.getStore();
      },
      runFrame<T>(this: void, frame: PluginExecutionFrame, run: () => T): T {
        return frames.run(frame, run);
      },
    };
  },
);

export const pluginInstanceInvocation = pluginExecutionContext.invocation;
export const getPluginExecutionFrame = pluginExecutionContext.getFrame;
export const runWithPluginExecutionFrame = pluginExecutionContext.runFrame;
