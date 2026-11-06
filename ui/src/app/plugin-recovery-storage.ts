import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import type { ControlUiRecoveryStorageV1 } from "../../../src/plugin-sdk/control-ui.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { readOfflineStorageScope } from "./boot-record.ts";
import type { ApplicationGateway } from "./gateway.ts";

const gatewayPrefix = (gatewayUrl: string) =>
  `openclaw.control.pluginRecovery.v1:${JSON.stringify(gatewayCredentialScope(gatewayUrl))}:`;
const accountPrefix = (gatewayUrl: string, scope: string) =>
  `${gatewayPrefix(gatewayUrl)}${JSON.stringify(scope)}:`;

/** Credential retirement removes literal drafts before another account is admitted. */
export function retirePluginRecoveryStorage(gatewayUrl: string, retainedScope?: string): void {
  const prefix = gatewayPrefix(gatewayUrl);
  const retained = retainedScope ? accountPrefix(gatewayUrl, retainedScope) : undefined;
  try {
    const storage = globalThis.sessionStorage;
    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const key = storage.key(index);
      if (key?.startsWith(prefix) && (!retained || !key.startsWith(retained))) {
        storage.removeItem(key);
      }
    }
  } catch {
    // Storage denial cannot prevent sign-out. Retired handles still fail closed.
  }
}

export function createPluginRecoveryStorage(
  gateway: ApplicationGateway,
  client: GatewayBrowserClient,
  pluginId: string,
  assertActivationCurrent: () => void,
): ControlUiRecoveryStorageV1 | null {
  const scope = readOfflineStorageScope({ client, connected: true });
  if (!scope || gateway.snapshot.phase !== "connected" || gateway.snapshot.client !== client) {
    return null;
  }
  const revision = gateway.connectionRevision;
  const prefix = `${accountPrefix(client.gatewayUrl, scope)}${JSON.stringify(pluginId)}:`;
  const assertCurrent = () => {
    assertActivationCurrent();
    if (
      gateway.connectionRevision !== revision ||
      gateway.snapshot.phase !== "connected" ||
      gateway.snapshot.client !== client ||
      readOfflineStorageScope({ client, connected: true }) !== scope
    ) {
      throw new Error("The plugin recovery account has changed. Reopen this view.");
    }
  };
  const storageKey = (key: string) => {
    assertCurrent();
    return prefix + JSON.stringify(key);
  };
  return {
    version: 1,
    assertCurrent,
    getItem: (key) => globalThis.sessionStorage.getItem(storageKey(key)),
    setItem: (key, value) => globalThis.sessionStorage.setItem(storageKey(key), value),
    removeItem: (key) => globalThis.sessionStorage.removeItem(storageKey(key)),
  };
}
