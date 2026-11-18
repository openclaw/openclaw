import type {
  SessionCatalogSession,
  SessionsCatalogListResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { CatalogSessionKey } from "../../lib/sessions/catalog-key.ts";

export function catalogList(
  key: CatalogSessionKey,
  sessions: SessionCatalogSession[],
  options: {
    label?: string;
    hostLabel?: string;
    nextCursor?: string;
    capabilities?: SessionsCatalogListResult["catalogs"][number]["capabilities"];
  } = {},
): SessionsCatalogListResult {
  const host = {
    hostId: key.hostId,
    label: options.hostLabel ?? "Gateway",
    kind: "gateway" as const,
    connected: true,
    sessions,
    ...(options.nextCursor ? { nextCursor: options.nextCursor } : {}),
  };
  return {
    catalogs: [
      {
        id: key.catalogId,
        label: options.label ?? "Codex",
        capabilities: options.capabilities ?? { continueSession: true, archive: true },
        hosts: [host],
      },
    ],
  };
}
