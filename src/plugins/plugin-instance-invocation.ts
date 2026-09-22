import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type {
  PluginExecutionFrame,
  PluginInstanceInvocation,
} from "./plugin-instance-invocation.types.js";

class InvocationFrame implements PluginExecutionFrame {
  constructor(readonly invocation: PluginInstanceInvocation) {}

  withInvocation(invocation: PluginInstanceInvocation): InvocationFrame;
  withInvocation(invocation: undefined): undefined;
  withInvocation(invocation: PluginInstanceInvocation | undefined): InvocationFrame | undefined {
    if (!invocation) {
      return undefined;
    }
    return invocation === this.invocation ? this : new InvocationFrame(invocation);
  }
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
            current ? current.withInvocation(invocation) : new InvocationFrame(invocation),
            run,
          );
        },
        // Cache-owned retirement drops self-call admission, never the Gateway caller.
        exit<T>(run: () => T): T {
          const current = frames.getStore();
          return current?.invocation ? frames.run(current.withInvocation(undefined), run) : run();
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
