import {
  type DeviceAuthEntry,
  normalizeDeviceAuthRole,
  normalizeDeviceAuthScopes,
} from "../shared/device-auth.js";
import type { ClientTokenRecord } from "./client-credential-store.js";

export type DeviceAuthTokenObservation = {
  entry: DeviceAuthEntry | null;
  expectedToken: string | null;
};
type DeviceAuthRow = Pick<ClientTokenRecord, "token" | "role" | "scopes_json" | "updated_at_ms">;

export function deviceAuthEntryFromRow(row: DeviceAuthRow): DeviceAuthEntry | null {
  try {
    const scopes = JSON.parse(row.scopes_json) as unknown;
    if (!Array.isArray(scopes)) {
      return null;
    }
    return {
      token: row.token,
      role: row.role,
      scopes: normalizeDeviceAuthScopes(scopes),
      updatedAtMs: row.updated_at_ms,
    };
  } catch {
    return null;
  }
}

export function createDeviceAuthEntry(params: {
  role: string;
  token: string;
  scopes?: string[];
  updatedAtMs?: number;
}): DeviceAuthEntry {
  return {
    token: params.token,
    role: normalizeDeviceAuthRole(params.role),
    scopes: normalizeDeviceAuthScopes(params.scopes),
    updatedAtMs: params.updatedAtMs ?? Date.now(),
  };
}
