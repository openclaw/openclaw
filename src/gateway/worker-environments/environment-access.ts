import { normalizeCloudRepo } from "../../config/cloud-worker-project-profiles.js";
import type { OpenClawConfig } from "../../config/types.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { withTimeout } from "../../infra/fs-safe.js";
import type { WorkerProvider } from "../../plugins/types.js";
import { createLazyPromise } from "../../shared/lazy-promise.js";
import { sameWorkerBuild } from "../../worker/worker-build-identity.js";
import type { NodeWorkerProcessInput } from "../../worker/worker-process-observation.js";
import type { DesktopObserveRequester } from "../desktop/observe-requester.js";
import { StaleWorkerBuildError, type ExpectedWorkerBuild } from "./admission.js";
import { workerEnvironmentServiceError as serviceError } from "./environment-errors.js";
import type { WorkerNodeDesktopCarrier } from "./node-desktop-carrier.js";
import type { NodeWorkerTunnelManager } from "./node-worker-tunnel.js";
import { readWorkerProjectPreparation } from "./preparation-identity.js";
import { readWorkerProjectSnapshot } from "./project-preparation.js";
import type { WorkerProviderLifecycleInputOptions } from "./provider-lifecycle.types.js";
import { WorkerRuntimeRefreshPendingError } from "./provider-runtime-refresh.js";
import { prepareRepositoryWorkerProjectSource } from "./repository-project-admission.js";
import type { WorkerDesktopLaunchResult, WorkerDesktopObserveResult } from "./service-contract.js";
import type { WorkerEnvironmentRecord, WorkerEnvironmentStore } from "./store.js";
import {
  joinWorkerTunnelStops,
  type WorkerTunnelRequest,
  type WorkerTunnelStopReason,
} from "./tunnel-contract.js";
import type { WorkerTunnelHandle, WorkerTunnelManager } from "./tunnel.js";
import { boundedWorkerError as boundedError } from "./worker-error.js";

const TUNNEL_START_TIMEOUT_MS = 3 * 60_000;

export type WorkerEnvironmentNodeTunnel = Pick<
  NodeWorkerTunnelManager,
  "status" | "start" | "stop" | "stopAll" | "observeProcesses"
>;

/** Lease teardown joins every transport sharing that environment owner. */
export function createWorkerEnvironmentTransportLifecycle(options: {
  tunnelManager?: WorkerTunnelManager;
  nodeTunnelManager?: Pick<NodeWorkerTunnelManager, "stop">;
  nodeDesktopCarrier?: WorkerNodeDesktopCarrier;
  nodePortalCarrier?: import("./portal-node-carrier.js").WorkerNodePortalCarrier;
  closeWorkerPortals?: (environmentId: string, ownerEpoch?: number) => Promise<void>;
  closeEnvironmentComputers?: (environmentId: string, ownerEpoch?: number) => Promise<void>;
}) {
  if (
    !options.tunnelManager &&
    !options.nodeTunnelManager &&
    !options.nodeDesktopCarrier &&
    !options.nodePortalCarrier
  ) {
    return undefined;
  }
  return {
    stop: async (environmentId: string, ownerEpoch?: number, reason?: WorkerTunnelStopReason) => {
      await joinWorkerTunnelStops([
        options.tunnelManager?.stop(environmentId, ownerEpoch),
        options.nodeTunnelManager?.stop(environmentId, ownerEpoch, reason),
        options.nodeDesktopCarrier?.stop(environmentId, ownerEpoch),
        options.nodePortalCarrier?.stop(environmentId, ownerEpoch),
        options.closeWorkerPortals?.(environmentId, ownerEpoch),
        options.closeEnvironmentComputers?.(environmentId, ownerEpoch),
      ]);
    },
  };
}

type WorkerEnvironmentAccessOptions = {
  store: WorkerEnvironmentStore;
  getCleanupError: (record: WorkerEnvironmentRecord) => string | undefined;
  getConfig: () => OpenClawConfig;
  projectNamespace?: string;
  prepareCurrentBundle: () => Promise<ExpectedWorkerBuild>;
  bindPreparedWorkspace?: WorkerProviderLifecycleInputOptions["bindPreparedWorkspace"];
  tunnelManager?: WorkerTunnelManager;
  nodeTunnelManager?: WorkerEnvironmentNodeTunnel;
  nodeDesktopCarrier?: WorkerNodeDesktopCarrier;
  now: () => number;
  identityResolverFor: (
    record: WorkerEnvironmentRecord,
    provider: WorkerProvider,
    leaseId: string,
  ) => Parameters<WorkerTunnelManager["start"]>[0]["resolveIdentity"];
  isStopping: () => boolean;
  providerFor: (providerId: string) => WorkerProvider;
  resolveProvider: WorkerProviderLifecycleInputOptions["resolveProvider"];
  withLock: <T>(environmentId: string, task: () => Promise<T>) => Promise<T>;
};

export function createWorkerEnvironmentAccess(options: WorkerEnvironmentAccessOptions) {
  const { store, now, providerFor, identityResolverFor, withLock } = options;
  const tunnels = options.tunnelManager;
  const nodeTunnels = options.nodeTunnelManager;
  const nodeDesktop = options.nodeDesktopCarrier;
  let desktopEnabled = options.getConfig().cloudWorkers?.desktop === true;
  let desktopPolicy = new AbortController();

  const requireDesktopPolicy = (operation: "observe" | "launch", policy: AbortController) => {
    if (options.getConfig().cloudWorkers?.desktop !== true) {
      throw serviceError(
        "invalid_state",
        `worker desktop ${operation} is disabled; enable the Desktop lab in Control UI Settings -> Labs (config: cloudWorkers.desktop)`,
      );
    }
    if (policy.signal.aborted) {
      throw serviceError("invalid_state", "Worker desktop policy changed; retry the request");
    }
  };

  const requireCurrentRecord = (environmentId: string) => {
    if (options.isStopping()) {
      throw serviceError("invalid_state", "Worker environment service is stopping");
    }
    const record = store.get(environmentId);
    if (!record) {
      throw serviceError("environment_not_found", `Unknown worker environment: ${environmentId}`);
    }
    return record;
  };

  const requireDesktopRecord = (environmentId: string) => {
    const record = requireCurrentRecord(environmentId);
    if (
      !["ready", "idle", "attached"].includes(record.state) ||
      record.destroyRequestedAtMs !== null ||
      !record.leaseId ||
      !record.desktop
    ) {
      throw serviceError(
        "invalid_state",
        "environment has no desktop; desktop is a warm-time capability of the profile",
      );
    }
    return { record, desktop: record.desktop, leaseId: record.leaseId };
  };

  const project = (record: WorkerEnvironmentRecord) => {
    const cleanupError = options.getCleanupError(record);
    const desktopAvailable =
      options.getConfig().cloudWorkers?.desktop === true &&
      ["ready", "idle", "attached"].includes(record.state) &&
      record.desktop !== null;
    const nodeTunnelStatus = nodeTunnels?.status(record.environmentId);
    const preparedProject = record.preparation
      ? readWorkerProjectSnapshot(record.profileSnapshot.project)
      : undefined;
    const projectLabel = preparedProject
      ? "source" in preparedProject
        ? normalizeCloudRepo(preparedProject.source.url)
        : preparedProject.label
      : undefined;
    return {
      ...record,
      ...(record.preparation && preparedProject
        ? {
            preparation: {
              ...record.preparation,
              project: {
                ...(projectLabel ? { label: projectLabel } : {}),
                baseCommit: preparedProject.baseCommit,
              },
            },
          }
        : {}),
      ...((record.state === "failed" ||
        record.state === "orphaned" ||
        (record.destroyRequestedAtMs !== null && record.state !== "destroyed")) &&
      record.lastError
        ? { error: boundedError(record.lastError) }
        : {}),
      ...(cleanupError ? { error: cleanupError } : {}),
      desktopAvailable,
      desktopApps: desktopAvailable
        ? (record.desktop?.apps?.map((app) => app.id).toSorted() ?? [])
        : [],
      tunnelStatus:
        nodeTunnelStatus && nodeTunnelStatus !== "stopped"
          ? nodeTunnelStatus
          : (tunnels?.status(record.environmentId) ?? nodeTunnelStatus ?? ("stopped" as const)),
    };
  };

  const resolveSshIdentity = async (environmentId: string) => {
    const record = store.get(environmentId);
    if (!record) {
      throw serviceError("environment_not_found", `Unknown worker environment: ${environmentId}`);
    }
    if (!record.leaseId || !record.sshEndpoint) {
      throw serviceError(
        "invalid_state",
        `Worker environment ${environmentId} has no active SSH endpoint`,
      );
    }
    const provider = providerFor(record.providerId);
    return await identityResolverFor(
      record,
      provider,
      record.leaseId,
    )(record.sshEndpoint.keyRef, {
      // Direct lookup has no tunnel; its service and exact lease own the invocation.
      assertCurrent: () => {
        if (options.isStopping()) {
          throw serviceError("invalid_state", "Worker environment service is stopping");
        }
      },
    });
  };

  const bindPreparedWorkspace = async (
    request: Parameters<NonNullable<WorkerEnvironmentAccessOptions["bindPreparedWorkspace"]>>[0],
  ) => {
    const bind = options.bindPreparedWorkspace;
    const assertCurrent = () => {
      request.signal?.throwIfAborted();
      request.assertCurrent();
      const record = requireCurrentRecord(request.environmentId);
      const preparation = readWorkerProjectPreparation(record.profileSnapshot.project);
      if (
        record.state !== "attached" ||
        record.ownerEpoch !== request.ownerEpoch ||
        record.attachedSessionIds.length !== 1 ||
        record.attachedSessionIds[0] !== request.sessionId ||
        record.destroyRequestedAtMs !== null ||
        record.sharedHost !== false ||
        preparation?.key !== request.preparationKey ||
        preparation.cacheKey !== request.cacheKey
      ) {
        throw new Error("Prepared workspace lost its exact attached environment owner");
      }
    };
    assertCurrent();
    if (!bind) {
      throw new Error("Prepared workspace node transport is unavailable");
    }
    const projectSnapshot = readWorkerProjectSnapshot(
      store.get(request.environmentId)!.profileSnapshot.project,
    );
    let repository: Awaited<ReturnType<typeof prepareRepositoryWorkerProjectSource>> | undefined;
    if (projectSnapshot && "source" in projectSnapshot) {
      if (!options.projectNamespace) {
        throw new Error("Prepared repository namespace is unavailable");
      }
      // A ready hit and resumed initial binding must prove current source access too;
      // a snapshot is reusable content, never a substitute for repository authority.
      const preparedIdentity = readWorkerProjectPreparation(
        store.get(request.environmentId)!.profileSnapshot.project,
      );
      repository = await prepareRepositoryWorkerProjectSource({
        expected: projectSnapshot,
        namespace: options.projectNamespace,
        getConfig: options.getConfig,
        assertCurrent,
        signal: request.signal,
        knownRecipe: preparedIdentity
          ? () => ({ project: projectSnapshot, setupRecipe: preparedIdentity.setupRecipe })
          : undefined,
      });
    }
    const assertBindingCurrent = () => {
      assertCurrent();
      repository?.assertCurrent();
    };
    assertBindingCurrent();
    const prepared = await bind({ ...request, assertCurrent: assertBindingCurrent });
    assertBindingCurrent();
    await repository?.revalidate(request.signal);
    assertCurrent();
    return prepared;
  };

  const startTunnel = async (request: WorkerTunnelRequest): Promise<WorkerTunnelHandle> => {
    if (options.isStopping()) {
      throw serviceError("invalid_state", "Worker environment service is stopping");
    }
    if (!tunnels && !nodeTunnels) {
      throw serviceError("invalid_state", "Worker tunnel runtime is unavailable");
    }
    // Prepare process-stable metadata outside the lock, then validate the durable
    // owner once. Credential revocation may happen while this await is pending.
    let currentBundle: ExpectedWorkerBuild;
    try {
      currentBundle = await options.prepareCurrentBundle();
    } catch {
      throw serviceError("invalid_state", "Current worker build identity is unavailable");
    }
    const { startup, stopStartup } = await withLock(request.environmentId, async () => {
      const record = requireCurrentRecord(request.environmentId);
      if (
        !["ready", "idle", "attached"].includes(record.state) ||
        record.destroyRequestedAtMs !== null ||
        !record.leaseId ||
        !record.bootstrapReceipt
      ) {
        throw serviceError("invalid_state", `Cannot start tunnel in state: ${record.state}`);
      }
      if (record.sharedHost === null) {
        throw serviceError(
          "provider_failure",
          "Worker lease isolation is not reconciled; retry after provider inspection",
        );
      }
      if (
        record.ownerEpoch === request.ownerEpoch &&
        record.lastError &&
        !sameWorkerBuild(record.bootstrapReceipt, currentBundle)
      ) {
        throw new WorkerRuntimeRefreshPendingError(boundedError(record.lastError));
      }
      const credential = store.getCredential(request.environmentId);
      if (
        record.ownerEpoch !== request.ownerEpoch ||
        !credential ||
        credential.ownerEpoch !== request.ownerEpoch
      ) {
        throw serviceError("invalid_state", "Worker tunnel owner credential is not current");
      }
      if (!sameWorkerBuild(record.bootstrapReceipt, currentBundle)) {
        throw new StaleWorkerBuildError();
      }
      request.authorize?.();
      const nodeDeviceId = record.nodeDeviceId;
      const nodeBundle =
        typeof nodeDeviceId === "string" &&
        !record.sshEndpoint &&
        record.bootstrapReceipt.installKind === "bundle";
      if (nodeBundle) {
        const sessionId = record.attachedSessionIds[0];
        if (
          !nodeTunnels ||
          !sessionId ||
          record.attachedSessionIds.length !== 1 ||
          credential.sessionId !== sessionId
        ) {
          throw serviceError("invalid_state", "Node worker tunnel runtime is unavailable");
        }
        return {
          startup: nodeTunnels.start({
            executionMode:
              record.profileSnapshot.executionMode === "remote-exec"
                ? "remote-exec"
                : "worker-turn",
            environmentId: record.environmentId,
            ownerEpoch: record.ownerEpoch,
            deviceId: nodeDeviceId,
            sessionId,
            expectedBuild: {
              bundleHash: currentBundle.bundleHash,
              openclawVersion: currentBundle.openclawVersion,
              protocolFeatures: [...currentBundle.protocolFeatures],
            },
            authorize: request.authorize,
          }),
          stopStartup: () => nodeTunnels.stop(record.environmentId, record.ownerEpoch),
        };
      }
      if (!record.sshEndpoint) {
        throw serviceError("invalid_state", "Worker environment has no supported tunnel transport");
      }
      if (!tunnels) {
        throw serviceError("invalid_state", "Worker SSH tunnel runtime is unavailable");
      }
      const provider = providerFor(record.providerId);
      // Workspace ownership is registered synchronously by the manager. Release the durable-state
      // lock while SSH identity material is prepared so drain/destroy can fence initialization.
      return {
        startup: tunnels.start({
          ...request,
          bundleHash: currentBundle.bundleHash,
          ssh: record.sshEndpoint,
          sharedHost: record.sharedHost,
          resolveIdentity: identityResolverFor(record, provider, record.leaseId),
        }),
        stopStartup: () => tunnels.stop(record.environmentId, record.ownerEpoch),
      };
    });
    const timeoutError = serviceError(
      "provider_failure",
      "Worker tunnel did not connect within 3 minutes; check that the worker is online and reachable, then retry",
    );
    try {
      return await withTimeout(startup, TUNNEL_START_TIMEOUT_MS, {
        createError: () => timeoutError,
      });
    } catch (error) {
      if (error !== timeoutError) {
        throw error;
      }
      // Stop can itself block on an unkillable transport child; detach it (rejection observed,
      // entry stays manager-tracked) so the deadline error is returned on time. Epoch-fenced
      // so a stale timed-out attempt can never tear down a newer owner's tunnel.
      void stopStartup().catch(() => undefined);
      throw timeoutError;
    }
  };

  const observeDesktop = async (request: {
    environmentId: string;
    control: boolean;
    requester?: DesktopObserveRequester;
  }): Promise<WorkerDesktopObserveResult> => {
    const stopping = options.isStopping();
    const policy = desktopPolicy;
    const assertPolicy = () => requireDesktopPolicy("observe", policy);
    assertPolicy();
    if (stopping) {
      throw serviceError("invalid_state", "Worker environment service is stopping");
    }
    const requester: DesktopObserveRequester = {
      ...request.requester,
      signal: request.requester?.signal
        ? AbortSignal.any([policy.signal, request.requester.signal])
        : policy.signal,
      isCurrent: () =>
        !policy.signal.aborted &&
        !options.isStopping() &&
        options.getConfig().cloudWorkers?.desktop === true &&
        request.requester?.isCurrent() !== false,
    };
    const prepared = await withLock(request.environmentId, async () => {
      assertPolicy();
      const { record, desktop, leaseId } = requireDesktopRecord(request.environmentId);
      // Node observation remains usable without its provisioning plugin. Missing
      // optional permission disables resizing, not the established transport.
      const canResize =
        options.resolveProvider(record.providerId)?.allowsDesktopResize === true &&
        desktop.allowsResize !== false;
      if (record.sshEndpoint) {
        if (!tunnels) {
          throw serviceError("invalid_state", "Worker SSH desktop runtime is unavailable");
        }
        return {
          canResize,
          ownerEpoch: record.ownerEpoch,
          startup: tunnels.desktop.acquire({
            environmentId: record.environmentId,
            ownerEpoch: record.ownerEpoch,
            ssh: record.sshEndpoint,
            desktop,
            resolveIdentity: identityResolverFor(record, providerFor(record.providerId), leaseId),
          }),
        };
      }
      if (record.nodeDeviceId) {
        if (!nodeDesktop) {
          throw serviceError("invalid_state", "Worker node desktop runtime is unavailable");
        }
        return {
          canResize,
          nodeStartup: nodeDesktop.observe({ record, control: request.control, requester }),
        };
      }
      throw serviceError("invalid_state", "Worker environment has no desktop transport");
    });
    const { canResize } = prepared;
    if (prepared.nodeStartup) {
      const observed = await prepared.nodeStartup;
      assertPolicy();
      return { ...observed, ...(canResize ? { canResize } : {}) };
    }
    const acquired = await prepared.startup;
    const { DESKTOP_OBSERVE_PATH, mintDesktopObserverToken } =
      await import("../desktop/observe-bridge.js");
    assertPolicy();
    const minted = mintDesktopObserverToken({
      sourceKey: request.environmentId,
      ownerEpoch: prepared.ownerEpoch,
      control: request.control,
      requester,
      attachment: acquired.attachment,
      nowMs: now(),
    });
    return {
      transport: "rfb",
      wsPath: `${DESKTOP_OBSERVE_PATH}?token=${minted.token}`,
      expiresAtMs: minted.expiresAtMs,
      control: request.control,
      ...(canResize ? { canResize } : {}),
      ...(acquired.vncPassword ? { vncPassword: acquired.vncPassword } : {}),
    };
  };

  const launchDesktopApp = async (request: {
    environmentId: string;
    app: "browser" | "terminal";
  }): Promise<WorkerDesktopLaunchResult> => {
    const stopping = options.isStopping();
    const policy = desktopPolicy;
    const assertPolicy = () => requireDesktopPolicy("launch", policy);
    assertPolicy();
    if (stopping) {
      throw serviceError("invalid_state", "Worker environment service is stopping");
    }
    const requireLaunchable = () => {
      assertPolicy();
      const { record, desktop, leaseId } = requireDesktopRecord(request.environmentId);
      const app = desktop.apps?.find((candidate) => candidate.id === request.app);
      if (!app) {
        throw serviceError(
          "desktop_app_not_found",
          `environment does not advertise desktop app: ${request.app}`,
        );
      }
      return { app, record, leaseId };
    };

    const { startup, launchEpoch } = await withLock(request.environmentId, async () => {
      const { app, record, leaseId } = requireLaunchable();
      if (record.sshEndpoint) {
        if (!tunnels) {
          throw serviceError("invalid_state", "Worker SSH desktop runtime is unavailable");
        }
        const provider = providerFor(record.providerId);
        return {
          launchEpoch: record.ownerEpoch,
          startup: tunnels.desktop.launchApp({
            environmentId: record.environmentId,
            ownerEpoch: record.ownerEpoch,
            ssh: record.sshEndpoint,
            app,
            resolveIdentity: identityResolverFor(record, provider, leaseId),
          }),
        };
      }
      if (record.nodeDeviceId) {
        if (!nodeDesktop) {
          throw serviceError("invalid_state", "Worker node desktop runtime is unavailable");
        }
        return {
          launchEpoch: record.ownerEpoch,
          startup: nodeDesktop.launchApp({ record, app }),
        };
      }
      throw serviceError("invalid_state", "Worker environment has no desktop transport");
    });
    const assertLaunchOwner = async () => {
      const { record } = requireLaunchable();
      if (record.ownerEpoch !== launchEpoch) {
        throw serviceError("invalid_state", "Worker desktop app launch owner changed");
      }
    };
    try {
      await startup;
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "unsupported_platform"
      ) {
        throw serviceError(
          "unsupported_platform",
          "desktop app launch is not supported on Windows gateway hosts",
        );
      }
      // A teardown aborts the SSH child before mutating the durable row. Wait for the
      // environment lock, then report the authoritative lifecycle state instead of a launch error.
      await withLock(request.environmentId, assertLaunchOwner);
      throw serviceError(
        "launcher_failure",
        `worker desktop ${request.app} launcher failed; verify the app is installed and retry`,
      );
    }
    await withLock(request.environmentId, assertLaunchOwner);
    return { app: request.app, status: "ready" };
  };

  const stopTunnel = async (environmentId: string, ownerEpoch?: number): Promise<void> => {
    await withLock(environmentId, async () =>
      joinWorkerTunnelStops([
        tunnels?.stop(environmentId, ownerEpoch),
        nodeTunnels?.stop(environmentId, ownerEpoch),
        nodeDesktop?.stop(environmentId, ownerEpoch),
      ]),
    );
  };

  const reconcileDesktopPolicy = async (): Promise<void> => {
    const enabled = options.getConfig().cloudWorkers?.desktop === true;
    if (enabled && desktopEnabled) {
      return;
    }
    if (enabled !== desktopEnabled) {
      desktopEnabled = enabled;
      if (enabled) {
        desktopPolicy.abort();
        desktopPolicy = new AbortController();
      }
    }
    if (!enabled) {
      desktopPolicy.abort();
      // The registry also owns host and paired-node desktops; stop only worker sources.
      await joinWorkerTunnelStops([
        ...store.list().map((record) => tunnels?.desktop.stop(record.environmentId)),
        nodeDesktop?.stopAll(),
      ]);
    }
  };

  return {
    bindPreparedWorkspace,
    get: (environmentId: string) => {
      const record = store.get(environmentId);
      return record ? project(record) : undefined;
    },
    launchDesktopApp,
    list: () => store.list().map(project),
    observeDesktop,
    project,
    reconcileDesktopPolicy,
    resolveSshIdentity,
    startTunnel,
    stopAllTunnels: () =>
      joinWorkerTunnelStops([tunnels?.stopAll(), nodeTunnels?.stopAll(), nodeDesktop?.stopAll()]),
    stopTunnel,
  };
}

/** Owns build-qualified process observation for one environment-service lifetime. */
export function createWorkerEnvironmentProcessObservation(options: {
  store: Pick<WorkerEnvironmentStore, "get">;
  prepareCurrentBundle: () => Promise<ExpectedWorkerBuild>;
  isStopping: () => boolean;
  getNodeTunnel: () => Pick<WorkerEnvironmentNodeTunnel, "observeProcesses"> | undefined;
  trackOperation: <T>(operation: Promise<T>) => Promise<T>;
}) {
  // The bundle producer owns its immutable artifact; panel refreshes only reuse its identity.
  const prepareBuild = createLazyPromise(options.prepareCurrentBundle);
  return async (
    input: Omit<NodeWorkerProcessInput, "gatewayNamespace" | "expectedBundleHash">,
    assertCurrent: () => void,
    signal?: AbortSignal,
  ) => {
    assertCurrent();
    const expected = await racePromiseWithAbortSignal(prepareBuild(), signal);
    assertCurrent();
    const record = options.store.get(input.environmentId);
    const nodeTunnel = options.getNodeTunnel();
    // An older retained worker must not receive an unknown input that would terminate its turn.
    if (
      options.isStopping() ||
      !record?.bootstrapReceipt ||
      !sameWorkerBuild(record.bootstrapReceipt, expected) ||
      !nodeTunnel?.observeProcesses
    ) {
      throw new Error(
        "Worker process inspection needs the current runtime; update or restart the session worker, then retry.",
      );
    }
    return await options.trackOperation(
      nodeTunnel.observeProcesses(
        { ...input, expectedBundleHash: expected.bundleHash },
        assertCurrent,
        signal,
      ),
    );
  };
}
