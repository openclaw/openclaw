import { vi } from "vitest";
import type {
  MemoryProviderHandle,
  MemoryReference,
  MemorySearchPage,
} from "../../plugins/memory-provider-types.js";
import { gatewayConnect } from "../server/client-fixtures.test-support.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

export function createMemoryOperatorClient(
  scopes: string[] = ["operator.read"],
): NonNullable<GatewayRequestHandlerOptions["client"]> {
  return {
    connId: "cli-connection",
    connect: gatewayConnect(scopes, { id: "cli", platform: "node", mode: "cli" }),
  } as NonNullable<GatewayRequestHandlerOptions["client"]>;
}

export function createMemoryProvider(
  reference: MemoryReference,
  searchResult: MemorySearchPage = { hits: [{ reference, excerpt: "A record" }] },
  pagination = false,
) {
  return {
    capabilities: { sources: ["memory"], pagination, candidates: [], projectFilter: false },
    search: vi.fn(async () => searchResult),
    get: vi.fn(async () => ({ status: "ok" as const, reference, text: "Record body" })),
    health: vi.fn(async () => ({ status: "ready" as const })),
    close: vi.fn(async () => {}),
  } satisfies MemoryProviderHandle;
}
