import type { SessionsStorageStatusResult } from "../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  isGatewayWorkAdmissionClosed,
  runWithGatewayDetachedWorkAdmission,
} from "../process/gateway-work-admission.js";

type MaintenanceStatus = SessionsStorageStatusResult["maintenance"];
type MaintenanceOwner = {
  run: () => Promise<void>;
  status: () => MaintenanceStatus;
  stop: () => Promise<void>;
};
const owners = new WeakMap<() => OpenClawConfig, MaintenanceOwner>();

function idleStatus(): MaintenanceStatus {
  return {
    running: false,
    lastStartedAt: null,
    lastCompletedAt: null,
    lastError: null,
    archivedTranscripts: 0,
    externalizedTranscripts: 0,
  };
}

/** One sweep owner per Gateway, shared by periodic and explicit maintenance. */
export function startSessionColdStorageMaintenance(params: {
  getRuntimeConfig: () => OpenClawConfig;
  onError: (message: string) => void;
}): MaintenanceOwner {
  const previous = owners.get(params.getRuntimeConfig);
  const previousDrain = previous?.stop();
  const abortController = new AbortController();
  let stopped = false;
  let inFlight: Promise<void> | undefined;
  const status = idleStatus();
  const owner: MaintenanceOwner = {
    status: () => ({ ...status }),
    run: () => {
      const config = params.getRuntimeConfig();
      if (stopped || config.session?.maintenance?.coldStorage?.enabled !== true) {
        throw new Error("Transcript cold storage is disabled");
      }
      if (inFlight) {
        return inFlight;
      }
      const assertCurrent = () => {
        if (
          stopped ||
          owners.get(params.getRuntimeConfig) !== owner ||
          params.getRuntimeConfig() !== config ||
          isGatewayWorkAdmissionClosed()
        ) {
          throw new Error(
            "Transcript archival canceled because its runtime configuration changed or the Gateway is stopping",
          );
        }
      };
      status.running = true;
      status.lastStartedAt = Date.now();
      status.lastError = null;
      status.archivedTranscripts = 0;
      status.externalizedTranscripts = 0;
      inFlight = runWithGatewayDetachedWorkAdmission(
        async () => {
          await previousDrain;
          assertCurrent();
          const { runSessionColdStorageMaintenance } =
            await import("../config/sessions/session-cold-storage.js");
          assertCurrent();
          const result = await runSessionColdStorageMaintenance({
            config,
            assertCurrent,
            onProgress: (progress) => {
              status.archivedTranscripts = progress.archivedTranscripts;
              status.externalizedTranscripts = progress.externalizedTranscripts;
            },
          });
          status.archivedTranscripts = result.archivedTranscripts;
          status.externalizedTranscripts = result.externalizedTranscripts;
        },
        "runtime:session-cold-storage",
        abortController.signal,
      )
        .catch((error: unknown) => {
          status.lastError = error instanceof Error ? error.message : String(error);
          throw error;
        })
        .finally(() => {
          status.running = false;
          status.lastCompletedAt = Date.now();
          inFlight = undefined;
        });
      return inFlight;
    },
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      abortController.abort();
      // A worker must relinquish its writer admission before database teardown.
      await inFlight?.catch(() => {});
      await previousDrain;
      if (owners.get(params.getRuntimeConfig) === owner) {
        owners.delete(params.getRuntimeConfig);
      }
    },
  };
  owners.set(params.getRuntimeConfig, owner);
  const tick = () => {
    if (
      stopped ||
      inFlight ||
      isGatewayWorkAdmissionClosed() ||
      params.getRuntimeConfig().session?.maintenance?.coldStorage?.enabled !== true
    ) {
      return;
    }
    void owner.run().catch((error: unknown) => params.onError(String(error)));
  };
  const timer = setInterval(tick, 60_000);
  timer.unref();
  tick();
  return owner;
}

export function getSessionColdStorageMaintenanceStatus(
  getRuntimeConfig: () => OpenClawConfig,
): MaintenanceStatus {
  return owners.get(getRuntimeConfig)?.status() ?? idleStatus();
}

export function requestGatewaySessionColdStorageMaintenance(
  getRuntimeConfig: () => OpenClawConfig,
): void {
  const owner = owners.get(getRuntimeConfig);
  if (!owner) {
    throw new Error("Transcript maintenance is not running; wait for Gateway startup to finish");
  }
  // The lifecycle owner records completion/errors and drains this job on shutdown.
  void owner.run().catch(() => {});
}
