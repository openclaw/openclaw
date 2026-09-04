import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";

export type HandoffProcessIdentity = { pid: number; startIdentity: string };
export type HandoffBootIdentity = { platform: string; identity: string };
export type HandoffNativeLifetime = {
  kind: "native";
  unit: string;
  scope: string;
  placement: { kind: "pending" } | { kind: "attached"; invocation: string };
};
export type ManagedHandoffLeaseAction =
  | { kind: "update" }
  | {
      kind: "triage";
      phase: "reserved" | "running" | "closing" | "closed" | "uncertain";
      lifetime: { kind: "foreground"; boot: HandoffBootIdentity } | HandoffNativeLifetime;
    };
export type ManagedHandoffPayload = {
  version: 2;
  executor: HandoffProcessIdentity;
  helper: HandoffProcessIdentity;
  action: ManagedHandoffLeaseAction;
};
export type ManagedHandoffLease = ManagedHandoffPayload & {
  key: string;
  owner: string;
  payload: string;
  updatedAt: number;
};

function keys<K extends string>(value: unknown, names: K[]): value is Record<K, unknown> {
  return (
    isRecord(value) &&
    Object.keys(value).length === names.length &&
    names.every((key) => Object.hasOwn(value, key))
  );
}

export function isManagedHandoffText(value: unknown, max = 4096): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function identity(value: unknown): value is HandoffProcessIdentity {
  return (
    keys(value, ["pid", "startIdentity"]) &&
    typeof value.pid === "number" &&
    Number.isInteger(value.pid) &&
    value.pid > 0 &&
    isManagedHandoffText(value.startIdentity, 128)
  );
}

function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)
  );
}

export function isManagedHandoffBoot(boot: unknown): boot is HandoffBootIdentity {
  return (
    keys(boot, ["platform", "identity"]) &&
    (boot.platform === "linux" || boot.platform === "darwin"
      ? uuid(boot.identity)
      : boot.platform === "win32" &&
        typeof boot.identity === "string" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/.test(boot.identity))
  );
}

function validPayload(payload: unknown): payload is ManagedHandoffPayload {
  if (
    !keys(payload, ["version", "executor", "helper", "action"]) ||
    payload.version !== 2 ||
    !identity(payload.executor) ||
    !identity(payload.helper)
  ) {
    return false;
  }
  const action = payload.action;
  if (keys(action, ["kind"]) && action.kind === "update") {
    return true;
  }
  if (
    !keys(action, ["kind", "phase", "lifetime"]) ||
    action.kind !== "triage" ||
    !["reserved", "running", "closing", "closed", "uncertain"].some(
      (phase) => phase === action.phase,
    )
  ) {
    return false;
  }
  const life = action.lifetime;
  if (
    keys(life, ["kind", "boot"]) &&
    life.kind === "foreground" &&
    isManagedHandoffBoot(life.boot)
  ) {
    return true;
  }
  if (
    !keys(life, ["kind", "unit", "scope", "placement"]) ||
    life.kind !== "native" ||
    !isManagedHandoffText(life.unit) ||
    !isManagedHandoffText(life.scope)
  ) {
    return false;
  }
  const placement = life.placement;
  if (keys(placement, ["kind"]) && placement.kind === "pending" && action.phase !== "running") {
    return true;
  }
  return (
    keys(placement, ["kind", "invocation"]) &&
    placement.kind === "attached" &&
    /^[a-f0-9]{32}$/i.test(String(placement.invocation))
  );
}

export function parseManagedHandoffPayload(value: string): ManagedHandoffPayload | null {
  try {
    const payload: unknown = JSON.parse(value);
    return validPayload(payload) ? payload : null;
  } catch {
    return null;
  }
}

export function isManagedTriageFailure(value: unknown): boolean {
  const limits: Record<string, number> = {
    phase: 120,
    error: 800,
    installationRoot: 4096,
    expectedVersion: 100,
  };
  return (
    isRecord(value) &&
    (value.kind === "update" || value.kind === "gateway-startup") &&
    (value.gateway === "verify-running" || value.gateway === "preserve") &&
    typeof value.phase === "string" &&
    typeof value.error === "string" &&
    Object.keys(value).every(
      (key) =>
        key === "kind" ||
        key === "gateway" ||
        (limits[key] && typeof value[key] === "string" && value[key].length <= limits[key]),
    )
  );
}
