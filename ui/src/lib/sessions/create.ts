import type { GatewayBrowserClient } from "../../api/gateway.ts";

export type SessionCreateParams = {
  agentId?: string;
  currentSessionKey?: string;
  label?: string;
  model?: string;
};

export function resolveSessionCreateParams(sessionKey = "", agentId?: string) {
  const normalizedSessionKey = sessionKey.trim();
  const parentSessionKey =
    normalizedSessionKey && normalizedSessionKey.toLowerCase() !== "unknown"
      ? normalizedSessionKey
      : undefined;
  return {
    ...(agentId?.trim() ? { agentId: agentId.trim() } : {}),
    ...(parentSessionKey ? { parentSessionKey, emitCommandHooks: true } : {}),
  };
}

export async function requestSessionCreate(
  client: Pick<GatewayBrowserClient, "request">,
  params: Omit<SessionCreateParams, "currentSessionKey"> & {
    parentSessionKey?: string;
    emitCommandHooks?: boolean;
  } = {},
): Promise<string> {
  const result = await client.request<{ key?: unknown }>("sessions.create", params);
  const key = typeof result?.key === "string" ? result.key.trim() : "";
  if (!key) {
    throw new Error("sessions.create returned no key");
  }
  return key;
}
