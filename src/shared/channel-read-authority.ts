import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "./global-singleton.js";

type ChannelReadResource = {
  key: string;
  settle: (accepted: boolean) => Promise<void>;
  assertCurrent?: () => void;
};

type ChannelReadScope = {
  assertCurrent: () => void;
  signal?: AbortSignal;
  registerResource: (resource: ChannelReadResource) => void;
  discardResource: (key: string) => Promise<boolean>;
};

const completionKey = Symbol.for("openclaw.channelReadAuthority.completion");
type ScopedReadAuthority = (() => void) & { [completionKey]?: ChannelReadScope };

// Host and installed-plugin SDK chunks must share the same invocation scope.
const authorityScope = resolveGlobalSingleton(
  Symbol.for("openclaw.channelReadAuthority"),
  () => new AsyncLocalStorage<ScopedReadAuthority>(),
);

/** Capture internal media ownership and its exact assertion through queues and retries. */
export function captureChannelReadScope(): ChannelReadScope | undefined {
  return authorityScope.getStore()?.[completionKey];
}

/** Preserve the read failure while reporting failures to release its owned output. */
export async function settleChannelReadResource(resource: ChannelReadResource, accepted: boolean) {
  try {
    await resource.settle(accepted);
  } catch (error) {
    try {
      const [{ createSubsystemLogger }, { redactToolPayloadText }] = await Promise.all([
        import("../logging/subsystem.js"),
        import("../logging/redact.js"),
      ]);
      const log = createSubsystemLogger("channels");
      const failures: unknown[] = error instanceof AggregateError ? error.errors : [error];
      for (const failure of failures) {
        log.error(`Channel read output cleanup failed: ${redactToolPayloadText(String(failure))}`);
      }
    } catch {
      console.error("Channel read output cleanup failed; diagnostic logger unavailable.");
    }
  }
}

async function settleReadResources(resources: Set<ChannelReadResource>, accepted: boolean) {
  await Promise.all(
    Array.from(resources, (resource) => settleChannelReadResource(resource, accepted)),
  );
  resources.clear();
}

/** Host-only entry: neither model params nor plugin declarations mint read authority. */
export async function withChannelReadAuthority<T>(
  assertCurrent: (() => void) | undefined,
  run: () => Promise<T>,
  signal?: AbortSignal,
  onAccepted?: (result: T) => void,
): Promise<T> {
  if (!assertCurrent) {
    const result = await run();
    onAccepted?.(result);
    return result;
  }
  const parent = authorityScope.getStore();
  const parentCompletion = parent?.[completionKey];
  const sourceSignals = [parentCompletion?.signal, signal].filter((source): source is AbortSignal =>
    Boolean(source),
  );
  const sourceSignal = sourceSignals.length > 1 ? AbortSignal.any(sourceSignals) : sourceSignals[0];
  const resources = new Set<ChannelReadResource>();
  let open = true;
  const assertAuthority = () => {
    parent?.();
    if (!open) {
      throw new Error("Channel read authority is no longer active.");
    }
    sourceSignal?.throwIfAborted();
    assertCurrent();
    for (const resource of resources) {
      resource.assertCurrent?.();
    }
  };
  const scopedAuthority: ScopedReadAuthority = Object.assign(assertAuthority, {
    [completionKey]: {
      assertCurrent: assertAuthority,
      signal: sourceSignal,
      registerResource: (resource: ChannelReadResource) => {
        assertAuthority();
        resources.add({
          key: resource.key,
          settle: resource.settle,
          // Keep the originating provider check after the inner callable closes.
          assertCurrent: () => {
            sourceSignal?.throwIfAborted();
            assertCurrent();
            resource.assertCurrent?.();
          },
        });
      },
      discardResource: async (key: string) => {
        const resource = Array.from(resources).find((entry) => entry.key === key);
        if (!resource) {
          return (await parentCompletion?.discardResource(key)) ?? false;
        }
        await settleChannelReadResource(resource, false);
        resources.delete(resource);
        return true;
      },
    },
  });
  assertAuthority();
  try {
    let result: T;
    try {
      result = await authorityScope.run(scopedAuthority, run);
    } finally {
      // Fence both results and errors, including work already issued before revocation.
      assertAuthority();
    }
    if (parentCompletion) {
      for (const resource of resources) {
        parentCompletion.registerResource(resource);
      }
      resources.clear();
    }
    onAccepted?.(result);
    open = false;
    // Acceptance is final before teardown; closing a resource does not revoke the read.
    if (resources.size > 0) {
      await settleReadResources(resources, true);
    }
    return result;
  } catch (error) {
    open = false;
    if (resources.size > 0) {
      await settleReadResources(resources, false);
    }
    throw error;
  } finally {
    open = false;
  }
}
