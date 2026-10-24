import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import type { ConnectParams } from "../../packages/gateway-protocol/src/index.js";
const LEGACY_NODE_HOST_DESKTOP_METADATA: Readonly<
  Record<string, { platform: string; deviceFamily: string }>
> = {
  darwin: { platform: "macos", deviceFamily: "Mac" },
  linux: { platform: "linux", deviceFamily: "Linux" },
  macos: { platform: "macos", deviceFamily: "Mac" },
  win32: { platform: "windows", deviceFamily: "Windows" },
  windows: { platform: "windows", deviceFamily: "Windows" },
};

/** Normalizes desktop aliases used by shipped node hosts. */
export function normalizeNodeHostCompatibilityMetadata(
  client: ConnectParams["client"],
): ConnectParams["client"] {
  if (client.id !== GATEWAY_CLIENT_IDS.NODE_HOST || client.mode !== GATEWAY_CLIENT_MODES.NODE) {
    return client;
  }
  if (!Object.hasOwn(LEGACY_NODE_HOST_DESKTOP_METADATA, client.platform)) {
    return client;
  }
  const metadata = LEGACY_NODE_HOST_DESKTOP_METADATA[client.platform]!;
  const deviceFamily = client.deviceFamily?.trim();
  if (deviceFamily && deviceFamily.toLowerCase() !== metadata.deviceFamily.toLowerCase()) {
    return client;
  }
  if (client.platform === metadata.platform && deviceFamily) {
    return client;
  }
  return {
    ...client,
    platform: metadata.platform,
    deviceFamily: deviceFamily || metadata.deviceFamily,
  };
}
