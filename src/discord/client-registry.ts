import type { Client } from "@buape/carbon";
import type { GatewayPlugin } from "@buape/carbon/gateway";

type DiscordClientEntry = {
  client: Client;
  gateway: GatewayPlugin;
};

const clientRegistry = new Map<string, DiscordClientEntry>();

function resolveAccountKey(accountId?: string): string {
  return accountId ?? "default";
}

export function registerDiscordClient(
  accountId: string | undefined,
  client: Client,
  gateway: GatewayPlugin,
): void {
  const key = resolveAccountKey(accountId);
  clientRegistry.set(key, { client, gateway });
}

export function unregisterDiscordClient(accountId?: string): void {
  const key = resolveAccountKey(accountId);
  clientRegistry.delete(key);
}

export function getDiscordGateway(accountId?: string): GatewayPlugin | undefined {
  const key = resolveAccountKey(accountId);
  return clientRegistry.get(key)?.gateway;
}

export function getDiscordClient(accountId?: string): Client | undefined {
  const key = resolveAccountKey(accountId);
  return clientRegistry.get(key)?.client;
}

export function listRegisteredDiscordAccounts(): string[] {
  return Array.from(clientRegistry.keys());
}
