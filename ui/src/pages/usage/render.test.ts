// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppViewState } from "../../ui/app-view-state.ts";
import { renderUsageTab } from "./render.ts";
import type { UsageProps } from "./types.ts";

const renderUsageMock = vi.hoisted(() => vi.fn((_props: UsageProps) => null));

type UsageViewModule = typeof import("./view.ts");

function createUsageView(): UsageViewModule {
  return { renderUsage: renderUsageMock } as unknown as UsageViewModule;
}

function createState(overrides: Partial<AppViewState> = {}): AppViewState {
  return {
    usageLoading: false,
    usageError: null,
    usageResult: null,
    usageCostSummary: null,
    usageStartDate: "2026-02-16",
    usageEndDate: "2026-02-16",
    usageScope: "family",
    usageAgentId: null,
    usageSelectedSessions: [],
    usageSelectedDays: [],
    usageSelectedHours: [],
    usageQuery: "",
    usageQueryDraft: "",
    usageQueryDebounceTimer: null,
    usageTimeZone: "local",
    connected: true,
    client: {
      request: vi.fn(async () => ({})),
    },
    agentsList: {
      defaultId: "main",
      mainKey: "agent:main:main",
      agents: [{ id: "main" }, { id: "research" }],
    },
    ...overrides,
  } as unknown as AppViewState;
}

describe("renderUsageTab", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("passes configured agents to the usage view", () => {
    renderUsageTab(createState(), createUsageView());

    expect(renderUsageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ agents: ["main", "research"] }),
      }),
    );
  });

  it("reloads usage when selecting an agent scope", () => {
    const request = vi.fn(async () => ({}));
    const state = createState({
      client: { request } as unknown as AppViewState["client"],
    });

    renderUsageTab(state, createUsageView());
    expect(renderUsageMock).toHaveBeenCalled();
    const props = renderUsageMock.mock.calls[0]?.[0];
    if (!props) {
      throw new Error("expected renderUsage props");
    }
    props.callbacks.filters.onAgentChange("research");

    expect(state.usageAgentId).toBe("research");
    expect(request).toHaveBeenCalledWith(
      "sessions.usage",
      expect.objectContaining({ agentId: "research" }),
    );
    expect(request).toHaveBeenCalledWith(
      "usage.cost",
      expect.objectContaining({ agentId: "research" }),
    );
  });
});
