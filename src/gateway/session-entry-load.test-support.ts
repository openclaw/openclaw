import { getRuntimeConfig } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { loadIncognitoGatewaySessionEntryReadOnly } from "./session-utils-store.js";

export async function loadSessionEntryAsync(
  sessionKey: string,
  opts?: Parameters<typeof loadIncognitoGatewaySessionEntryReadOnly>[1],
  cfg: OpenClawConfig = getRuntimeConfig(),
) {
  const { loadGatewaySessionEntryReadOnlyInWorker } =
    await import("./session-utils-store-worker.js");
  return loadGatewaySessionEntryReadOnlyInWorker({
    cfg,
    key: sessionKey,
    ...opts,
    excludeInternalEffects: true,
    readOnly: false,
  });
}
