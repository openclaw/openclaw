import { clearSecretsRuntimeSnapshotState } from "../secrets/runtime-state.js";
import type { closeGatewayTransports } from "./server-close-transports.js";
import type { GatewayCloseParams } from "./server-close.js";
import type { GatewayRequestEntryLifetime } from "./server-request-entry.js";
import type { prepareGatewayKernelState } from "./server-runtime-state-prepare.js";
type ReaderTransportRuntime = Pick<
  Awaited<ReturnType<typeof prepareGatewayKernelState>>,
  | "connectionWork"
  | "transportBridge"
  | "clients"
  | "authRateLimiter"
  | "browserAuthRateLimiter"
  | "nodeReapprovalCoordinator"
>;

/** Retains the existing transport and auth lifetimes after writer retirement. */
export function createGatewayReaderTransportLifetime(
  runtime: ReaderTransportRuntime,
  entries: GatewayRequestEntryLifetime,
  closeTransports: typeof closeGatewayTransports,
  getTailscaleCleanup: () => GatewayCloseParams["tailscaleCleanup"],
) {
  let retained = false;
  let retainedRuntimeConfig = false;
  const disposeAuthRateLimiter = () => {
    if (!retained) {
      runtime.authRateLimiter.dispose();
    }
    runtime.nodeReapprovalCoordinator.dispose();
  };
  const disposeBrowserAuthRateLimiter = () => {
    if (!retained) {
      runtime.browserAuthRateLimiter.dispose();
    }
  };
  return {
    get retained() {
      return retained;
    },
    retain: (value: boolean) => {
      retained = value;
    },
    joinEntries: () => (retained ? entries.waitForPendingEntries() : entries.sealAndJoin()),
    clearSecretsRuntimeSnapshot: () => {
      retainedRuntimeConfig = retained;
      clearSecretsRuntimeSnapshotState(retained ? { retainRuntimeConfig: true } : undefined);
    },
    releaseRetainedRuntimeConfig: () => {
      // Failed reader retirement can reuse an already-completed metadata close.
      if (retainedRuntimeConfig) {
        clearSecretsRuntimeSnapshotState();
        retainedRuntimeConfig = false;
      }
    },
    disposeAuthRateLimiter,
    disposeBrowserAuthRateLimiter,
    close: async () => {
      retained = false;
      runtime.connectionWork.beginClose();
      entries.beginClose();
      await runtime.connectionWork.drain();
      await entries.sealAndJoin();
      runtime.authRateLimiter.dispose();
      runtime.browserAuthRateLimiter.dispose();
      runtime.nodeReapprovalCoordinator.dispose();
      const transport = runtime.transportBridge.current();
      const warnings: string[] = [];
      await closeTransports(
        {
          clients: runtime.clients,
          wss: transport?.wss,
          httpServer: transport?.httpServer,
          httpServers: transport?.httpServers,
          tailscaleCleanup: getTailscaleCleanup(),
        },
        { reason: "Gateway reader retired", warnings },
      );
      if (warnings.length > 0) {
        throw new Error(`Gateway reader transports failed to retire: ${warnings.join(", ")}`);
      }
      clearSecretsRuntimeSnapshotState();
      retainedRuntimeConfig = false;
    },
  };
}
