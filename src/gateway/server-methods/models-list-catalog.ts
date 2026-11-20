import { hasCurrentPreparedModelCatalogReplacement } from "../../agents/prepared-model-runtime.lifecycle.js";
import {
  withCurrentReadAuthority,
  type CurrentReadAuthority,
} from "../../shared/current-read-authority.js";
import { readPreparedCatalog } from "../server-model-catalog-auth.js";
import type { GatewayModelCatalogContext } from "./models-list-context.js";

/** Acquire published rows before preparing private account facts; never replay discovery. */
export async function readModelsListCatalog(
  context: GatewayModelCatalogContext,
  agentId: string,
  authority?: CurrentReadAuthority,
) {
  const read = () => readPreparedCatalog(context, agentId);
  let catalog = await withCurrentReadAuthority(authority, read);
  await withCurrentReadAuthority(authority, () => {});
  if (catalog && hasCurrentPreparedModelCatalogReplacement(catalog)) {
    // Only the exact, still-current remote replacement permits one acquisition retry.
    // Later account-preparation failures retain their original authority and never retry.
    catalog = await withCurrentReadAuthority(authority, read);
    await withCurrentReadAuthority(authority, () => {});
  }
  return catalog;
}
