import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AgentRunDelegatedAuthority } from "../../infra/agent-run-authority.types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { ComputerUseCapabilityDescriptor } from "../../plugins/computer-use-contract.js";
import type {
  PluginNodeHostCommandRegistration,
  PluginRegistry,
} from "../../plugins/registry-types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { parseNodeWorkerComputerInput } from "../../worker/node-computer-protocol.js";
import { computerRunOwner } from "./computer-owner.js";
import { startComputerHostProcess, type ComputerHostProcess } from "./computer-process.js";
import {
  ComputerHostFinalizationError,
  type ComputerHostCommand,
  type ComputerHostExecutionClose,
} from "./computer-protocol.js";
import type { HostDesktopService } from "./host-source.js";
import type { DesktopComputerLease } from "./managed-linux.js";

const log = createSubsystemLogger("gateway/computer");

export type GatewayComputerStatus = {
  configured: boolean;
  available: boolean;
  computerUse?: ComputerUseCapabilityDescriptor;
  error?: string;
};
type ComputerInvokeRequest = {
  command: ComputerHostCommand;
  params: Record<string, unknown>;
  generation: string;
  owner: string;
  signal?: AbortSignal;
  ownerSignal?: AbortSignal;
  assertCurrent(): void;
  timeoutMs?: number;
  idempotencyKey: string;
};
export type GatewayComputerService = {
  status(): Promise<GatewayComputerStatus>;
  invoke(request: ComputerInvokeRequest): Promise<unknown>;
  reconcileRuntimePolicy(): Promise<void>;
  close(): Promise<void>;
  revokeRunAuthority(authority: AgentRunDelegatedAuthority): void;
  preparePluginReload: (params: { changedPluginIds: ReadonlySet<string> }) => {
    drain: () => Promise<void>;
    resume: () => void;
  };
};

type HostRuntime = {
  provider: PluginNodeHostCommandRegistration;
  desktopTarget: "native" | "managed";
  prepared: Promise<ComputerUseCapabilityDescriptor>;
  process?: ComputerHostProcess;
  desktop?: DesktopComputerLease;
  closed: boolean;
  closing?: Promise<void>;
  idleTimer?: ReturnType<typeof setTimeout>;
  execution?: {
    owner: string;
    logicalId: string;
    physicalId: string;
    requests: Map<string, { input: string; result: Promise<unknown> }>;
    settled: Set<string>;
    releaseOwner: () => void;
  };
};

/** Owns the Gateway transport, while registered providers retain native action semantics. */
export function createGatewayComputerService(options: {
  getConfig(): OpenClawConfig;
  getPluginRegistry(): PluginRegistry;
  hostDesktopService?: HostDesktopService;
}): GatewayComputerService {
  let current: HostRuntime | undefined;
  let stopped = false;
  let paused = false;

  const configuredProvider = () => {
    const config = options.getConfig();
    const registry = options.getPluginRegistry();
    return registry.nodeHostCommands.find((entry) => {
      const plugin = registry.plugins.find((candidate) => candidate.id === entry.pluginId);
      return (
        entry.command.command === "computer.act" &&
        entry.command.computerUse !== undefined &&
        plugin?.enabled === true &&
        plugin.status === "loaded" &&
        config.plugins?.enabled !== false &&
        // Loading a node provider's default policy does not enable Gateway control.
        config.plugins?.entries?.[entry.pluginId]?.enabled === true
      );
    });
  };
  const configuredDesktopTarget = (): HostRuntime["desktopTarget"] => {
    const desktop = options.getConfig().desktop?.host;
    return desktop?.enabled && desktop.managed && desktop.port === undefined ? "managed" : "native";
  };
  const assertRuntime = (runtime: HostRuntime) => {
    if (
      stopped ||
      paused ||
      runtime.closed ||
      current !== runtime ||
      configuredProvider()?.command !== runtime.provider.command ||
      runtime.desktopTarget !== configuredDesktopTarget() ||
      runtime.desktop?.isCurrent() === false ||
      runtime.process?.isCurrent() === false
    ) {
      throw new Error("COMPUTER_DRIVER_UNAVAILABLE: Gateway computer generation is closed");
    }
  };
  const retire = (runtime: HostRuntime, execution?: ComputerHostExecutionClose): Promise<void> => {
    if (runtime.closing) {
      return runtime.closing;
    }
    runtime.closed = true;
    clearTimeout(runtime.idleTimer);
    runtime.closing = (async () => {
      let finalizationFailure: ComputerHostFinalizationError | undefined;
      try {
        await runtime.process?.close(execution);
      } catch (error) {
        if (!(error instanceof ComputerHostFinalizationError)) {
          throw error;
        }
        finalizationFailure = error;
      }
      runtime.desktop?.release();
      runtime.execution?.releaseOwner();
      if (current === runtime) {
        current = undefined;
      }
      if (finalizationFailure) {
        throw finalizationFailure;
      }
    })();
    void runtime.closing.catch(() => {
      runtime.closing = undefined;
    });
    return runtime.closing;
  };
  const retireForShutdown = async (runtime: HostRuntime) => {
    try {
      await retire(runtime);
    } catch (error) {
      if (!(error instanceof ComputerHostFinalizationError)) {
        throw error;
      }
      // Physical cleanup is proven; report lost finalization without blocking
      // the desktop or Gateway shutdown behind a process that has already exited.
      log.warn(error.message);
    }
  };
  const retireInBackground = (runtime: HostRuntime) => {
    void retireForShutdown(runtime).catch(() => {
      log.warn("Computer cleanup failed; retaining its desktop owner for recovery");
    });
  };
  const scheduleIdle = (runtime: HostRuntime) => {
    clearTimeout(runtime.idleTimer);
    if (runtime.closed || runtime.execution?.requests.size) {
      return;
    }
    // Match the provider's five-minute idle execution lifetime. Discovery alone
    // retains the desktop only for the ordinary observer linger period.
    runtime.idleTimer = setTimeout(
      () => retireInBackground(runtime),
      runtime.execution ? 300_000 : 60_000,
    );
    runtime.idleTimer.unref?.();
  };
  const prepare = async (): Promise<HostRuntime | undefined> => {
    if (stopped) {
      throw new Error("Gateway computer service is stopped");
    }
    if (paused) {
      throw new Error("Gateway computer provider is reloading");
    }
    const provider = configuredProvider();
    if (current) {
      if (
        current.provider.command === provider?.command &&
        current.desktopTarget === configuredDesktopTarget() &&
        !current.closed &&
        current.desktop?.isCurrent() !== false &&
        current.process?.isCurrent() !== false
      ) {
        const existing = current;
        await existing.prepared;
        assertRuntime(existing);
        return existing;
      }
      await retire(current);
      return await prepare();
    }
    if (!provider) {
      return undefined;
    }
    const prepared = createDeferredCore<ComputerUseCapabilityDescriptor>();
    const runtime: HostRuntime = {
      provider,
      desktopTarget: configuredDesktopTarget(),
      closed: false,
      prepared: prepared.promise,
    };
    current = runtime;
    const preparation = (async () => {
      let env = process.env;
      if (runtime.desktopTarget === "managed") {
        if (!options.hostDesktopService) {
          throw new Error("Managed Gateway desktop is unavailable");
        }
        runtime.desktop = await options.hostDesktopService.acquireComputer({
          onStop: () => retireForShutdown(runtime),
        });
        env = runtime.desktop.env;
      }
      assertRuntime(runtime);
      runtime.process = startComputerHostProcess({
        env,
        pluginIds: [provider.pluginId],
        assertCurrent: () => assertRuntime(runtime),
      });
      const computerUse = await runtime.process.ready;
      assertRuntime(runtime);
      return computerUse;
    })();
    void preparation.then(prepared.resolve, prepared.reject);
    try {
      await runtime.prepared;
      scheduleIdle(runtime);
      return runtime;
    } catch (error) {
      await retire(runtime);
      runtime.desktop?.release();
      throw error;
    }
  };

  return {
    async reconcileRuntimePolicy() {
      const runtime = current;
      if (runtime && runtime.desktopTarget !== configuredDesktopTarget()) {
        await retireForShutdown(runtime);
      }
    },
    preparePluginReload({ changedPluginIds }) {
      const provider = current?.provider ?? configuredProvider();
      const affected = provider !== undefined && changedPluginIds.has(provider.pluginId);
      if (affected) {
        // Fence discovery and input before the reload owner starts asynchronous draining.
        paused = true;
      }
      return {
        drain: async () => {
          if (affected && current) {
            await retireForShutdown(current);
          }
        },
        resume: () => {
          if (affected) {
            paused = false;
          }
        },
      };
    },
    async status() {
      const configured = configuredProvider() !== undefined;
      try {
        const runtime = await prepare();
        return runtime?.process
          ? { configured: true, available: true, computerUse: await runtime.prepared }
          : { configured: false, available: false };
      } catch (error) {
        return {
          configured,
          available: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    async invoke(request) {
      const isClose =
        request.command === "computer.act" && request.params.action === "__close_execution";
      const input = parseNodeWorkerComputerInput(
        JSON.stringify(
          isClose
            ? {
                operation: "close",
                executionId: request.params.executionId,
                reason: request.params.reason ?? "completion",
              }
            : {
                operation: request.command === "screen.snapshot" ? "snapshot" : "act",
                providerGeneration: request.generation,
                params: request.params,
              },
        ),
      );
      if (input.operation === "capabilities") {
        throw new Error("Invalid computer invocation");
      }
      const runtime = current;
      // An invocation can use only the generation returned by discovery. It never
      // starts a replacement desktop for a possibly completed input operation.
      if (!runtime) {
        if (isClose) {
          return { ok: true };
        }
        throw new Error("COMPUTER_STALE_OBSERVATION: refresh the Gateway computer before acting");
      }
      const computerUse = await runtime.prepared;
      const child = runtime.process;
      if (!child) {
        throw new Error("COMPUTER_STALE_OBSERVATION: Gateway computer is unavailable");
      }
      if (request.generation !== computerUse.provider.generation) {
        if (isClose) {
          return { ok: true };
        }
        throw new Error("COMPUTER_STALE_OBSERVATION: Gateway computer generation changed");
      }
      const logicalId = input.operation === "close" ? input.executionId : input.params.executionId;
      const existing = runtime.execution;
      if (existing && (existing.owner !== request.owner || existing.logicalId !== logicalId)) {
        throw new Error("COMPUTER_HOST_BUSY: another execution owns the Gateway computer");
      }
      if (input.operation === "close") {
        if (!existing) {
          return { ok: true };
        }
        await retire(runtime, { executionId: existing.physicalId, reason: input.reason });
        return { ok: true };
      }
      if (
        runtime.closed ||
        runtime.desktopTarget !== configuredDesktopTarget() ||
        !child.isCurrent() ||
        runtime.desktop?.isCurrent() === false
      ) {
        throw new Error("COMPUTER_STALE_OBSERVATION: refresh the Gateway computer before acting");
      }
      assertRuntime(runtime);
      request.assertCurrent();
      request.signal?.throwIfAborted();
      request.ownerSignal?.throwIfAborted();
      const onOwnerClosed = () => retireInBackground(runtime);
      const execution = (runtime.execution ??= {
        owner: request.owner,
        logicalId,
        physicalId: randomUUID(),
        requests: new Map(),
        settled: new Set(),
        releaseOwner: () => request.ownerSignal?.removeEventListener("abort", onOwnerClosed),
      });
      if (!existing) {
        request.ownerSignal?.addEventListener("abort", onOwnerClosed, { once: true });
      }
      const signature = JSON.stringify({ command: request.command, params: request.params });
      const pending = execution.requests.get(request.idempotencyKey);
      if (pending) {
        if (pending.input !== signature) {
          throw new Error("Computer idempotency key was reused with different input");
        }
        return await pending.result;
      }
      if (execution.settled.has(request.idempotencyKey)) {
        throw new Error("Computer request already settled; observe before issuing a new action");
      }
      clearTimeout(runtime.idleTimer);
      const result = child.invoke({
        command: request.command,
        params: { ...input.params, executionId: execution.physicalId },
        signal: request.signal,
        timeoutMs: request.timeoutMs,
        assertCurrent: () => {
          assertRuntime(runtime);
          request.assertCurrent();
        },
      });
      execution.requests.set(request.idempotencyKey, { input: signature, result });
      try {
        return await result;
      } finally {
        execution.requests.delete(request.idempotencyKey);
        execution.settled.add(request.idempotencyKey);
        scheduleIdle(runtime);
      }
    },
    async close() {
      stopped = true;
      if (current) {
        await retireForShutdown(current);
      }
    },
    revokeRunAuthority(authority) {
      const runtime = current;
      if (runtime?.execution?.owner === computerRunOwner(authority)) {
        retireInBackground(runtime);
      }
    },
  };
}
