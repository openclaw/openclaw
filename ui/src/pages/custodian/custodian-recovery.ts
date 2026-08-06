import type { SystemAgentChatResult } from "@openclaw/gateway-protocol";
import type { GatewayBrowserClient } from "../../api/gateway.ts";

const STORAGE_PREFIX = "openclaw.custodian.recovery.v1:";

type CustodianRecovery = {
  sessionId: string;
};

function storageKey(gatewayUrl: string, recoveryScope: string): string {
  return `${STORAGE_PREFIX}${gatewayUrl}:${recoveryScope}`;
}

function validScope(gatewayUrl: string, recoveryScope: string): boolean {
  return gatewayUrl.trim().length > 0 && recoveryScope.trim().length > 0;
}

function clientScope(
  client: GatewayBrowserClient,
  gatewayUrl: string,
): { gatewayUrl: string; recoveryScope: string } | null {
  const normalizedGatewayUrl = gatewayUrl.trim();
  const recoveryScope = client.recoveryScopeReady ? (client.recoveryScope?.trim() ?? "") : "";
  return normalizedGatewayUrl && recoveryScope
    ? { gatewayUrl: normalizedGatewayUrl, recoveryScope }
    : null;
}

export function readCustodianRecoveryForClient(
  client: GatewayBrowserClient,
  gatewayUrl: string,
): CustodianRecovery | null {
  const scope = clientScope(client, gatewayUrl);
  return scope ? readCustodianRecovery(scope.gatewayUrl, scope.recoveryScope) : null;
}

export function clearCustodianRecoveryForClient(
  client: GatewayBrowserClient,
  gatewayUrl: string,
  expectedSessionId?: string,
): void {
  const scope = clientScope(client, gatewayUrl);
  if (scope) {
    clearCustodianRecovery(scope.gatewayUrl, scope.recoveryScope, expectedSessionId);
  }
}

export function reconcileCustodianRecoveryForClient(
  client: GatewayBrowserClient,
  gatewayUrl: string,
  result: SystemAgentChatResult,
  requestSessionId: string,
): void {
  const scope = clientScope(client, gatewayUrl);
  if (!scope) {
    return;
  }
  if (result.wizardInputPending === true && result.step) {
    writeCustodianRecovery({ ...scope, sessionId: result.sessionId });
    return;
  }
  clearCustodianRecovery(scope.gatewayUrl, scope.recoveryScope, requestSessionId);
}

function readCustodianRecovery(
  gatewayUrl: string,
  recoveryScope: string,
): CustodianRecovery | null {
  if (!validScope(gatewayUrl, recoveryScope)) {
    return null;
  }
  const key = storageKey(gatewayUrl, recoveryScope);
  try {
    const raw = globalThis.sessionStorage?.getItem(key);
    if (!raw) {
      return null;
    }
    const value = JSON.parse(raw) as Partial<CustodianRecovery>;
    if (
      Object.keys(value).length !== 1 ||
      typeof value.sessionId !== "string" ||
      value.sessionId.trim().length === 0
    ) {
      globalThis.sessionStorage?.removeItem(key);
      return null;
    }
    return { sessionId: value.sessionId };
  } catch {
    // Storage access can be denied entirely, including cleanup attempts.
    return null;
  }
}

function writeCustodianRecovery(params: {
  gatewayUrl: string;
  recoveryScope: string;
  sessionId: string;
}): boolean {
  if (!validScope(params.gatewayUrl, params.recoveryScope) || !params.sessionId.trim()) {
    return false;
  }
  try {
    const storage = globalThis.sessionStorage;
    if (!storage) {
      return false;
    }
    const key = storageKey(params.gatewayUrl, params.recoveryScope);
    storage.setItem(key, JSON.stringify({ sessionId: params.sessionId }));
    return storage.getItem(key) !== null;
  } catch {
    return false;
  }
}

function clearCustodianRecovery(
  gatewayUrl: string,
  recoveryScope: string,
  expectedSessionId?: string,
): void {
  if (!validScope(gatewayUrl, recoveryScope)) {
    return;
  }
  try {
    const storage = globalThis.sessionStorage;
    const key = storageKey(gatewayUrl, recoveryScope);
    if (expectedSessionId) {
      const raw = storage?.getItem(key);
      if (!raw) {
        return;
      }
      const value = JSON.parse(raw) as Partial<CustodianRecovery>;
      if (value.sessionId !== expectedSessionId) {
        return;
      }
    }
    storage?.removeItem(key);
  } catch {
    // Recovery state is best-effort to remove after a wizard leaves its active step.
  }
}
