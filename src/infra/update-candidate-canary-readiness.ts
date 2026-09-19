import { setTimeout as sleep } from "node:timers/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  redactSupportDiagnosticLine,
  redactSupportString,
  type SupportRedactionContext,
} from "../logging/diagnostic-support-redaction.js";
import { scheduleAbsoluteDeadline } from "../utils/absolute-deadline.js";
import { formatErrorMessageWithCode } from "./errors.js";
import { getActiveManagedProxyUrl } from "./net/proxy/active-proxy-state.js";
import { registerManagedProxyGatewayLoopbackBypass } from "./net/proxy/proxy-lifecycle.js";
import { createUpdateFailureFact, type UpdateFailureFact } from "./update-failure-facts.js";

/** Poll candidate control-plane endpoints under the existing managed loopback policy. */
export async function waitForUpdateCandidateReadiness(
  params: SupportRedactionContext & {
    port: number;
    workDeadline: number;
    started: number;
    signal?: AbortSignal;
    assertCurrent?: () => void;
    hasExited: () => boolean;
    getExitReason: () => string | undefined;
    onEndpoint: (endpoint: "startupz" | "readyz") => void;
    capture: (message: string) => void;
  },
): Promise<{ fact: UpdateFailureFact; message: string } | undefined> {
  const deadline = new AbortController();
  const cancelDeadline = scheduleAbsoluteDeadline(params.workDeadline, () => deadline.abort());
  const signal = AbortSignal.any([deadline.signal, ...(params.signal ? [params.signal] : [])]);
  const assertRunning = () => {
    params.signal?.throwIfAborted();
    params.assertCurrent?.();
    if (params.hasExited()) {
      throw new Error(params.getExitReason() ?? "The updated Gateway exited before it was ready");
    }
  };
  try {
    for (const endpoint of ["startupz", "readyz"] as const) {
      params.onEndpoint(endpoint);
      const url = `http://127.0.0.1:${params.port}/${endpoint}`;
      const releaseBypass = registerManagedProxyGatewayLoopbackBypass(url);
      const proxy = releaseBypass ? undefined : getActiveManagedProxyUrl();
      let failure: { fact: UpdateFailureFact; message: string } | undefined;
      try {
        while (true) {
          assertRunning();
          if (Date.now() >= params.workDeadline) {
            if (!failure) {
              throw new Error("Update validation deadline exceeded");
            }
            params.capture(failure.message);
            return failure;
          }
          let outcome = "";
          let ready = false;
          try {
            const response = await fetch(url, { signal });
            outcome = `HTTP ${response.status}`;
            if (response.status === 200) {
              const payload: unknown = await response.json();
              ready = endpoint === "readyz" || (isRecord(payload) && payload.status === "started");
              outcome += " (startup response not ready within the validation budget)";
            } else {
              await response.body?.cancel();
            }
          } catch (error) {
            outcome = `${outcome ? `${outcome}: ` : ""}${formatErrorMessageWithCode(error)}`;
          }
          assertRunning();
          if (ready && Date.now() < params.workDeadline) {
            params.capture(
              `${endpoint}: ${endpoint === "startupz" ? "started" : "ready"} (${Date.now() - params.started}ms)`,
            );
            break;
          }
          // Keep the last observed cause when the common deadline aborts a later poll.
          if (!deadline.signal.aborted || !failure) {
            const detail = redactSupportDiagnosticLine(outcome, params);
            const nextStep = "Check Gateway logs and proxy.loopbackMode; rerun openclaw update.";
            failure = {
              message: redactSupportString(
                `Readiness probe ${url} failed: ${detail}${proxy ? ` (via proxy ${proxy.origin})` : ""}. ${nextStep}`,
                params,
              ),
              fact: createUpdateFailureFact(
                {
                  check: endpoint,
                  code: "candidate-readiness-probe-failed",
                  message: `Readiness probe ${endpoint} failed: ${detail}. ${nextStep}`,
                },
                params.env,
              ),
            };
          }
          await sleep(Math.min(100, Math.max(1, params.workDeadline - Date.now())), undefined, {
            signal: params.signal,
          });
        }
      } finally {
        releaseBypass?.();
      }
    }
    return undefined;
  } finally {
    cancelDeadline();
  }
}
