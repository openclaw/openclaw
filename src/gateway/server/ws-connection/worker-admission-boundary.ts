import type {
  WorkerConnectParams,
  WorkerProtocolCloseReason,
} from "../../../../packages/gateway-protocol/src/index.js";
import { AUTH_RATE_LIMIT_SCOPE_WORKER_ADMISSION } from "../../auth-rate-limit.js";
import { withSerializedRateLimitAttempt } from "../../rate-limit-attempt-serialization.js";
import type { WorkerConnectionIdentity } from "../../worker-environments/connection-identity.js";
import type { PublicWorkerIngressContext } from "../public-worker-ingress-context.js";
import type { WorkerConnectionService } from "./worker-connection-dispatch.js";

type WorkerAdmissionService = Pick<
  WorkerConnectionService,
  "admitWorker" | "validateWorkerConnection"
>;

type WorkerAdmissionBoundaryResult =
  | { ok: true; identity: WorkerConnectionIdentity }
  | { ok: false; reason: WorkerProtocolCloseReason | "rate-limited" | "claim-rejected" };

/** Serialize public credential checks and charge only failed admission attempts. */
export async function runWorkerAdmissionBoundary(params: {
  service: WorkerAdmissionService | undefined;
  admission: WorkerConnectParams["admission"];
  publicAdmission: PublicWorkerIngressContext;
  claim(identity: WorkerConnectionIdentity): boolean;
}): Promise<WorkerAdmissionBoundaryResult> {
  const { clientIp, rateLimiter } = params.publicAdmission;
  const run = async (): Promise<WorkerAdmissionBoundaryResult> => {
    const rateCheck = rateLimiter?.check(clientIp, AUTH_RATE_LIMIT_SCOPE_WORKER_ADMISSION);
    if (rateCheck && !rateCheck.allowed) {
      return { ok: false, reason: "rate-limited" };
    }
    const admission =
      (await params.service?.admitWorker(params.admission)) ??
      ({ ok: false, reason: "environment-unavailable" } as const);
    if (!admission.ok) {
      rateLimiter?.recordFailure(clientIp, AUTH_RATE_LIMIT_SCOPE_WORKER_ADMISSION);
      return admission;
    }
    const ownershipFailure = params.service?.validateWorkerConnection(admission.identity);
    if (ownershipFailure) {
      rateLimiter?.recordFailure(clientIp, AUTH_RATE_LIMIT_SCOPE_WORKER_ADMISSION);
      return { ok: false, reason: ownershipFailure };
    }
    if (!params.claim(admission.identity)) {
      return { ok: false, reason: "claim-rejected" };
    }
    rateLimiter?.reset(clientIp, AUTH_RATE_LIMIT_SCOPE_WORKER_ADMISSION);
    return admission;
  };

  if (!rateLimiter) {
    return await run();
  }
  return await withSerializedRateLimitAttempt({
    ip: clientIp,
    scope: AUTH_RATE_LIMIT_SCOPE_WORKER_ADMISSION,
    run,
  });
}
