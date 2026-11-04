import { randomUUID } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { NODE_COMPUTER_RESOURCE_FETCH_COMMAND } from "../../packages/gateway-protocol/src/environment-node-capabilities.js";
import { throwIfSettledRejected } from "../infra/error-graph-internal.js";
import {
  COMPUTER_EXECUTION_ID_PATTERN,
  type ComputerUseCapabilityDescriptor,
} from "./computer-use-contract.js";
import type {
  OpenClawPluginNodeHostCommand,
  OpenClawPluginNodeHostCommandAvailabilityContext,
  OpenClawPluginNodeHostCommandContext,
} from "./types.node-host.js";

type ComputerUseExecution = {
  snapshot(paramsJSON: string | null | undefined, signal?: AbortSignal): Promise<string>;
  act(paramsJSON: string | null | undefined, signal?: AbortSignal): Promise<string>;
  close(reason: string): Promise<void>;
  readResource?(handle: string, maxBytes: number, signal?: AbortSignal): Promise<string>;
};

export type ComputerUseProvider = {
  id: string;
  label: string;
  capabilities(): ComputerUseCapabilityDescriptor;
  isAvailable(): boolean;
  prepare?: (context: OpenClawPluginNodeHostCommandAvailabilityContext) => Promise<void> | void;
  watchAvailability?: OpenClawPluginNodeHostCommand["watchAvailability"];
  openExecution(context: {
    executionId: string;
    sessionKey?: string;
  }): Promise<ComputerUseExecution>;
};

// Structural registration surface built from leaf node-host types only: importing
// the full plugin API type here creates an import cycle through the gateway
// server-method types that consume this contract.
type ComputerUseRegistrationApi = {
  registerNodeHostCommand(command: OpenClawPluginNodeHostCommand): void;
};

/** Register the canonical node-host command pair for one node-local provider. */
export function registerComputerUseProvider(
  api: ComputerUseRegistrationApi,
  provider: ComputerUseProvider,
): void {
  let execution:
    | { id: string; sessionKey?: string; promise: Promise<ComputerUseExecution> }
    | undefined;
  let closingPromise: Promise<void> | undefined;
  let pendingClose: Promise<void> | undefined;
  const hasActiveWork = () =>
    execution !== undefined || closingPromise !== undefined || pendingClose !== undefined;

  const executionEnvelopeFromParams = (paramsJSON: string | null | undefined) => {
    let value: unknown;
    try {
      value = JSON.parse(paramsJSON ?? "{}");
    } catch {
      throw new Error("COMPUTER_INVALID_REQUEST: params must be valid JSON");
    }
    const executionId = isRecord(value) ? value.executionId : undefined;
    if (executionId === undefined) {
      return { executionId: undefined, value };
    }
    if (
      typeof executionId !== "string" ||
      !new RegExp(COMPUTER_EXECUTION_ID_PATTERN, "u").test(executionId)
    ) {
      throw new Error("COMPUTER_INVALID_REQUEST: executionId is required");
    }
    return { executionId, value };
  };
  const getExecution = async (
    executionId: string,
    context?: OpenClawPluginNodeHostCommandContext,
  ) => {
    // An earlier queued close can replace the barrier while this acquisition resumes.
    for (let barrier = closingPromise; barrier !== undefined; barrier = closingPromise) {
      await barrier;
    }
    if (execution && execution.id !== executionId) {
      throw new Error("COMPUTER_HOST_BUSY: another provider execution owns this computer");
    }
    if (!execution) {
      const opened = provider.openExecution(
        context?.sessionKey ? { executionId, sessionKey: context.sessionKey } : { executionId },
      );
      // A failed open must not wedge the provider behind a cached rejection;
      // the next command call retries openExecution instead.
      opened.catch(() => {
        if (execution?.promise === opened) {
          execution = undefined;
        }
      });
      execution = { id: executionId, sessionKey: context?.sessionKey, promise: opened };
    }
    return execution.promise;
  };
  const closeCurrentExecution = (
    executionId: string | undefined,
    reason: string,
  ): Promise<void> => {
    const current = execution;
    if (!current || (executionId !== undefined && current.id !== executionId)) {
      return Promise.resolve();
    }
    if (pendingClose) {
      return pendingClose;
    }
    // Watcher stop and disconnect must join the same physical close before either yields.
    const close = current.promise.then(async (opened) => await opened.close(reason));
    pendingClose = close;
    closingPromise = close;
    void close.then(
      () => {
        if (execution === current) {
          execution = undefined;
        }
        pendingClose = undefined;
        closingPromise = undefined;
      },
      () => {
        pendingClose = undefined;
        // Failed open owns nothing; failed physical close stays owned for an explicit close.
        if (execution !== current) {
          closingPromise = undefined;
        }
      },
    );
    return close;
  };
  const closeExecution = (executionId: string | undefined, reason: string): Promise<void> => {
    if (!pendingClose) {
      return closeCurrentExecution(executionId, reason);
    }
    const joined = (async () => {
      // Earlier queued operations can publish another close after each barrier settles.
      for (let barrier = pendingClose; barrier !== undefined; barrier = pendingClose) {
        const matchesClosingOwner = executionId === undefined || execution?.id === executionId;
        try {
          await barrier;
        } catch (error) {
          if (matchesClosingOwner) {
            throw error;
          }
          return;
        }
      }
      await closeCurrentExecution(executionId, reason);
    })();
    // Watcher cleanup may initiate an unawaited close; joiners still receive the actual failure.
    void joined.catch(() => {});
    return joined;
  };

  api.registerNodeHostCommand({
    command: "screen.snapshot",
    cap: "screen",
    dangerous: false,
    prepare: (context) => provider.prepare?.(context),
    isAvailable: () => provider.isAvailable(),
    hasActiveWork,
    watchAvailability: (context, onChange) => {
      const stopWatching = provider.watchAvailability?.(context, onChange);
      let availabilityStop: Promise<void> | undefined;
      return async () => {
        availabilityStop ??= Promise.resolve()
          .then(() => stopWatching?.())
          .catch((error: unknown) => {
            availabilityStop = undefined;
            throw error;
          });
        const results = await Promise.allSettled([
          availabilityStop,
          closeExecution(undefined, "node-host-stop"),
        ]);
        throwIfSettledRejected(results, "computer provider shutdown failed");
      };
    },
    onDisconnect: async () => await closeExecution(undefined, "gateway-disconnect"),
    handle: async (paramsJSON, _io, context) => {
      const envelope = executionEnvelopeFromParams(paramsJSON);
      if (envelope.executionId) {
        return await (
          await getExecution(envelope.executionId, context)
        ).snapshot(paramsJSON, context?.signal);
      }
      const executionId = randomUUID();
      const opened = await provider.openExecution(
        context?.sessionKey ? { executionId, sessionKey: context.sessionKey } : { executionId },
      );
      try {
        return await opened.snapshot(paramsJSON, context?.signal);
      } finally {
        await opened.close("snapshot-complete");
      }
    },
  });
  api.registerNodeHostCommand({
    command: "computer.act",
    cap: "computer",
    dangerous: true,
    computerUse: () => provider.capabilities(),
    isAvailable: () => provider.isAvailable(),
    hasActiveWork,
    handle: async (paramsJSON, _io, context) => {
      const envelope = executionEnvelopeFromParams(paramsJSON);
      if (!envelope.executionId) {
        throw new Error("COMPUTER_INVALID_REQUEST: executionId is required");
      }
      if (isRecord(envelope.value) && envelope.value.action === "__close_execution") {
        const reason = envelope.value.reason;
        await closeExecution(
          envelope.executionId,
          typeof reason === "string" && reason.trim() ? reason.slice(0, 64) : "completion",
        );
        return JSON.stringify({ ok: true });
      }
      return await (
        await getExecution(envelope.executionId, context)
      ).act(paramsJSON, context?.signal);
    },
  });
  api.registerNodeHostCommand({
    command: NODE_COMPUTER_RESOURCE_FETCH_COMMAND,
    cap: "file-transfer",
    dangerous: false,
    isAvailable: () => true,
    hasActiveWork,
    handle: async (paramsJSON, _io, context) => {
      const value: unknown = JSON.parse(paramsJSON ?? "null");
      if (
        !isRecord(value) ||
        Object.keys(value).some((key) => key !== "resourceHandle" && key !== "maxBytes") ||
        typeof value.resourceHandle !== "string" ||
        !value.resourceHandle.trim() ||
        typeof value.maxBytes !== "number" ||
        !Number.isSafeInteger(value.maxBytes) ||
        value.maxBytes <= 0
      ) {
        throw new Error(
          "COMPUTER_INVALID_RESOURCE: resourceHandle and bounded maxBytes are required",
        );
      }
      const captured = execution;
      const assertCurrent = () => {
        context?.signal?.throwIfAborted();
        if (
          !captured ||
          execution !== captured ||
          closingPromise ||
          !context?.sessionKey ||
          captured.sessionKey !== context.sessionKey
        ) {
          throw new Error(
            "COMPUTER_INVALID_RESOURCE: current provider execution owner is required; refresh recording state",
          );
        }
      };
      assertCurrent();
      if (!captured) {
        throw new Error("COMPUTER_INVALID_RESOURCE: no provider execution");
      }
      const opened = await captured.promise;
      assertCurrent();
      if (!opened.readResource) {
        throw new Error("COMPUTER_RESOURCE_UNAVAILABLE: provider does not export resource bytes");
      }
      const result = await opened.readResource(
        value.resourceHandle,
        value.maxBytes,
        context?.signal,
      );
      assertCurrent();
      return result;
    },
  });
  // The provider plugin must also register its dangerous `computer.act` invoke
  // policy with the full plugin API. Forgetting it fails closed: the Gateway
  // rejects dangerous plugin commands that lack a registered policy.
}
