import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";

const gatewayPrefix = (gatewayUrl: string) =>
  `openclaw.control.pluginRecovery.v1:${JSON.stringify(gatewayCredentialScope(gatewayUrl))}:`;
export const pluginRecoveryAccountPrefix = (gatewayUrl: string, scope: string) =>
  `${gatewayPrefix(gatewayUrl)}${JSON.stringify(scope)}:`;

/** Credential retirement removes literal drafts before another account is admitted. */
export function retirePluginRecoveryStorage(gatewayUrl: string, retainedScope?: string): void {
  const prefix = gatewayPrefix(gatewayUrl);
  const retained = retainedScope
    ? pluginRecoveryAccountPrefix(gatewayUrl, retainedScope)
    : undefined;
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
