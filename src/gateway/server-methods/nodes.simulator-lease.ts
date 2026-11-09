import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayClient } from "./client-types.js";

type SimulatorCommand = "simulator.capture" | "simulator.act";

type Lease = {
  nodeId: string;
  client: GatewayClient;
  connId: string;
  pairingGeneration: string;
  executionId: string;
  sessionId?: string;
  isClientCurrent: () => boolean;
  cleanup: (lease: Lease) => void;
  timer?: ReturnType<typeof setTimeout>;
  onAbort: () => void;
};

const leases = new Map<string, Lease>();
const LEASE_IDLE_MS = 20_000;
const MAX_FRAME_JSON_LENGTH = 8_000_000;

function release(lease: Lease): void {
  if (leases.get(lease.nodeId) !== lease) {
    return;
  }
  leases.delete(lease.nodeId);
  clearTimeout(lease.timer);
  lease.client.connectionSignal.removeEventListener("abort", lease.onAbort);
  lease.cleanup(lease);
}

function current(lease: Lease, connId: string, pairingGeneration: string): boolean {
  return (
    leases.get(lease.nodeId) === lease &&
    lease.connId === connId &&
    lease.pairingGeneration === pairingGeneration &&
    !lease.client.connectionSignal.aborted &&
    lease.client.invalidated !== true &&
    lease.isClientCurrent()
  );
}

function arm(lease: Lease): void {
  clearTimeout(lease.timer);
  lease.timer = setTimeout(() => release(lease), LEASE_IDLE_MS);
  lease.timer.unref?.();
}

export function isSimulatorCommand(command: string): command is SimulatorCommand {
  return command === "simulator.capture" || command === "simulator.act";
}

export function isSimulatorAdmissionCurrent(admission: { lease: Lease }): boolean {
  const { lease } = admission;
  return current(lease, lease.connId, lease.pairingGeneration);
}

export function abandonSimulatorAdmission(admission: { lease: Lease }): void {
  release(admission.lease);
}

/** One authenticated Gateway connection owns a Simulator session and its input scope. */
export function admitSimulatorInvoke(params: {
  nodeId: string;
  command: SimulatorCommand;
  input: unknown;
  client: GatewayClient | null | undefined;
  connId: string;
  pairingGeneration: string;
  isClientCurrent: () => boolean;
  cleanup: (lease: Lease) => void;
}): { lease: Lease; started: boolean } | { error: string } {
  const input = asOptionalObjectRecord(params.input);
  const executionId = input?.executionId;
  if (typeof executionId !== "string" || !/^[\da-f-]{36}$/iu.test(executionId)) {
    return { error: "Simulator executionId must be a UUID" };
  }
  if (!params.client || params.client.connectionSignal.aborted || !params.isClientCurrent()) {
    return { error: "Simulator viewer connection ended; reconnect and reopen the preview" };
  }
  const existing = leases.get(params.nodeId);
  if (existing && !current(existing, params.connId, params.pairingGeneration)) {
    release(existing);
  }
  const action = input?.action;
  if (params.command === "simulator.capture" && action === "start") {
    if (leases.has(params.nodeId)) {
      return {
        error: "Simulator is already controlled by another viewer; close that preview first",
      };
    }
    const client = params.client;
    const lease: Lease = {
      nodeId: params.nodeId,
      client,
      connId: params.connId,
      pairingGeneration: params.pairingGeneration,
      executionId,
      isClientCurrent: params.isClientCurrent,
      cleanup: params.cleanup,
      onAbort: () => release(lease),
    };
    leases.set(params.nodeId, lease);
    client.connectionSignal.addEventListener("abort", lease.onAbort, { once: true });
    arm(lease);
    return { lease, started: true };
  }
  const lease = leases.get(params.nodeId);
  if (
    !lease ||
    !current(lease, params.connId, params.pairingGeneration) ||
    lease.client !== params.client ||
    lease.executionId !== executionId ||
    !lease.sessionId ||
    lease.sessionId !== input?.sessionId ||
    (params.command === "simulator.capture" && action !== "read" && action !== "stop")
  ) {
    return { error: "Simulator preview session ended; reopen it to take control" };
  }
  arm(lease);
  return { lease, started: false };
}

export function completeSimulatorInvoke(
  admission: { lease: Lease; started: boolean },
  command: SimulatorCommand,
  input: unknown,
  result: { ok: boolean; payloadJSON?: string | null },
): string | undefined {
  const { lease, started } = admission;
  if (leases.get(lease.nodeId) !== lease) {
    if (started && result.ok) {
      const payload = parseSession(result.payloadJSON);
      if (payload) {
        lease.sessionId = payload;
        lease.cleanup(lease);
      }
    }
    return "Simulator viewer connection ended before the node replied";
  }
  if (!result.ok || (result.payloadJSON?.length ?? 0) > MAX_FRAME_JSON_LENGTH) {
    release(lease);
    return result.ok ? "Simulator frame exceeded the 8 MB transport limit" : undefined;
  }
  if (started) {
    const sessionId = parseSession(result.payloadJSON);
    if (!sessionId) {
      release(lease);
      return "Simulator returned no capture session; reopen the preview";
    }
    lease.sessionId = sessionId;
  }
  if (command === "simulator.capture" && asOptionalObjectRecord(input)?.action === "stop") {
    release(lease);
  }
  return undefined;
}

function parseSession(payloadJSON: string | null | undefined): string | undefined {
  if (!payloadJSON) {
    return undefined;
  }
  try {
    const sessionId = asOptionalObjectRecord(JSON.parse(payloadJSON))?.sessionId;
    return typeof sessionId === "string" ? sessionId : undefined;
  } catch {
    return undefined;
  }
}
