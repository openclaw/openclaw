import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export type GatewayRuntimeRecoveryResult = {
  status: "restart-requested" | "report-only";
  reason: string;
};

export type GatewayNativeWorkerRecoveryRequest = { isCurrent: () => boolean };

type GatewayNativeWorkerRecovery = (
  params: GatewayNativeWorkerRecoveryRequest,
) => Promise<GatewayRuntimeRecoveryResult>;

const nativeWorkerRecovery = resolveGlobalSingleton(
  Symbol.for("openclaw.gatewayNativeWorkerRecovery"),
  (): { request?: GatewayNativeWorkerRecovery } => ({}),
);

export const reportGatewayRuntimeRecoveryOnly = (reason: string): GatewayRuntimeRecoveryResult => ({
  status: "report-only",
  reason: `Automatic runtime recovery is report-only: ${reason}`,
});

/** Worker owners retain native custody; only the registered process owner may restart. */
export function requestGatewayNativeWorkerRecovery(
  params: GatewayNativeWorkerRecoveryRequest,
): Promise<GatewayRuntimeRecoveryResult> {
  const request = nativeWorkerRecovery.request;
  if (!request) {
    return Promise.resolve(
      reportGatewayRuntimeRecoveryOnly("no Gateway process lifecycle owns recovery."),
    );
  }
  // Native retirement can outlive the request's cancelled work scope.
  return runInDetachedAsyncContext(() =>
    Promise.resolve()
      .then(() => request(params))
      .catch(() =>
        reportGatewayRuntimeRecoveryOnly(
          "service or restart preparation failed. Inspect the native worker and restart through the service owner.",
        ),
      ),
  );
}

/** Bind requests to the latest process owner without letting an earlier release clear its replacement. */
export function registerGatewayNativeWorkerRecovery(
  request: GatewayNativeWorkerRecovery,
): () => void {
  nativeWorkerRecovery.request = request;
  return () => {
    if (nativeWorkerRecovery.request === request) {
      nativeWorkerRecovery.request = undefined;
    }
  };
}
