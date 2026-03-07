import { GatewayRequestError, type GatewayBrowserClient } from "../gateway.ts";
import type {
  ContinuityExplainResult,
  ContinuityKind,
  ContinuityRecord,
  ContinuityReviewState,
  ContinuitySourceClass,
  ContinuityStatus,
} from "../types.ts";

export type ContinuityState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  continuityLoading: boolean;
  continuityLoadPromise?: Promise<void> | null;
  continuityError: string | null;
  continuityStatus: ContinuityStatus | null;
  continuityRecords: ContinuityRecord[];
  continuityAgentId: string;
  continuityStateFilter: ContinuityReviewState | "all";
  continuityKindFilter: ContinuityKind | "all";
  continuitySourceFilter: ContinuitySourceClass | "all";
  continuityLimit: string;
  continuityBusyId: string | null;
  continuityExplainById: Record<string, ContinuityExplainResult | null>;
};

type LoadContinuityOptions = {
  waitForCurrent?: boolean;
};

function buildAgentId(state: ContinuityState): string | undefined {
  const agentId = state.continuityAgentId.trim();
  return agentId || undefined;
}

function buildListParams(state: ContinuityState): Record<string, unknown> {
  const params: Record<string, unknown> = {
    state: state.continuityStateFilter,
    kind: state.continuityKindFilter,
    sourceClass: state.continuitySourceFilter,
  };
  const agentId = buildAgentId(state);
  if (agentId) {
    params.agentId = agentId;
  }
  const limit = Number.parseInt(state.continuityLimit.trim(), 10);
  if (Number.isFinite(limit) && limit > 0) {
    params.limit = limit;
  }
  return params;
}

function formatContinuityError(err: unknown): string {
  if (err instanceof GatewayRequestError) {
    if (
      err.gatewayCode === "INVALID_REQUEST" &&
      typeof err.message === "string" &&
      err.message.startsWith("unknown method: continuity.")
    ) {
      return 'Continuity plugin not loaded. Select `plugins.slots.contextEngine = "continuity"` or enable `plugins.entries.continuity.enabled`.';
    }
    return err.message;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

export async function loadContinuity(state: ContinuityState, options: LoadContinuityOptions = {}) {
  if (!state.client || !state.connected) {
    return;
  }
  const client = state.client;
  if (state.continuityLoading) {
    if (options.waitForCurrent && state.continuityLoadPromise) {
      await state.continuityLoadPromise;
      if (state.client && state.connected) {
        await loadContinuity(state);
      }
    }
    return;
  }
  state.continuityLoading = true;
  state.continuityError = null;
  const loadPromise = (async () => {
    try {
      const agentId = buildAgentId(state);
      const [status, records] = await Promise.all([
        client.request<ContinuityStatus>("continuity.status", agentId ? { agentId } : {}),
        client.request<ContinuityRecord[]>("continuity.list", buildListParams(state)),
      ]);
      state.continuityStatus = status;
      state.continuityRecords = Array.isArray(records) ? records : [];
    } catch (err) {
      state.continuityError = formatContinuityError(err);
    } finally {
      state.continuityLoading = false;
      state.continuityLoadPromise = null;
    }
  })();
  state.continuityLoadPromise = loadPromise;
  await loadPromise;
}

export function updateContinuityFilters(
  state: ContinuityState,
  patch: Partial<
    Pick<
      ContinuityState,
      | "continuityAgentId"
      | "continuityStateFilter"
      | "continuityKindFilter"
      | "continuitySourceFilter"
      | "continuityLimit"
    >
  >,
) {
  if (typeof patch.continuityAgentId === "string") {
    state.continuityAgentId = patch.continuityAgentId;
  }
  if (patch.continuityStateFilter) {
    state.continuityStateFilter = patch.continuityStateFilter;
  }
  if (patch.continuityKindFilter) {
    state.continuityKindFilter = patch.continuityKindFilter;
  }
  if (patch.continuitySourceFilter) {
    state.continuitySourceFilter = patch.continuitySourceFilter;
  }
  if (typeof patch.continuityLimit === "string") {
    state.continuityLimit = patch.continuityLimit;
  }
}

export async function patchContinuity(
  state: ContinuityState,
  id: string,
  action: "approve" | "reject" | "remove",
) {
  if (!state.client || !state.connected) {
    return;
  }
  state.continuityBusyId = id;
  state.continuityError = null;
  try {
    const params: Record<string, unknown> = { id, action };
    const agentId = buildAgentId(state);
    if (agentId) {
      params.agentId = agentId;
    }
    await state.client.request("continuity.patch", params);
    if (id in state.continuityExplainById) {
      const next = { ...state.continuityExplainById };
      delete next[id];
      state.continuityExplainById = next;
    }
    await loadContinuity(state, { waitForCurrent: true });
  } catch (err) {
    state.continuityError = formatContinuityError(err);
  } finally {
    state.continuityBusyId = null;
  }
}

export async function loadContinuityExplain(state: ContinuityState, id: string) {
  if (!state.client || !state.connected) {
    return;
  }
  state.continuityBusyId = id;
  state.continuityError = null;
  try {
    const params: Record<string, unknown> = { id };
    const agentId = buildAgentId(state);
    if (agentId) {
      params.agentId = agentId;
    }
    const result = await state.client.request<ContinuityExplainResult>(
      "continuity.explain",
      params,
    );
    state.continuityExplainById = { ...state.continuityExplainById, [id]: result ?? null };
  } catch (err) {
    state.continuityError = formatContinuityError(err);
  } finally {
    state.continuityBusyId = null;
  }
}
