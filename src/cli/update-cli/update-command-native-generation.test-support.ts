import type { GatewayServiceRuntime } from "../../daemon/service-runtime.js";

/** Model only systemd restart-counter replies; all recovery owners and effects
 * remain the production flow in the consuming fixture. */
export function createNativeRestartCounterFixture(mode: string) {
  let reads = 0;
  return (failed: boolean): number => {
    if (mode === "auto-restart-continuous-counter-rollback") {
      return reads++;
    }
    if (mode === "auto-restart-counter-reversal") {
      return 100 - reads++;
    }
    if (
      failed &&
      (mode === "auto-restart-transient-counter-rollback" ||
        mode === "auto-restart-closing-counter-rollback")
    ) {
      return ++reads < (mode === "auto-restart-closing-counter-rollback" ? 3 : 2) ? 1 : 2;
    }
    return 1;
  };
}

/** Model replies only; no process or service operations run here. */
export function createNativeQuiescenceFixture(mode: string) {
  let reads = 0;
  return (
    failed: boolean,
    pid: number,
    observedStart = false,
  ): { settled?: true; runtime?: GatewayServiceRuntime } | undefined => {
    if (!failed) {
      return undefined;
    }
    const incomplete = (detail: string): GatewayServiceRuntime => ({
      status: "unknown",
      inspectionFailure: { code: "service-runtime-inspection-failed", detail },
    });
    if (mode === "auto-restart-after-observed-start-stopped-rollback" && observedStart) {
      // The start was durably observed, then systemd exhausts its restart burst
      // before the next native intent. Keep real recovery revision/CAS checks.
      return {
        settled: true,
        runtime: {
          status: "stopped",
          systemd: { unit: "openclaw-gateway.service", managerUid: 2001, nRestarts: 1 },
        },
      };
    }
    if (mode === "auto-restart-transient-runtime-rollback") {
      return reads++ === 0
        ? { runtime: incomplete("Native transition generation changed during the read") }
        : undefined;
    }
    if (mode === "auto-restart-between-inspections-settled-rollback") {
      // A failed supervisor exhausts its burst after one complete read frame,
      // before the recovery owner performs its next independent inspection.
      return ++reads > 3
        ? {
            settled: true,
            runtime: {
              status: "stopped",
              systemd: { unit: "openclaw-gateway.service", managerUid: 2001, nRestarts: 1 },
            },
          }
        : undefined;
    }
    if (mode === "auto-restart-between-inspections-resumed-rollback") {
      // A stopped read precedes the same supervisor's next queued attempt.
      return ++reads <= 3
        ? {
            runtime: {
              status: "stopped",
              systemd: { unit: "openclaw-gateway.service", managerUid: 2001, nRestarts: 1 },
            },
          }
        : undefined;
    }
    if (!mode.includes("-transition-")) {
      return undefined;
    }
    const boundary = mode.includes("-closing-") ? 3 : 2;
    const currentRead = ++reads;
    const reversed = (stopped: boolean) => ({
      ...(stopped ? { settled: true as const } : {}),
      runtime: {
        ...(stopped ? { status: "stopped" } : incomplete("counter-bearing incomplete query")),
        systemd: { unit: "openclaw-gateway.service", managerUid: 2001, nRestarts: 0 },
      },
    });
    if (mode.endsWith("reset-after-gap")) {
      return currentRead === 2
        ? { runtime: incomplete("gap before a counter reset") }
        : currentRead === 3
          ? reversed(true)
          : undefined;
    }
    if (currentRead !== boundary) {
      return undefined;
    }
    if (mode.includes("-transition-start-pre-")) {
      // A known failed candidate can leave its restart delay to execute the
      // next pre-start hook between complete native observation frames.
      return {
        runtime: {
          status: "unknown",
          state: "activating",
          subState: "start-pre",
          systemd: {
            unit: "openclaw-gateway.service",
            managerUid: mode.endsWith("foreign-manager") ? 2002 : 2001,
            nRestarts: mode.endsWith("counter-reversal") ? 0 : 1,
          },
        },
      };
    }
    if (mode.endsWith("stopped-counter-reversal")) {
      return reversed(true);
    }
    if (mode.endsWith("query-counter-reversal")) {
      return reversed(false);
    }
    if (mode.includes("-settled-")) {
      return {
        settled: true,
        runtime: {
          status: "stopped",
          systemd: { unit: "openclaw-gateway.service", managerUid: 2001, nRestarts: 1 },
        },
      };
    }
    if (mode.endsWith("running")) {
      return {
        runtime: {
          status: "running",
          pid,
          systemd: { unit: "openclaw-gateway.service", managerUid: 2001 },
        },
      };
    }
    return {
      runtime: {
        ...incomplete("incomplete closing query"),
        ...(mode.endsWith("foreign-manager")
          ? { systemd: { unit: "openclaw-gateway.service", managerUid: 2002 } }
          : {}),
      },
    };
  };
}

export const nativeAutoRestartModes = [
  "auto-restart-rollback",
  "auto-restart-after-observed-start-stopped-rollback",
  "auto-restart-transient-runtime-rollback",
  "auto-restart-transient-counter-rollback",
  "auto-restart-closing-counter-rollback",
  "auto-restart-overdeadline",
  "auto-restart-after-start-rollback",
  "auto-restart-stopped-rollback",
  "auto-restart-observed-stop-rollback",
  "auto-restart-retained-rollback",
  "auto-restart-collected-stop-rollback",
  "auto-restart-collected-retained-rollback",
  "auto-restart-collected-native-entry-rollback",
  "auto-restart-collected-partial-rollback",
  "auto-restart-collected-partial-unsealed-rollback",
  "auto-restart-collected-partial-unsealed-refusals-rollback",
  "auto-restart-collected-partial-refusals-rollback",
  "auto-restart-collected-partial-custody-rollback",
  "auto-restart-foreign-manager",
  "auto-restart-continuous-counter-rollback",
  "auto-restart-between-inspections-settled-rollback",
  "auto-restart-between-inspections-resumed-rollback",
  "auto-restart-counter-reversal",
  "auto-restart-transition-foreign-manager",
  "auto-restart-transition-running",
  "auto-restart-transition-settled-rollback",
  "auto-restart-closing-transition-settled-rollback",
  "auto-restart-transition-start-pre-foreign-manager",
  "auto-restart-transition-start-pre-counter-reversal",
  "auto-restart-transition-start-pre-rollback",
  "auto-restart-closing-transition-start-pre-rollback",
  "auto-restart-transition-unavailable-rollback",
  "auto-restart-closing-transition-unavailable-rollback",
  "auto-restart-transition-stopped-counter-reversal",
  "auto-restart-transition-query-counter-reversal",
  "auto-restart-transition-reset-after-gap",
  "auto-restart-unverified",
] as const;
