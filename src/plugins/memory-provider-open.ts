import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { assertMemoryCallerCurrent, prepareMemoryCallerRead } from "./memory-audience.js";
import { bindMemoryProvider } from "./memory-provider-adapter.js";
import type {
  MemoryProviderCapabilities,
  MemoryProviderHandle,
} from "./memory-provider-runtime-types.js";
import type {
  MemoryBackendAccess,
  MemoryCallerContext,
  MemoryProviderOpenParams,
  MemoryProviderOpenResult,
} from "./memory-provider-types.js";
import { runPluginCleanup } from "./plugin-instance-scope.js";
import type { MemoryBackendRegistration } from "./registry-contribution-types.js";

/** Caller-bound open steps shared by the slot owner and the passive backends it opens. */

function isValidMemoryProviderCapabilities(
  capabilities: MemoryProviderCapabilities | undefined,
): capabilities is MemoryProviderCapabilities {
  return (
    Array.isArray(capabilities?.sources) &&
    capabilities.sources.length > 0 &&
    capabilities.sources.every((source) => source === "memory" || source === "sessions") &&
    typeof capabilities.pagination === "boolean" &&
    Array.isArray(capabilities.candidates) &&
    capabilities.candidates.every((kind) => kind === "trigger" || kind === "project") &&
    typeof capabilities.projectFilter === "boolean" &&
    (capabilities.store === undefined || typeof capabilities.store === "boolean")
  );
}

export async function waitForMemoryCallerRead(context: MemoryCallerContext): Promise<void> {
  const pending = prepareMemoryCallerRead(context);
  if (pending) {
    await racePromiseWithAbortSignal(pending, context.signal);
  }
  context.assertCurrent();
}

/** Revalidates the caller after open, checks the handle shape, and binds it to its provider. */
export async function settleMemoryProviderOpen(
  result: MemoryProviderOpenResult,
  providerId: string,
  context: MemoryCallerContext,
  callerContext: MemoryCallerContext,
  runtimeOwner: object,
  phases?: { mark(phase: string): void },
  options?: { readOnly?: boolean },
): Promise<MemoryProviderOpenResult> {
  try {
    phases?.mark("memory.provider-open.revalidate");
    await waitForMemoryCallerRead(context);
    if (
      result.provider &&
      (typeof result.provider.search !== "function" ||
        typeof result.provider.get !== "function" ||
        typeof result.provider.health !== "function" ||
        typeof result.provider.close !== "function" ||
        !isValidMemoryProviderCapabilities(result.provider.capabilities) ||
        result.provider.capabilities.candidates.length > 0 !==
          (typeof result.provider.candidates === "function") ||
        (result.provider.capabilities.store === true) !==
          (typeof result.provider.store === "function"))
    ) {
      throw new Error(
        "memory provider must implement search, get, health, close, and valid capabilities with matching candidates and store",
      );
    }
  } catch (error) {
    if (result.provider && typeof result.provider.close === "function") {
      phases?.mark("memory.provider-open.close");
      await runPluginCleanup(result.provider, () => result.provider!.close());
    }
    throw error;
  }
  phases?.mark("memory.provider-open.bind");
  return {
    ...result,
    provider: result.provider
      ? bindMemoryProvider(result.provider, providerId, callerContext, runtimeOwner, options)
      : null,
  };
}

/**
 * Lets the selected slot owner open passive backends under its own open() authority.
 * The owner's context shares the caller's authority object, so access keeps a frozen copy
 * taken before the owner runs. Backend leases the owner leaves open close with its lease.
 */
export function createMemoryBackendAccess(
  backends: readonly MemoryBackendRegistration[],
  params: MemoryProviderOpenParams,
) {
  const caller = params.context;
  const { authority } = caller;
  // Host-minted audiences are already frozen; every other nested value is copied.
  const callerContext: MemoryCallerContext = Object.freeze({
    authority: Object.freeze(
      authority.kind === "operator"
        ? { ...authority, scopes: Object.freeze([...authority.scopes]) }
        : authority.kind === "session" && authority.conversationRecall
          ? { ...authority, conversationRecall: Object.freeze({ ...authority.conversationRecall }) }
          : { ...authority },
    ),
    ...(caller.signal ? { signal: caller.signal } : {}),
    assertCurrent: () => caller.assertCurrent(),
  });
  const context: MemoryCallerContext = Object.freeze({
    ...callerContext,
    assertCurrent: () => assertMemoryCallerCurrent(callerContext),
  });
  const { cfg, agentId, purpose } = params;
  let open = true;
  const leases = new Set<MemoryProviderHandle>();
  const access: MemoryBackendAccess = {
    list: () =>
      backends.map(({ pluginId, pluginName }) => ({
        id: pluginId,
        ...(pluginName ? { name: pluginName } : {}),
      })),
    async open(backendId) {
      if (!open) {
        throw new Error("memory backend access ended with the memory slot owner's lease");
      }
      const backend = backends.find((entry) => entry.pluginId === backendId);
      if (!backend) {
        return { provider: null, error: `memory backend "${backendId}" is not loaded` };
      }
      await waitForMemoryCallerRead(context);
      const opened = await backend.providerRuntime.open({
        cfg,
        agentId,
        context,
        ...(purpose ? { purpose } : {}),
      });
      const result = await settleMemoryProviderOpen(
        opened,
        backendId,
        context,
        callerContext,
        backend.instanceOwner ?? backend.providerRuntime,
        undefined,
        { readOnly: purpose === "status" },
      );
      if (result.provider) {
        if (!open) {
          await result.provider.close();
          throw new Error("memory backend access ended with the memory slot owner's lease");
        }
        leases.add(result.provider);
      }
      return { ...result, providerId: backendId, adapter: backend.adapter ?? "native" };
    },
  };
  const end = async () => {
    open = false;
    const pending = [...leases];
    leases.clear();
    await Promise.allSettled(pending.map((lease) => lease.close()));
  };
  return { access, end };
}
