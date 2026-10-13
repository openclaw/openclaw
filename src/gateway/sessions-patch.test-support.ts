// Shared Gateway patch fixtures exercise the real entry projection without persistence.
import { expect } from "vitest";
import type { SessionCreatedActor } from "../../packages/gateway-protocol/src/index.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { projectSessionsPatchEntry } from "./sessions-patch.js";

export const MAIN_SESSION_KEY = "agent:main:main";
const EMPTY_CFG = {} as OpenClawConfig;

async function applySessionsPatchToStore(
  params: Omit<
    Parameters<typeof projectSessionsPatchEntry>[0],
    "existingEntry" | "isLabelInUse"
  > & {
    store: Record<string, SessionEntry>;
    loadGatewayModelCatalog?: () => Promise<ModelCatalogEntry[]>;
  },
) {
  const load = params.loadGatewayModelCatalog;
  const projected = await projectSessionsPatchEntry({
    ...params,
    loadGatewayModelCatalogSnapshot: load
      ? async () => {
          const entries = await load();
          return { entries, routeVariants: entries };
        }
      : undefined,
    existingEntry: params.store[params.storeKey],
    isLabelInUse: (label) =>
      Object.entries(params.store).some(
        ([sessionKey, entry]) => sessionKey !== params.storeKey && entry.label === label,
      ),
  });
  if (projected.ok) {
    params.store[params.storeKey] = projected.entry;
  }
  return projected;
}

export type ApplySessionsPatchArgs = Parameters<typeof applySessionsPatchToStore>[0];

export async function runPatch(params: {
  patch: ApplySessionsPatchArgs["patch"];
  store?: Record<string, SessionEntry>;
  cfg?: OpenClawConfig;
  storeKey?: string;
  agentId?: string;
  loadGatewayModelCatalog?: ApplySessionsPatchArgs["loadGatewayModelCatalog"];
  providerAuthMetadataSnapshot?: ApplySessionsPatchArgs["providerAuthMetadataSnapshot"];
  archivedBy?: SessionCreatedActor;
}) {
  return applySessionsPatchToStore({
    cfg: params.cfg ?? EMPTY_CFG,
    store: params.store ?? {},
    storeKey: params.storeKey ?? MAIN_SESSION_KEY,
    agentId: params.agentId,
    patch: params.patch,
    loadGatewayModelCatalog: params.loadGatewayModelCatalog,
    providerAuthMetadataSnapshot: params.providerAuthMetadataSnapshot,
    archivedBy: params.archivedBy,
  });
}

export function expectPatchOk(
  result: Awaited<ReturnType<typeof applySessionsPatchToStore>>,
): SessionEntry {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.entry;
}

export function expectPatchError(
  result: Awaited<ReturnType<typeof applySessionsPatchToStore>>,
  message: string,
): void {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error(`Expected patch failure containing: ${message}`);
  }
  expect(result.error.message).toContain(message);
}

export function mainStoreEntry(overrides: Partial<SessionEntry>): Record<string, SessionEntry> {
  return {
    [MAIN_SESSION_KEY]: {
      sessionId: "sess",
      updatedAt: 1,
      ...overrides,
    } as SessionEntry,
  };
}
