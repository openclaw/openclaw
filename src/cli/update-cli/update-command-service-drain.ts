import { randomUUID } from "node:crypto";
import type { GatewaySuspendPrepareResult } from "../../../packages/gateway-protocol/src/index.js";
import { GatewayServiceStopUnsafeError } from "../../daemon/service-inspection-error.js";
import type { GatewayServiceState } from "../../daemon/service-types.js";
import { readSystemdGatewayStopTimeout } from "../../daemon/systemd-maintenance.js";
import { resolveReadOnlyLocalGatewayAuth } from "../../gateway/call-device-auth.js";
import { callGatewayCli } from "../../gateway/call.js";
import { createConfiguredGatewayLocalProbe } from "../../gateway/local-http-probe.js";
import type { GatewayShutdownStatus } from "../../gateway/server-public.js";
import {
  GATEWAY_SERVICE_STOP_TIMEOUT_MS,
  GATEWAY_SHUTDOWN_TIMEOUT_MS,
} from "../../infra/gateway-shutdown-budget.js";
import { DEFAULT_UPDATE_STEP_TIMEOUT_MS } from "../../infra/update-run-timeouts.js";
import { resolveGatewayRestartProbeContext } from "../daemon-cli/restart-health-probe.js";
import { resolveUpdatedGatewayRestartPort } from "./update-command-service-plan.js";

/** Keep short-budget residents behind their own admission fence until stop or release. */
export async function withGatewayMaintenanceDrain<T>(
  params: {
    state: GatewayServiceState;
    timeoutMs?: number;
    assertCurrent: () => void;
    warn: (message: string) => void;
  },
  stop: () => Promise<T>,
): Promise<T> {
  const deadline = performance.now() + (params.timeoutMs ?? DEFAULT_UPDATE_STEP_TIMEOUT_MS);
  const requestId = randomUUID();
  let suspensionId: string | undefined;
  let stopped = false;
  const finish = async () => {
    const result = await stop();
    stopped = true;
    return result;
  };
  let bootId: string | undefined;
  let residentChanged = false;
  const assertResidentCurrent = () => {
    params.assertCurrent();
    if (residentChanged) {
      throw new Error("Gateway process changed during maintenance drain");
    }
  };
  let residentBudget: GatewayShutdownStatus | undefined;
  let lastObservation: GatewaySuspendPrepareResult | undefined;
  let observationError: string | undefined;
  const remaining = () => Math.max(1, deadline - performance.now());
  const connection = await (async () => {
    const { config, auth } = await resolveGatewayRestartProbeContext(params.state.env);
    const port = await resolveUpdatedGatewayRestartPort({
      config,
      serviceEnv: params.state.env,
      serviceCommand: params.state.command,
    });
    const target = await createConfiguredGatewayLocalProbe(config).resolveWebSocketTarget(port);
    const controlAuth = await resolveReadOnlyLocalGatewayAuth({
      auth,
      authNone: config.gateway?.auth?.mode === "none",
      env: params.state.env,
    });
    return { config, controlAuth, port, target };
  })().catch((error: unknown) => {
    observationError = String(error);
    return undefined;
  });
  assertResidentCurrent();
  const call = async <R>(method: string, args?: unknown): Promise<R> => {
    assertResidentCurrent();
    if (!connection?.target) {
      throw new Error(observationError ?? "Gateway TLS certificate unavailable");
    }
    const { config, controlAuth, port, target } = connection;
    let observedBootId: string | undefined;
    const result = await callGatewayCli<R>({
      method,
      params: args,
      config,
      ...controlAuth,
      serviceTargetUrl: target.url,
      localPortOverride: port,
      ignoreEnvUrlOverride: true,
      tlsFingerprint: target.tlsFingerprint,
      // The deadline bounds deferral, not the final RPC needed to observe custody.
      timeoutMs: 10_000,
      onHelloOk: (hello) => {
        observedBootId = hello.server.bootId;
      },
      assertDispatchCurrent: () => {
        assertResidentCurrent();
        if (bootId !== undefined && bootId !== observedBootId) {
          residentChanged = true;
          assertResidentCurrent();
        }
        bootId = observedBootId;
      },
    });
    assertResidentCurrent();
    return result;
  };
  let managerTimeout: number | undefined;
  let verifiedResident = false;
  try {
    managerTimeout = await readSystemdGatewayStopTimeout(params.state);
    const resident = await call<{ pid?: number; shutdownBudget?: GatewayShutdownStatus }>(
      "status",
      { includeChannelSummary: false },
    );
    if (typeof resident.pid === "number" && resident.pid === params.state.runtime?.pid) {
      residentBudget = resident.shutdownBudget;
      verifiedResident = true;
    }
  } catch (error) {
    observationError = String(error);
  }
  assertResidentCurrent();
  if ((managerTimeout ?? 0) < GATEWAY_SERVICE_STOP_TIMEOUT_MS) {
    params.warn(
      `Gateway service stop timeout is ${managerTimeout === undefined ? "unverified" : `${managerTimeout}ms`} after policy refresh; preserving operator overrides and using lifecycle drain before stopping.`,
    );
  }
  if (
    (managerTimeout ?? 0) >= GATEWAY_SERVICE_STOP_TIMEOUT_MS &&
    (residentBudget?.timeoutMs ?? 0) >= GATEWAY_SHUTDOWN_TIMEOUT_MS
  ) {
    return await finish();
  }
  try {
    while (true) {
      try {
        if (!verifiedResident) {
          const identity = await call<{ pid: number }>("system.info", {});
          if (identity.pid !== params.state.runtime?.pid) {
            residentChanged = true;
            assertResidentCurrent();
          }
          verifiedResident = true;
        }
        // Repeated prepare renews the lease and asks the same lifecycle owner to
        // observe all admitted work, including write custody, under its fence.
        lastObservation = await call<GatewaySuspendPrepareResult>("gateway.suspend.prepare", {
          requestId,
          drain: true,
          terminalPolicy: "terminate",
        });
        if (lastObservation.status !== "busy") {
          suspensionId = lastObservation.suspensionId;
        }
        observationError = undefined;
      } catch (error) {
        assertResidentCurrent();
        observationError = String(error);
      }
      assertResidentCurrent();
      if (!observationError && lastObservation?.status === "ready") {
        return await finish();
      }
      if (performance.now() >= deadline) {
        const custody = observationError ? undefined : lastObservation?.writeCustody;
        const held = custody?.filter(({ count }) => count > 0);
        if (held?.length) {
          throw new GatewayServiceStopUnsafeError(
            `Gateway maintenance stop refused: data at risk in owner phase ${held.map(({ phase, count }) => `${phase} (${count})`).join(", ")}. The update drain deadline expired; the Gateway was not stopped.`,
          );
        }
        const budget = residentBudget ? `${residentBudget.timeoutMs}ms` : "unknown";
        const work =
          lastObservation?.blockers
            .map(({ kind, count, message }) => `${kind}=${count} (${message})`)
            .join(", ") || "admitted work";
        const roots = lastObservation
          ? (lastObservation.blockers.find(({ kind }) => kind === "root-request")?.count ?? 0)
          : (residentBudget?.activeWork?.rootRequests ?? "unknown");
        const cron = lastObservation
          ? (lastObservation.blockers.find(({ kind }) => kind === "cron-run")?.count ?? 0)
          : (residentBudget?.activeWork?.cronRuns ?? "unknown");
        const custodyNotice =
          custody === undefined
            ? `The resident build cannot distinguish migrations/backups from ordinary work in this observation.${observationError ? ` Current lifecycle observation unavailable (${observationError}).` : ""}`
            : "No lifecycle write custody was reported.";
        const next =
          (managerTimeout ?? 0) >= GATEWAY_SERVICE_STOP_TIMEOUT_MS
            ? `the next Gateway starts with a ${GATEWAY_SERVICE_STOP_TIMEOUT_MS / 1_000}s service stop budget`
            : `the next Gateway requires ${GATEWAY_SERVICE_STOP_TIMEOUT_MS / 1_000}s, but the effective service timeout remains ${managerTimeout === undefined ? "unknown" : `${managerTimeout}ms`}`;
        params.warn(
          `WARNING: Gateway maintenance drain deadline reached: resident shutdown budget ${budget}; latest root-request=${roots}, cron-run=${cron}; stopping with ${work}. In-flight work may be interrupted. ${custodyNotice} ${next}.`,
        );
        return await finish();
      }
      await new Promise<void>((resolve) => {
        setTimeout(
          resolve,
          Math.min(
            lastObservation && lastObservation.status !== "ready"
              ? lastObservation.retryAfterMs
              : 1_000,
            remaining(),
          ),
        );
      });
    }
  } finally {
    if (suspensionId && !stopped) {
      // A successful stop ends the lease with the process. On refusal or a failed
      // stop, resume only the exact resident and token this invocation prepared.
      await call("gateway.suspend.resume", { suspensionId }).catch(() => undefined);
    }
  }
}
