import { err, ok, type Result } from "@openclaw/normalization-core/result";
import type { ModelCatalogSnapshot } from "../../agents/model-catalog.js";
import { getOrCreatePromise } from "../../shared/lazy-promise.js";
import { prepareSessionsPatchEntry, projectSessionsPatchEntry } from "../sessions-patch.js";
import type { SessionPatchDiagnostics } from "./sessions-patch-diagnostics.js";
import {
  prepareSessionPatchAuthProfileProvider,
  prepareSessionPatchRuntimeMetadata,
} from "./sessions-patch-model-selection.js";

export type SessionPatchCatalogResult = Result<ModelCatalogSnapshot, unknown>;

export function createSessionPatchCatalogPreparation(
  loadCatalog: (agentId: string) => Promise<ModelCatalogSnapshot>,
  diagnostics?: SessionPatchDiagnostics,
) {
  const preparations = new Map<string, Promise<SessionPatchCatalogResult>>();
  const authProviders = new Map<
    string,
    ReturnType<typeof prepareSessionPatchAuthProfileProvider>
  >();
  const prepareAuthProvider = (projection: Parameters<typeof projectSessionsPatchEntry>[0]) =>
    getOrCreatePromise(
      authProviders,
      JSON.stringify([projection.agentId, projection.existingEntry?.authProfileOverride]),
      () => prepareSessionPatchAuthProfileProvider(projection),
    );
  const prepare = (agentId: string) =>
    getOrCreatePromise(preparations, agentId, async () => {
      const timing = diagnostics?.scope("catalog");
      try {
        return ok(await loadCatalog(agentId));
      } catch (error) {
        return err(error);
      } finally {
        timing?.finish();
      }
    });
  const load = async (agentId: string) => {
    const catalog = await prepare(agentId);
    if (!catalog.ok) {
      throw catalog.error;
    }
    return catalog.value;
  };
  return {
    prepare,
    load,
    available: async (agentId: string) => {
      const catalog = await preparations.get(agentId);
      // A fresh row may no longer need a failed preparation. Required failures
      // belong at projection use; a committed response consumes available facts.
      return catalog?.ok ? catalog.value : undefined;
    },
    project: async (params: {
      agentId: string;
      mode: "prepare" | "ordered";
      catalog?: SessionPatchCatalogResult;
      projection: Parameters<typeof projectSessionsPatchEntry>[0];
    }): Promise<
      | { kind: "model-catalog" }
      | { kind: "complete"; result: Awaited<ReturnType<typeof projectSessionsPatchEntry>> }
    > => {
      if (params.mode === "ordered") {
        return {
          kind: "complete",
          result: await projectSessionsPatchEntry({
            ...params.projection,
            preparedAuthProfileProvider: await prepareAuthProvider(params.projection),
            loadGatewayModelCatalogSnapshot: () => load(params.agentId),
          }),
        };
      }
      const projection = await prepareSessionsPatchEntry({
        ...params.projection,
        runtimeMetadataSnapshot: await prepareSessionPatchRuntimeMetadata(params.projection),
        preparedAuthProfileProvider: await prepareAuthProvider(params.projection),
      });
      if (projection.kind === "complete") {
        return projection;
      }
      if (!params.catalog) {
        return { kind: "model-catalog" };
      }
      if (!params.catalog.ok) {
        throw params.catalog.error;
      }
      return { kind: "complete", result: projection.finish(params.catalog.value) };
    },
  };
}
