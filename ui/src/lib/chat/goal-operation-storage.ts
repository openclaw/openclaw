import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import { safeParseJson } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";

// Keep cleanup in the startup graph without importing chat controllers or payload schemas.
type RecoveryOwner = [scope: string | null, generation: number];
const owners = new Map<string, RecoveryOwner>();

function gatewayPrefix(gatewayUrl: string): string {
  return `openclaw.control.goalOperation.v1:${JSON.stringify(gatewayCredentialScope(gatewayUrl))}:`;
}

export function goalOperationScopePrefix(gatewayUrl: string, recoveryScope: string): string {
  return `${gatewayPrefix(gatewayUrl)}${JSON.stringify(recoveryScope)}:`;
}

export function goalOperationStorageGeneration(gatewayUrl: string): number {
  return owners.get(gatewayPrefix(gatewayUrl))?.[1] ?? 0;
}

// The existing server receipt owner rejects the original identity after 24 hours.
export function goalOperationExpired(issuedAtMs: number): boolean {
  return issuedAtMs + 24 * 60 * 60 * 1000 <= Date.now();
}

export function retireStoredGoalOperations(gatewayUrl: string, recoveryScope?: string): void {
  const prefix = gatewayPrefix(gatewayUrl);
  // A resolved but empty scope does not identify an account; never retain its literal payloads.
  const retained = recoveryScope ? goalOperationScopePrefix(gatewayUrl, recoveryScope) : null;
  const previous: RecoveryOwner = owners.get(prefix) ?? [retained, 0];
  try {
    const storage = globalThis.sessionStorage;
    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const key = storage.key(index);
      if (!key?.startsWith(prefix)) {
        continue;
      }
      if (!retained || !key.startsWith(retained)) {
        storage.removeItem(key);
      } else {
        const value = safeParseJson(storage.getItem(key) ?? "null");
        if (value === undefined) {
          storage.setItem(key, '"invalid"');
          continue;
        }
        if (
          isRecord(value) &&
          typeof value.issuedAtMs === "number" &&
          goalOperationExpired(value.issuedAtMs)
        ) {
          // Leave only a notice, never an expired literal edit that could be sent anew.
          storage.setItem(key, '"expired"');
        }
      }
    }
  } catch {
    // Cleanup cannot prevent sign-out. Mutation admission still fails closed on storage errors.
  }
  owners.set(prefix, [retained, previous[1] + (!retained || previous[0] !== retained ? 1 : 0)]);
}
