import type { createHeadlessDeadlineScope } from "../agents/code-mode-headless.js";

type TriggerRuntimeLease<T> = {
  promise: Promise<T>;
  lifetime: ReturnType<typeof createCronTriggerRuntimeLifetime>;
};
type TriggerRuntimeDeadline = Pick<
  ReturnType<typeof createHeadlessDeadlineScope>,
  "signal" | "wait"
>;

export async function retainCronTriggerRuntime<T>(
  entry: TriggerRuntimeLease<T>,
  scope: TriggerRuntimeDeadline,
) {
  const release = entry.lifetime.retain();
  try {
    return { runtime: await scope.wait(entry.promise), release };
  } catch (error) {
    release();
    throw error;
  }
}

export async function reuseCronTriggerRuntime<
  T extends {
    isCurrent: () => boolean;
    sandboxNeedsProvisioning?: (signal: AbortSignal) => Promise<boolean>;
  },
>(entry: TriggerRuntimeLease<T>, scope: TriggerRuntimeDeadline) {
  const retained = await retainCronTriggerRuntime(entry, scope);
  const { runtime } = retained;
  let reusable = false;
  try {
    const check = runtime.sandboxNeedsProvisioning;
    reusable =
      runtime.isCurrent() &&
      (!check || (!(await scope.wait(() => check(scope.signal))) && runtime.isCurrent()));
    return reusable ? retained : undefined;
  } finally {
    if (!reusable) {
      retained.release();
    }
  }
}

/** A cached runtime retires immediately but releases its workspace after its last evaluation. */
export function createCronTriggerRuntimeLifetime() {
  let runtime: { [Symbol.dispose]?: () => void } | undefined;
  let users = 0;
  let retired = false;
  const dispose = () => {
    if (!retired || users > 0) {
      return;
    }
    const owned = runtime;
    runtime = undefined;
    owned?.[Symbol.dispose]?.();
  };
  return {
    publish(prepared: { [Symbol.dispose]?: () => void }) {
      runtime = prepared;
      dispose();
    },
    retain() {
      users += 1;
      let active = true;
      return () => {
        if (active) {
          active = false;
          users -= 1;
          dispose();
        }
      };
    },
    retire() {
      retired = true;
      dispose();
    },
  };
}
