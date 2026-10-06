import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../../packages/gateway-protocol/src/client-info.js";
import { ADMIN_SCOPE } from "../../method-scopes.js";

/** Only a signed, approved macOS UI pairing may mint native cron management authority. */
export function admitsPairedNativeMacosAdmin(params: {
  clientId: string;
  clientMode: string;
  platform: string;
  pairedClientId?: string;
  hasVerifiedDevice: boolean;
  pairingRecordAuthorizesSession: boolean;
  role: string;
  authMethod?: string;
  scopes: readonly string[];
}): boolean {
  return (
    params.clientId === GATEWAY_CLIENT_IDS.MACOS_APP &&
    params.pairedClientId === GATEWAY_CLIENT_IDS.MACOS_APP &&
    params.clientMode === GATEWAY_CLIENT_MODES.UI &&
    (params.platform === "darwin" || /^macOS(?:\s|$)/.test(params.platform)) &&
    params.hasVerifiedDevice &&
    params.pairingRecordAuthorizesSession &&
    params.role === "operator" &&
    params.authMethod !== undefined &&
    params.authMethod !== "none" &&
    params.scopes.includes(ADMIN_SCOPE)
  );
}
