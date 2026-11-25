import { err, ok, type Result } from "@openclaw/normalization-core/result";
import type { ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import { getOrCreatePromise } from "../../shared/lazy-promise.js";
import {
  isAgentSessionModelPatchOrigin,
  isSessionStatusModelPatchOrigin,
} from "../session-model-patch-origin.js";
import { prepareSessionsPatchEntry, projectSessionsPatchEntry } from "../sessions-patch.js";
import { readWorkerPlacementIdentity } from "../worker-environments/placement-projector.js";
import { readSessionWorkerPlacementAsync } from "../worker-environments/session-placement-lifecycle.js";
import type { SessionPatchDiagnostics } from "./sessions-patch-diagnostics.js";
import {
  alternateSessionModelRoutes,
  prepareSessionPatchRuntimeSelection,
} from "./sessions-patch-model-selection.js";
import type { GatewayRequestContext } from "./types.js";

export type SessionPatchCatalogResult = Result<ModelCatalogSnapshot, unknown>;

export function createSessionPatchCatalogPreparation(
  loadCatalog: (agentId: string) => Promise<ModelCatalogSnapshot>,
  diagnostics?: SessionPatchDiagnostics,
) {
  const preparations = new Map<string, Promise<SessionPatchCatalogResult>>();
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
      projection: Parameters<typeof prepareSessionsPatchEntry>[0];
    }): Promise<
      | { kind: "model-catalog" }
      | { kind: "complete"; result: Awaited<ReturnType<typeof projectSessionsPatchEntry>> }
    > => {
      if (params.mode === "ordered") {
        return {
          kind: "complete",
          result: await projectSessionsPatchEntry({
            ...params.projection,
            loadGatewayModelCatalogSnapshot: () => load(params.agentId),
          }),
        };
      }
      const projection = await prepareSessionsPatchEntry(params.projection);
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

type PatchCatalogs = ReturnType<typeof createSessionPatchCatalogPreparation>;

/** Project preferences and admit the selected route before the writer sees a replacement. */
export async function projectSessionPatchRoute(
  params: Parameters<PatchCatalogs["project"]>[0] & {
    catalogs: PatchCatalogs;
    context: GatewayRequestContext;
    callerCanConsent: boolean;
    timing?: ReturnType<SessionPatchDiagnostics["scope"]>;
  },
) {
  const { catalogs, agentId, projection: input } = params;
  const { cfg, patch, existingEntry } = input;
  const agentModel =
    typeof patch.model === "string" &&
    (isAgentSessionModelPatchOrigin() || isSessionStatusModelPatchOrigin());
  const tryRoute = async (candidate: typeof patch) => {
    const projection = await catalogs.project({
      ...params,
      projection: { ...input, patch: candidate },
    });
    if (projection.kind === "model-catalog") {
      return projection;
    }
    if (!projection.result.ok) {
      return { ...projection.result, unavailableRoute: false };
    }
    const { entry, validateModelSelection } = projection.result;
    params.timing?.mark("runtimeSelection");
    // Worker-local credentials cannot be evaluated on the Gateway.
    const placement =
      agentModel && !entry.authProfileOverride
        ? await readSessionWorkerPlacementAsync({
            context: params.context,
            sessionId: entry.sessionId,
          })
        : undefined;
    const workerAuth =
      placement &&
      readWorkerPlacementIdentity(placement, params.context.workerEnvironmentService)?.inference ===
        "worker";
    const runtime = await prepareSessionPatchRuntimeSelection({
      cfg,
      agentId,
      patch: candidate,
      entry,
      expectedEntry: existingEntry,
      callerCanConsent: params.callerCanConsent,
      operatorAuthority: input.operatorAuthority,
      catalog: (await catalogs.available(agentId))?.entries,
      validateModelSelection,
      placement: { context: params.context, sessionKey: input.storeKey },
      checkAgentModelRoute: agentModel && !workerAuth,
    });
    params.timing?.mark("projection");
    return runtime.ok ? { ok: true as const, entry, runtime } : runtime;
  };
  const first = await tryRoute(patch);
  if (
    "kind" in first ||
    first.ok ||
    !first.unavailableRoute ||
    !agentModel ||
    typeof patch.model !== "string"
  ) {
    return first;
  }
  for (const model of alternateSessionModelRoutes({
    raw: patch.model,
    cfg,
    agentId,
    entry: existingEntry,
    catalog: (await catalogs.available(agentId))?.entries ?? [],
  })) {
    const next = await tryRoute({ ...patch, model });
    if ("kind" in next || next.ok) {
      return next;
    }
  }
  return first;
}
