import type {
  SessionCatalog,
  SessionCatalogShareRoute,
} from "../../../packages/gateway-protocol/src/index.js";
import type {
  SessionCatalogCreateTarget,
  SessionCatalogProvider,
} from "../../plugins/session-catalog.js";

export function catalogResult(
  provider: SessionCatalogProvider,
  shareRoute: SessionCatalogShareRoute | undefined,
  hosts: SessionCatalog["hosts"],
  error?: SessionCatalog["error"],
  createTarget?: SessionCatalogCreateTarget,
): SessionCatalog {
  return {
    id: provider.id,
    label: provider.label,
    capabilities: {
      continueSession: Boolean(provider.continueSession || provider.copyToGatewaySession),
      archive: Boolean(provider.archive),
      ...(provider.openTerminal ? { openTerminal: true } : {}),
      ...(createTarget
        ? {
            createSession: {
              model: createTarget.model,
              ...(provider.startTerminalSession ? { startTerminal: true } : {}),
            },
          }
        : {}),
      ...(provider.startTerminalSession ? { startTerminal: true } : {}),
    },
    ...(shareRoute ? { shareRoute } : {}),
    hosts,
    ...(error ? { error } : {}),
  };
}
