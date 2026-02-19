import { describe, expect, it, vi } from "vitest";
import { loadClarityOS, type ClarityState } from "./clarityos.ts";

function createState(overrides: Partial<ClarityState> = {}): ClarityState {
  return {
    client: null,
    connected: true,
    clarityLoading: false,
    clarityError: null,
    clarityStatus: null,
    claritySummaryPeriod: "daily",
    claritySummary: null,
    clarityTimeline: null,
    clarityTimelineLimit: 200,
    clarityTimelineFilters: { q: "", source: "", eventType: "", status: "", since: "", until: "" },
    clarityProposals: null,
    clarityNightly: null,
    ...overrides,
  };
}

describe("loadClarityOS", () => {
  it("resets loading and reports partial failure when a request throws synchronously", async () => {
    const request = vi.fn((method: string) => {
      if (method === "clarityos.status") {
        throw new Error("Unauthorized");
      }
      return Promise.resolve({});
    });
    const state = createState({
      client: { request } as unknown as ClarityState["client"],
    });

    await loadClarityOS(state);

    expect(state.clarityLoading).toBe(false);
    expect(state.clarityError).toContain("ClarityOS request unauthorized");
  });
});
