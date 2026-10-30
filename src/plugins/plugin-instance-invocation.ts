import { AsyncLocalStorage } from "node:async_hooks";
import { runWithAsyncStore } from "../shared/async-store.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { PluginInstanceUnavailableError } from "./plugin-instance-error.js";
import type {
  PluginExecutionFrame,
  PluginExecutionScopes,
  PluginInstanceInvocation,
} from "./plugin-instance-invocation.types.js";
import type { PluginInstanceCallLease, PluginInvocationInstance } from "./plugin-instance.types.js";

export class InvocationFrame implements PluginExecutionFrame {
  readonly retentionOwner: PluginExecutionScopes["retentionOwner"];
  readonly invocation: PluginExecutionScopes["invocation"];
  readonly metadataScope: PluginExecutionScopes["metadataScope"];
  readonly cacheScope: PluginExecutionScopes["cacheScope"];
  readonly sourceCaptureStorage: PluginExecutionScopes["sourceCaptureStorage"];

  constructor(scopes: PluginExecutionScopes, invocation = scopes.invocation) {
    this.retentionOwner = scopes.retentionOwner;
    this.invocation = invocation;
    this.metadataScope = scopes.metadataScope;
    this.cacheScope = scopes.cacheScope;
    this.sourceCaptureStorage = scopes.sourceCaptureStorage;
  }

  get runtimePluginId(): string | undefined {
    return undefined;
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
          return current?.invocation === invocation
            ? run()
            : runWithAsyncStore(
                frames,
                createPluginExecutionFrame({ ...current, invocation }, current),
                run,
              );
        },
        // Cache-owned retirement drops self-call admission, never the Gateway caller.
        exit<T>(run: () => T): T {
          const current = frames.getStore();
          return current?.invocation
            ? runWithAsyncStore(
                frames,
                current.withScopes({ ...current, invocation: undefined }),
                run,
              )
            : run();
        },
      },
      getFrame(this: void): PluginExecutionFrame | undefined {
        return frames.getStore();
      },
      runFrame<T>(this: void, frame: PluginExecutionFrame, run: () => T): T {
        return runWithAsyncStore(frames, frame, run);
      },
    };
  },
);

export const pluginInstanceInvocation = pluginExecutionContext.invocation;
export const getPluginExecutionFrame = pluginExecutionContext.getFrame;
export const runWithPluginExecutionFrame = pluginExecutionContext.runFrame;

/** Retain admission independently; each operation still owns its physical call settlement. */
export function retainPluginOwnerWork(owner: {
  instance: PluginInvocationInstance;
  lease(options: { joinDisposal: false; ownerLifetime?: true }): PluginInstanceCallLease;
  invoke<T>(run: () => T, lease: PluginInstanceCallLease): T;
  hasToken(token: object): boolean;
}) {
  const held = pluginInstanceInvocation.exit(() =>
    owner.lease({ joinDisposal: false, ownerLifetime: true }),
  );
  return {
    run: <T>(run: () => T): T => {
      if (!owner.hasToken(held.token)) {
        throw new PluginInstanceUnavailableError(owner.instance.pluginId);
      }
      return pluginInstanceInvocation.run({ instance: owner.instance, token: held.token }, () =>
        owner.invoke(run, owner.lease({ joinDisposal: false })),
      );
    },
    release: () => {
      void held.release();
    },
  };
}
