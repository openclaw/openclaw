import { randomUUID } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
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
  let execution: { id: string; promise: Promise<ComputerUseExecution> } | undefined;
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
    paramsJSON: string | null | undefined,
    context?: OpenClawPluginNodeHostCommandContext,
  ) => {
    const { executionId } = executionEnvelopeFromParams(paramsJSON);
    if (!executionId) {
      throw new Error("COMPUTER_INVALID_REQUEST: executionId is required");
    }
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
      execution = { id: executionId, promise: opened };
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
        const failures = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length === 1) {
          throw failures[0];
        }
        if (failures.length > 1) {
          throw new AggregateError(failures, "computer provider shutdown failed");
        }
      };
    },
    onDisconnect: async () => await closeExecution(undefined, "gateway-disconnect"),
    handle: async (paramsJSON, _io, context) => {
      const envelope = executionEnvelopeFromParams(paramsJSON);
      if (envelope.executionId) {
        return await (
          await getExecution(paramsJSON, context)
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
      return await (await getExecution(paramsJSON, context)).act(paramsJSON, context?.signal);
    },
  });
  // The provider plugin must also register its dangerous `computer.act` invoke
  // policy with the full plugin API. Forgetting it fails closed: the Gateway
  // rejects dangerous plugin commands that lack a registered policy.
}
