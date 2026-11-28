import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { observeDiagnosticsTimelinePhases } from "../infra/diagnostics-timeline.js";
import { assertMemoryCallerCurrent, prepareMemoryCallerRead } from "./memory-audience.js";
import type {
  MemoryCitation,
  MemoryProviderHandle,
  MemoryReference,
  MemorySearchPage,
  MemoryStoreRequest,
} from "./memory-provider-runtime-types.js";
import type { MemoryCallerContext } from "./memory-provider-types.js";
import { getPluginValueInstance, runPluginCleanup } from "./plugin-instance-scope.js";

const refreshHandoffs = new WeakMap<
  MemoryProviderHandle,
  (onStarted: () => void) => Promise<void>
>();

/** Join caller admission before handing asynchronous refresh to the provider owner. */
export function refreshMemoryProviderWithHandoff(
  provider: MemoryProviderHandle,
  onStarted: () => void,
): Promise<void> {
  const refresh = refreshHandoffs.get(provider);
  if (!refresh) {
    throw new Error("memory refresh requires a bound provider handle");
  }
  return refresh(onStarted);
}

/** Recheck both caller and provider lifetime after every asynchronous boundary. */
const MAX_MEMORY_STORE_TEXT = 64 * 1024;

/** Rejects store input every provider would otherwise have to re-validate. */
function assertMemoryStoreRequest(request: MemoryStoreRequest) {
  if (typeof request?.text !== "string" || !request.text.trim()) {
    throw new Error("memory store requires non-empty text");
  }
  if (request.text.length > MAX_MEMORY_STORE_TEXT) {
    throw new Error(`memory store text exceeds ${MAX_MEMORY_STORE_TEXT} characters`);
  }
  if (request.tags !== undefined && !request.tags.every((tag) => typeof tag === "string")) {
    throw new Error("memory store tags must be strings");
  }
}

export function bindMemoryProvider(
  provider: MemoryProviderHandle,
  providerId: string,
  context: MemoryCallerContext,
  runtimeOwner?: object,
  options?: { readOnly?: boolean },
): MemoryProviderHandle {
  let closed = false;
  const instance =
    getPluginValueInstance(provider) ??
    (runtimeOwner ? getPluginValueInstance(runtimeOwner) : undefined);
  // Quiesce closes admission only: a call admitted before it may still complete.
  const assertCurrent = (admitting: boolean) => {
    if (closed) {
      throw new Error("memory provider handle is closed");
    }
    assertMemoryCallerCurrent(context);
    if (
      instance &&
      ((admitting && !instance.acceptingCalls) ||
        instance.owner?.revoked ||
        instance.lifecycle.signal.aborted)
    ) {
      throw new Error("memory provider instance is no longer current");
    }
  };
  const invoke = async <T>(run: () => Promise<T>): Promise<T> => {
    using phases = observeDiagnosticsTimelinePhases("memory.provider-call.authority");
    const before = prepareMemoryCallerRead(context);
    if (before) {
      await racePromiseWithAbortSignal(before, context.signal);
    }
    assertCurrent(true);
    phases.mark("memory.provider-call.execute");
    const result = await run();
    phases.mark("memory.provider-call.revalidate");
    const after = prepareMemoryCallerRead(context);
    if (after) {
      await racePromiseWithAbortSignal(after, context.signal);
    }
    assertCurrent(false);
    return result;
  };
  const assertReference = (reference: MemoryReference) => {
    if (reference.providerId !== providerId) {
      throw new Error("memory reference belongs to a different provider");
    }
  };
  const assertCitations = (citations?: MemoryCitation[]) => {
    for (const citation of citations ?? []) {
      if (citation.reference) {
        assertReference(citation.reference);
      }
    }
  };
  const validatePage = (page: MemorySearchPage) => {
    for (const hit of page.hits) {
      assertReference(hit.reference);
      assertCitations(hit.citations);
    }
    return page;
  };
  const capabilities = Object.freeze({
    ...provider.capabilities,
    sources: Object.freeze([...provider.capabilities.sources]),
    candidates: Object.freeze([...provider.capabilities.candidates]),
    ...(provider.store ? { store: true } : {}),
  });
  const assertSearchCapabilities = (request: Parameters<MemoryProviderHandle["search"]>[0]) => {
    const unsupportedSource = request.sources?.find(
      (source) => !capabilities.sources.includes(source),
    );
    if (unsupportedSource) {
      throw new Error(
        `memory provider does not support the ${unsupportedSource} source capability`,
      );
    }
    if (request.cursor !== undefined && !capabilities.pagination) {
      throw new Error("memory provider does not support the pagination capability");
    }
    if (request.activeProjectKeys?.length && !capabilities.projectFilter) {
      throw new Error("memory provider does not support the project filter capability");
    }
  };
  const refresh = provider.refresh
    ? (onStarted?: () => void) =>
        invoke(() => {
          const pending = provider.refresh!();
          onStarted?.();
          return pending;
        })
    : undefined;
  const bound: MemoryProviderHandle = {
    capabilities,
    search: (request) =>
      invoke(async () => {
        assertSearchCapabilities(request);
        return validatePage(await provider.search(request));
      }),
    get: (request) =>
      invoke(async () => {
        assertReference(request.reference);
        const result = await provider.get(request);
        if (result.status === "ok") {
          assertReference(result.reference);
          assertCitations(result.citations);
        }
        return result;
      }),
    health: () => invoke(() => provider.health()),
    ...(provider.candidates
      ? {
          candidates: (request: Parameters<NonNullable<MemoryProviderHandle["candidates"]>>[0]) => {
            return invoke(async () => {
              if (!capabilities.candidates.includes(request.kind)) {
                throw new Error(
                  `memory provider does not support the ${request.kind} candidates capability`,
                );
              }
              if (request.activeProjectKeys?.length && !capabilities.projectFilter) {
                throw new Error("memory provider does not support the project filter capability");
              }
              return validatePage(await provider.candidates!(request));
            });
          },
        }
      : {}),
    ...(refresh ? { refresh: () => refresh() } : {}),
    ...(provider.store
      ? {
          store: (request: MemoryStoreRequest) =>
            invoke(async () => {
              if (options?.readOnly) {
                throw new Error("memory provider lease opened for status is read-only");
              }
              assertMemoryStoreRequest(request);
              const result = await provider.store!(request);
              if (result.status === "stored") {
                assertReference(result.reference);
              } else if (result.status !== "rejected" || typeof result.reason !== "string") {
                throw new Error("memory provider returned an invalid store result");
              }
              return result;
            }),
        }
      : {}),
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      // Lease release is teardown and must remain possible after caller revocation.
      await runPluginCleanup(provider, () => provider.close());
    },
  };
  if (refresh) {
    refreshHandoffs.set(bound, refresh);
  }
  return bound;
}
