import { isGatewayLoopbackHost } from "../../packages/gateway-client/src/websocket-transport.js";
import {
  WORKER_LINEAGE_START_PROTOCOL_FEATURE,
  WORKER_NATIVE_PROCESS_OWNER_PROTOCOL_FEATURE,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { resolveRuntimeArgs } from "../infra/runtime-worker-url.js";
import {
  createChildAdapter,
  type AwaitedStdoutChildAdapter,
} from "../process/supervisor/adapters/child.js";
import { assertProcessGroupControl } from "../process/supervisor/service-child-group-ownership.js";
import { supportsNodeWorkerProcessOwner } from "../process/supervisor/service-child-protocol.js";
import { createServiceChildRelayAdapter } from "../process/supervisor/service-child-relay-host.js";
import type { SpawnSecretInput } from "../process/supervisor/types.js";
import type { WorkerLaunchDescriptor } from "../worker/launch-descriptor.js";
import {
  WORKER_NATIVE_INFERENCE_STARTUP_ARG,
  WORKER_NATIVE_INFERENCE_STARTUP_FD,
  WORKER_NATIVE_INFERENCE_STARTUP_MAX_BYTES,
} from "../worker/native-inference-startup.js";
import {
  parseNodeWorkerConnectionFailureMessage,
  type NodeWorkerLaunchInput,
} from "../worker/node-supervisor-protocol.js";
import {
  serializeWorkerProcessInput,
  type WorkerProcessInput,
} from "../worker/worker-process-protocol.js";
import {
  createNodeWorkerContainer,
  type NodeWorkerContainerEngine,
} from "./node-worker-container-engine.js";
import type { NodeWorkerContainerLifecycle } from "./node-worker-container-lifecycle.js";
import { resolveNodeWorkerEntry } from "./node-worker-entry.js";
import type { NodeWorkerCleanupMode } from "./node-worker-launch-receipt.js";
import type {
  NodeWorkerContainerIdentity,
  NodeWorkerLaunchReceipt,
  NodeWorkerLaunchStore,
} from "./node-worker-launch-store.js";
import {
  NODE_WORKER_INFERENCE_SETUP_ERROR,
  projectNodeWorkerNativeInference,
  type NodeWorkerNativeInferenceSnapshot,
} from "./node-worker-native-inference.js";
import {
  sanitizeNodeWorkerDiagnostic,
  type NodeWorkerCredentialScrubber,
} from "./node-worker-output.js";
import type { NodeWorkerProcessIdentity } from "./node-worker-process-identity.js";

export type NodeWorkerChildAdapter = AwaitedStdoutChildAdapter & {
  confirmExtinction?: () => boolean;
};

type NodeWorkerLaunchTransportOptions = {
  bundleRoot: string;
  workerEnv: NodeJS.ProcessEnv;
  nativeInferenceSnapshot?: NodeWorkerNativeInferenceSnapshot;
  engineEnv: NodeJS.ProcessEnv;
  input: NodeWorkerLaunchInput;
  descriptor: WorkerLaunchDescriptor;
  planHash: string;
  supervisor: NodeWorkerProcessIdentity;
  connectionFailure: { errorText?: string };
  scrubber: NodeWorkerCredentialScrubber;
  store: NodeWorkerLaunchStore;
  containerEngine?: NodeWorkerContainerEngine;
  containerLifecycle?: NodeWorkerContainerLifecycle;
  containerImage?: string;
};

type NodeWorkerLaunchTransport =
  | { kind: "terminal"; receipt: NodeWorkerLaunchReceipt }
  | {
      kind: "started";
      adapter: NodeWorkerChildAdapter;
      cleanupMode: NodeWorkerCleanupMode | null;
      container?: NodeWorkerContainerIdentity;
    };

/** Keep local IPC and container stdio as transport choices of one launch state machine. */
export async function prepareNodeWorkerLaunchTransport(
  options: NodeWorkerLaunchTransportOptions,
): Promise<NodeWorkerLaunchTransport> {
  // Only the trusted snapshot can grant inference custody. Never forward a
  // caller-provided carrier, including to ordinary proxied children.
  const workerEnv = { ...options.workerEnv };
  let secretInput: SpawnSecretInput | undefined;
  if (options.descriptor.assignment.inference === "runtime-local") {
    if (options.containerEngine) {
      throw new Error(
        'Worker-local inference requires nodeHost.workerRuns.isolation to be "none"; ' +
          "nested-container worker isolation is unsupported.",
      );
    }
    if (!options.nativeInferenceSnapshot) {
      throw new Error(NODE_WORKER_INFERENCE_SETUP_ERROR);
    }
    const startup = projectNodeWorkerNativeInference(
      options.nativeInferenceSnapshot,
      options.descriptor,
    );
    const encoded = JSON.stringify(startup);
    if (Buffer.byteLength(encoded) > WORKER_NATIVE_INFERENCE_STARTUP_MAX_BYTES) {
      throw new Error(
        "Worker-local inference startup data exceeds 2 MiB. Reduce the configured node models " +
          "or headers, then restart the node host.",
      );
    }
    secretInput = {
      fd: WORKER_NATIVE_INFERENCE_STARTUP_FD,
      createData: () => Buffer.from(encoded),
    };
  }
  const entry = resolveNodeWorkerEntry({
    bundleRoot: options.bundleRoot,
    expectedBundleHash: options.input.expectedBundleHash,
    gatewayNamespace: options.input.gatewayNamespace,
  });
  if (!options.containerEngine) {
    const args = [
      ...resolveRuntimeArgs(),
      entry,
      "--internal-worker-ipc",
      "--internal-worker-session",
      ...(secretInput ? [WORKER_NATIVE_INFERENCE_STARTUP_ARG] : []),
    ];
    const workerOptions = {
      env: workerEnv,
      secretInput,
      ownedWorker: true,
      stdinMode: "pipe-open",
      stdoutConsumption: "awaited",
      onWorkerMessage: (message: unknown) => {
        const diagnostic = parseNodeWorkerConnectionFailureMessage(message);
        if (!diagnostic) {
          return;
        }
        options.connectionFailure.errorText = diagnostic.cause
          ? sanitizeNodeWorkerDiagnostic(
              diagnostic.cause,
              "node worker gateway connection failed",
              options.scrubber.scrub,
            )
          : undefined;
      },
    } as const;
    // Released v2026.9.4 workers require type-only IPC and must lead their own process group.
    if (
      supportsNodeWorkerProcessOwner() &&
      options.descriptor.admission.handshake.protocolFeatures.includes(
        WORKER_LINEAGE_START_PROTOCOL_FEATURE,
      )
    ) {
      const { adapter, ready } = await createServiceChildRelayAdapter({
        ...workerOptions,
        ...(options.descriptor.admission.handshake.protocolFeatures.includes(
          WORKER_NATIVE_PROCESS_OWNER_PROTOCOL_FEATURE,
        )
          ? { nativeProcessOwnerSupported: true as const }
          : {}),
        cleanupBinding: await options.store.cleanupBinding({
          launchId: options.input.launchId,
          planHash: options.planHash,
          supervisor: options.supervisor,
        }),
        command: process.execPath,
        args,
        oomScoreWrapperSelected: false,
      });
      await ready;
      return { kind: "started", adapter, cleanupMode: adapter.treeOwnership ?? "owned-anchor" };
    }
    assertProcessGroupControl();
    const { adapter, ready } = await createChildAdapter({
      ...workerOptions,
      argv: [process.execPath, ...args],
      exactEnv: true,
    });
    await ready;
    return { kind: "started", adapter, cleanupMode: "process-group" };
  }

  const endpoint = options.descriptor.connectionEndpoint;
  if (endpoint.kind !== "websocket") {
    throw new Error("container-isolated workers require a reachable WebSocket Gateway URL");
  }
  if (isGatewayLoopbackHost(new URL(endpoint.url).hostname)) {
    throw new Error(
      "container-isolated workers cannot reach a loopback Gateway URL; connect the node host using a Gateway address reachable from its container network",
    );
  }
  if (options.descriptor.assignment.browser) {
    throw new Error(
      "container-isolated workers cannot use host browser assignments; disable browser access for isolated worker sessions",
    );
  }

  const lifecycle = options.containerLifecycle;
  if (!lifecycle) {
    throw new Error("node worker container isolation has no lifecycle owner");
  }
  let container: NodeWorkerContainerIdentity | undefined;
  try {
    container = await createNodeWorkerContainer(options.containerEngine, {
      bundleRoot: options.bundleRoot,
      bundleEntry: entry,
      workspaceDir: options.descriptor.assignment.workspaceDir,
      gatewayNamespace: options.input.gatewayNamespace,
      launchId: options.input.launchId,
      env: workerEnv,
      ...(options.containerImage ? { image: options.containerImage } : {}),
    });
    const claimed = await options.store.get(options.input.launchId);
    if (claimed?.state !== "pending") {
      await lifecycle.remove(container, options.input);
      if (!claimed) {
        throw new Error("node worker container launch lost its durable claim");
      }
      return { kind: "terminal", receipt: claimed };
    }
    const { adapter, ready } = await createChildAdapter({
      argv: [
        options.containerEngine.command,
        "start",
        "--attach",
        "--interactive",
        container.containerId,
      ],
      env: options.containerEngine.env ?? options.engineEnv,
      exactEnv: true,
      stdinMode: "pipe-open",
      stdoutConsumption: "awaited",
    });
    await ready;
    return { kind: "started", adapter, container, cleanupMode: null };
  } catch (error) {
    if (container) {
      await lifecycle.remove(container, options.input);
    }
    throw error;
  }
}

export async function sendNodeWorkerInput(
  adapter: NodeWorkerChildAdapter,
  message: WorkerProcessInput,
): Promise<void> {
  const stdin = adapter.stdin;
  if (!stdin) {
    throw new Error("node worker did not provide a writable stdin pipe");
  }
  const encoded = serializeWorkerProcessInput(message);
  await new Promise<void>((resolve, reject) => {
    stdin.write(encoded, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
