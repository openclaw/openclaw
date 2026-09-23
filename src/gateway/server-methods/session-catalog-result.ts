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

export function catalogError(error: unknown): { code: string; message: string } {
  const record =
    error && typeof error === "object"
      ? (error as Record<string, unknown>) // SAFETY: Fields remain unknown and are checked below.
      : undefined;
  const recordMessage = typeof record?.message === "string" ? record.message.trim() : "";
  const fallbackMessage = typeof error === "string" ? error.trim() : "";
  return {
    code: typeof record?.code === "string" && record.code ? record.code : "catalog_error",
    message: recordMessage || fallbackMessage || "session catalog provider failed",
  };
}
