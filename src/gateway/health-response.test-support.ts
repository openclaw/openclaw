import type {
  GatewaySuspendPrepareResult,
  GatewaySuspendResumeResult,
} from "../../packages/gateway-protocol/src/index.js";
import type { ExecResult } from "../daemon/exec-file.js";
import { GATEWAY_SERVICE_STOP_TIMEOUT_MS } from "../infra/gateway-shutdown-budget.js";
import type { CallGatewayOptions } from "./call.js";
import { buildMinimalGatewayHelloOkPayload } from "./minimal-gateway.test-helpers.js";

export function gatewayHealthResponse(
  params: {
    server?: Partial<Parameters<NonNullable<CallGatewayOptions["onHelloOk"]>>[0]["server"]>;
    health?: unknown;
    error?: Error;
  } = {},
) {
  return async (opts: CallGatewayOptions): Promise<unknown> => {
    const hello = buildMinimalGatewayHelloOkPayload();
    opts.onHelloOk?.({
      ...hello,
      type: "hello-ok",
      server: { ...hello.server, ...params.server },
      auth: { role: "operator", scopes: ["operator.read"] },
      snapshot: { presence: [], health: {}, stateVersion: { presence: 0, health: 0 }, uptimeMs: 0 },
    });
    if (params.error) {
      throw params.error;
    }
    return params.health ?? { ok: true };
  };
}

/** An idle synthetic resident, observed through the same boundary as a real Gateway. */
export function gatewayMaintenanceResponse(getResident: () => { pid: number } | undefined) {
  return async (opts: CallGatewayOptions): Promise<unknown> => {
    const resident = getResident();
    if (!resident) {
      throw new Error(`No synthetic resident for Gateway request ${opts.method}`);
    }
    const hello = buildMinimalGatewayHelloOkPayload();
    // Observe hello before revalidating dispatch authority.
    opts.onHelloOk?.({
      ...hello,
      type: "hello-ok",
      server: { ...hello.server, bootId: `synthetic-maintenance-${resident.pid}` },
      auth: { role: "operator", scopes: ["operator.admin"] },
      snapshot: { presence: [], health: {}, stateVersion: { presence: 0, health: 0 }, uptimeMs: 0 },
    });
    opts.assertDispatchCurrent?.();
    if (opts.method === "status" || opts.method === "system.info") {
      // Missing recorded budget still resolves through a fresh idle suspension.
      return { pid: resident.pid };
    }
    if (opts.method === "gateway.suspend.prepare") {
      return {
        status: "ready",
        suspensionId: `synthetic-maintenance-${resident.pid}`,
        expiresAtMs: Date.now() + 60_000,
        activeCount: 0,
        blockers: [],
        writeCustody: [],
      } satisfies GatewaySuspendPrepareResult;
    }
    if (opts.method === "gateway.suspend.resume") {
      return { ok: true, status: "running", resumed: true } satisfies GatewaySuspendResumeResult;
    }
    throw new Error(`Unexpected synthetic maintenance request: ${opts.method}`);
  };
}

/** Native policy reads must stay with the fixture instead of probing the host manager. */
export async function gatewayMaintenanceSystemdShow(
  ...[_env, args, _timeoutMs, assertCurrent]: Parameters<
    typeof import("../daemon/systemd-exec.js").execSystemctlUser
  >
): Promise<ExecResult> {
  assertCurrent?.();
  if (
    args.length !== 5 ||
    args[0] !== "show" ||
    !args[1]?.endsWith(".service") ||
    args[2] !== "--no-page" ||
    args[3] !== "--property" ||
    args[4] !== "LoadState,TimeoutStopUSec"
  ) {
    throw new Error(`Unexpected synthetic systemd policy query: ${args.join(" ")}`);
  }
  return {
    code: 0,
    termination: "exit",
    stdout: `LoadState=loaded\nTimeoutStopUSec=${GATEWAY_SERVICE_STOP_TIMEOUT_MS / 1_000}s\n`,
    stderr: "",
  };
}
