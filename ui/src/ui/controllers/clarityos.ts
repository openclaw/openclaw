import type { GatewayBrowserClient } from "../gateway.ts";
import type {
  ClarityNightlyResult,
  ClarityProposalsResult,
  ClarityStatusResult,
  ClaritySummaryResult,
  ClarityTimelineResult,
} from "../types.ts";

export type ClarityState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  clarityLoading: boolean;
  clarityError: string | null;
  clarityStatus: ClarityStatusResult | null;
  claritySummaryPeriod: "daily" | "weekly" | "monthly" | "custom";
  claritySummary: ClaritySummaryResult | null;
  clarityTimeline: ClarityTimelineResult | null;
  clarityTimelineLimit: number;
  clarityTimelineFilters: {
    q: string;
    source: string;
    eventType: string;
    status: string;
    since: string;
    until: string;
  };
  clarityProposals: ClarityProposalsResult | null;
  clarityNightly: ClarityNightlyResult | null;
};

export async function loadClarityOS(state: ClarityState) {
  if (!state.client || !state.connected || state.clarityLoading) {
    return;
  }
  state.clarityLoading = true;
  state.clarityError = null;
  try {
    const [status, summary, timeline, proposals, nightly] = await Promise.all([
      state.client.request("clarityos.status", {}),
      state.client.request("clarityos.summary", { period: state.claritySummaryPeriod }),
      state.client.request("clarityos.timeline", { limit: state.clarityTimelineLimit }),
      state.client.request("clarityos.proposals", {}),
      state.client.request("clarityos.nightly", {}),
    ]);
    state.clarityStatus = status as ClarityStatusResult;
    state.claritySummary = summary as ClaritySummaryResult;
    state.clarityTimeline = timeline as ClarityTimelineResult;
    state.clarityProposals = proposals as ClarityProposalsResult;
    state.clarityNightly = nightly as ClarityNightlyResult;
  } catch (err) {
    state.clarityError = String(err);
  } finally {
    state.clarityLoading = false;
  }
}

export async function setClarityProposalState(
  state: ClarityState,
  key: string,
  nextState: "proposed" | "approved" | "in_progress" | "standby" | "blocked" | "done",
) {
  if (!state.client || !state.connected) {
    return;
  }
  state.clarityError = null;

  // Optimistic UI update for immediate visual feedback
  const prev = state.clarityProposals ? JSON.parse(JSON.stringify(state.clarityProposals)) : null;
  if (state.clarityProposals?.items) {
    state.clarityProposals.items = state.clarityProposals.items.map((item) =>
      item.proposal_key === key ? { ...item, state: nextState } : item,
    );
  }

  try {
    await state.client.request("clarityos.proposal.state", { key, state: nextState });
    await loadClarityOS(state);
  } catch (err) {
    state.clarityError = String(err);
    if (prev) {
      state.clarityProposals = prev;
    }
  }
}

export async function loadClarityTimelineQuery(state: ClarityState) {
  if (!state.client || !state.connected) {
    return;
  }
  state.clarityError = null;
  try {
    const f = state.clarityTimelineFilters;
    const res = await state.client.request("clarityos.timeline.query", {
      limit: state.clarityTimelineLimit,
      q: f.q || undefined,
      source: f.source || undefined,
      eventType: f.eventType || undefined,
      status: f.status || undefined,
      since: f.since || undefined,
      until: f.until || undefined,
    });
    state.clarityTimeline = {
      generatedAt: (res as { generated_at?: string }).generated_at,
      limit: state.clarityTimelineLimit,
      timeline: ((res as { rows?: unknown[] }).rows ?? []) as Array<Record<string, unknown>>,
    } as unknown as ClarityTimelineResult;
  } catch (err) {
    state.clarityError = String(err);
  }
}
