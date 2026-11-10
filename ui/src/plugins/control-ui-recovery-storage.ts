import type { ControlUiRecoveryStorageV1 } from "../../../src/plugin-sdk/control-ui.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { readOfflineStorageScope } from "../app/boot-record.ts";
import type { ApplicationGateway } from "../app/gateway.ts";
import { pluginRecoveryAccountPrefix } from "../app/plugin-recovery-storage.ts";

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
  const prefix = `${pluginRecoveryAccountPrefix(client.gatewayUrl, scope)}${JSON.stringify(pluginId)}:`;
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
