import { GATEWAY_SERVICE_STOP_TIMEOUT_MS } from "../infra/gateway-shutdown-budget.js";
import { sleep } from "../utils.js";
import { resolveTaskName } from "./schtasks-layout.js";
import { resolveScheduledTaskGatewayOwnership, waitForProcessExit } from "./schtasks-process.js";
import { retryScheduledTaskLeaseRead } from "./schtasks-sqlite.js";
import { probeScheduledTaskState } from "./schtasks-state-probe.js";
import type { GatewayServiceEnv } from "./service-types.js";
import { assertGatewayServiceUpdateCurrent } from "./service-update-authority.js";

/** Ask the process owner to drain before falling back to Task Scheduler termination. */
export async function endScheduledTaskGateway(params: {
  env: GatewayServiceEnv;
  context: { port: number | null; probeHosts: readonly string[] } | null;
  end: () => Promise<void>;
  onGracefulStop: () => void;
  assertCurrent?: () => void;
}): Promise<void> {
  if (process.platform !== "win32" || !params.context?.port) {
    await params.end();
    return;
  }
  const ownership = await resolveScheduledTaskGatewayOwnership(params.env, params.context);
  const exclusion = ownership?.acquireTerminationExclusion();
  try {
    const owner = ownership?.owner;
    if (owner && ownership.pids.includes(owner.pid)) {
      const assertCurrent = () => {
        assertGatewayServiceUpdateCurrent();
        params.assertCurrent?.();
        ownership.assertOwnerCurrent(owner.pid);
      };
      let accepted = false;
      let dispatched = false;
      try {
        const { readGatewayDispatchConfig } = await import("../config/gateway-dispatch-config.js");
        const { resolveGatewayProbeCredentialsFromConfig } =
          await import("../gateway/credentials.js");
        const { resolveReadOnlyLocalGatewayAuth } = await import("../gateway/call-device-auth.js");
        const { callGatewayCli } = await import("../gateway/call.js");
        const { createConfiguredGatewayLocalProbe } =
          await import("../gateway/local-http-probe.js");
        const config = readGatewayDispatchConfig({ env: ownership.env });
        const target = await createConfiguredGatewayLocalProbe(config).resolveWebSocketTarget(
          owner.port,
        );
        if (!target) {
          throw new Error("Gateway TLS certificate unavailable");
        }
        const auth = await resolveReadOnlyLocalGatewayAuth({
          auth: resolveGatewayProbeCredentialsFromConfig({
            cfg: config,
            env: ownership.env,
            mode: "local",
          }),
          authNone: config.gateway?.auth?.mode === "none",
          env: ownership.env,
        });
        const result = await callGatewayCli<{ ok: boolean; pid: number; status: string }>({
          config,
          ...auth,
          method: "gateway.stop.request",
          params: { target: { pid: owner.pid, ownerId: owner.owner, port: owner.port } },
          localPortOverride: owner.port,
          tlsFingerprint: target.tlsFingerprint,
          ignoreEnvUrlOverride: true,
          requiredMethods: ["gateway.stop.request"],
          timeoutMs: 10_000,
          assertDispatchCurrent: () => {
            assertCurrent();
            dispatched = true;
          },
        });
        accepted = result.ok && result.pid === owner.pid && result.status === "scheduled";
      } catch {
        // Published Gateways without this method and unresponsive hosts retain native stop.
        params.assertCurrent?.();
      }
      if (accepted || dispatched) {
        if (accepted) {
          params.onGracefulStop();
        }
        if (await waitForProcessExit(owner.pid, GATEWAY_SERVICE_STOP_TIMEOUT_MS)) {
          // /Run can be ignored while the supervisor is still joining descendants.
          const deadline = Date.now() + 15_000;
          do {
            const task = probeScheduledTaskState(resolveTaskName(params.env));
            if (task.status === "found" && (task.state === 1 || task.state === 3)) {
              if (!accepted) {
                params.onGracefulStop();
              }
              return;
            }
            await sleep(100);
          } while (Date.now() < deadline);
        }
      }
      // RPC failure cannot turn a transferred owner into permission to end the task.
      if (!(await waitForProcessExit(owner.pid, 0))) {
        await retryScheduledTaskLeaseRead(() => ownership.assertOwnerCurrent(owner.pid));
      }
    }
    const current = await resolveScheduledTaskGatewayOwnership(params.env, params.context);
    if (
      (current?.owner && current.owner.owner !== ownership?.owner?.owner) ||
      current?.pids.some((pid) => !ownership?.pids.includes(pid))
    ) {
      throw new Error("Gateway owner changed before ending the Scheduled Task");
    }
    // An absent/dead owner needs physical exclusion so startup cannot replace it
    // between the last inspection and task-name termination.
    const currentExclusion = exclusion ? null : current?.acquireTerminationExclusion();
    try {
      for (const pid of current?.pids ?? []) {
        current?.assertOwnerCurrent(pid);
      }
      await params.end();
    } finally {
      currentExclusion?.release();
    }
    // Do not open the lease database while a terminated owner is still exiting.
    for (const pid of ownership?.pids ?? []) {
      await waitForProcessExit(pid, 15_000);
    }
  } finally {
    exclusion?.release();
  }
}
