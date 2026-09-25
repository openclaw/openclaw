import { expect } from "vitest";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import type { SessionEntry } from "../config/sessions.js";
import { projectSessionsPatchEntry } from "./sessions-patch.js";

export async function applySessionsPatchToStore(
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
