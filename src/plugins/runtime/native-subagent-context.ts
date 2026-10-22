import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { NativeSubagentRuntime } from "./types-native-subagent.js";

type RuntimeGuard = { pluginId: string; assertCurrent: () => void; signal?: AbortSignal };
type RequestScope = {
  active: boolean;
  abort: AbortController;
  create: (guard: RuntimeGuard) => NativeSubagentRuntime | Promise<NativeSubagentRuntime>;
  runtimes: Map<string, NativeSubagentRuntime | Promise<NativeSubagentRuntime>>;
};

const requestScope = resolveGlobalSingleton(
  Symbol.for("openclaw.nativeSubagentRequestScope"),
  () => new AsyncLocalStorage<RequestScope>(),
);
const runtimeGuard = resolveGlobalSingleton(
  Symbol.for("openclaw.nativeSubagentRuntimeGuard"),
  () => new AsyncLocalStorage<RuntimeGuard>(),
);

export async function withNativeSubagentRequest<T>(
  create: (guard: RuntimeGuard) => NativeSubagentRuntime | Promise<NativeSubagentRuntime>,
  run: () => Promise<T>,
): Promise<T> {
  const scope: RequestScope = {
    active: true,
    abort: new AbortController(),
    create,
    runtimes: new Map(),
  };
  return requestScope.run(scope, async () => {
    try {
      return await run();
    } finally {
      scope.active = false;
      scope.abort.abort(new Error("Native subagent hook invocation ended."));
      scope.runtimes.clear();
    }
  });
}

export function withNativeSubagentRuntimeGuard<T>(guard: RuntimeGuard, run: () => T): T {
  return runtimeGuard.run(guard, run);
}

async function currentRuntime(): Promise<NativeSubagentRuntime> {
  const scope = requestScope.getStore();
  const guard = runtimeGuard.getStore();
  if (!scope?.active || !guard) {
    throw new Error(
      "Native subagents require an active requester-bound reply_dispatch invocation.",
    );
  }
  guard.assertCurrent();
  let runtime = scope.runtimes.get(guard.pluginId);
  if (!runtime) {
    runtime = scope.create({
      pluginId: guard.pluginId,
      signal: scope.abort.signal,
      assertCurrent() {
        if (!scope.active) {
          throw new Error("Native subagent request is no longer active.");
        }
        guard.assertCurrent();
      },
    });
    scope.runtimes.set(guard.pluginId, runtime);
  }
  const prepared = await runtime;
  if (!scope.active) {
    throw new Error("Native subagent request is no longer active.");
  }
  guard.assertCurrent();
  return prepared;
}

/** No session key or authority can be supplied by a plugin. */
export const nativeSubagentRuntime: NativeSubagentRuntime = {
  async spawn(params) {
    return (await currentRuntime()).spawn(params);
  },
  async collect(params) {
    return (await currentRuntime()).collect(params);
  },
};
