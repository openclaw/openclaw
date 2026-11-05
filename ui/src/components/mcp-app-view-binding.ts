import type { ApplicationContext } from "../app/context.ts";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import { hasOperatorReadAccess } from "../app/operator-access.ts";
import { boardAppDisplayKey } from "../pages/chat/session-board-app-snapshot.ts";
import type { McpAppBinding, McpAppViewElement } from "./mcp-app-view-types.ts";

export function readMcpAppBindingInputs(
  host: McpAppViewElement,
  gateway: ApplicationContext["gateway"],
) {
  return [
    gateway.snapshot.client,
    host.sessionKey,
    host.viewId,
    host.agentId,
    gateway.connectionRevision,
    gatewayPresentationScope(gateway).key,
    gateway.snapshot.phase === "connected" &&
      gateway.snapshot.hello !== null &&
      !hasOperatorReadAccess(gateway.snapshot.hello.auth ?? null),
    host.widget && boardAppDisplayKey(host.widget),
  ] as const;
}

export async function requestMcpAppBinding<T>(
  binding: McpAppBinding | null,
  gateway: ApplicationContext["gateway"],
  method: string,
  params: Record<string, unknown>,
  requestSignal: AbortSignal,
  unavailable: string,
): Promise<T> {
  requestSignal.throwIfAborted();
  if (
    !binding ||
    gateway.snapshot.phase !== "connected" ||
    gateway.snapshot.client !== binding.client ||
    !hasOperatorReadAccess(gateway.snapshot.hello?.auth ?? null) ||
    gatewayPresentationScope(gateway).key !== binding.scope
  ) {
    throw new Error(unavailable);
  }
  const { agentId: _untrustedAgent, ...operationParams } = params;
  const requestParams = {
    ...operationParams,
    sessionKey: binding.sessionKey,
    viewId: binding.viewId,
    ...(binding.agentId ? { agentId: binding.agentId } : {}),
  };
  const result = await binding.client.request<T>(method, requestParams, {
    signal: requestSignal,
  });
  requestSignal.throwIfAborted();
  return result;
}

export function resolveMcpAppBinding(
  inputs: readonly [
    McpAppBinding["client"] | null,
    string,
    string,
    string,
    number | undefined,
    number,
    boolean,
    ...unknown[],
  ],
  connected: boolean,
): McpAppBinding | null {
  const [client, sessionKey, viewId, agentId, connectionRevision, scope, denied] = inputs;
  return client && viewId && !denied && connected
    ? { client, sessionKey, viewId, agentId: agentId || undefined, connectionRevision, scope }
    : null;
}

export function isCurrentMcpAppBinding(
  binding: McpAppBinding | null,
  host: McpAppViewElement,
  gateway: ApplicationContext["gateway"],
): boolean {
  return (
    binding !== null &&
    host.sessionKey === binding.sessionKey &&
    host.viewId === binding.viewId &&
    (host.agentId || undefined) === binding.agentId &&
    gateway.snapshot.phase === "connected" &&
    gateway.snapshot.client === binding.client &&
    hasOperatorReadAccess(gateway.snapshot.hello?.auth ?? null) &&
    gateway.connectionRevision === binding.connectionRevision &&
    gatewayPresentationScope(gateway).key === binding.scope
  );
}
