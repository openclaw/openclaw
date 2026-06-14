// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadSkillWorkshopProposals,
  loadSkillWorkshopProposalDetail,
  runSkillWorkshopLifecycleAction,
  type SkillWorkshopState,
} from "./skill-workshop.ts";

function createClient() {
  return {
    request: vi.fn(),
  };
}

function createState(overrides?: Partial<SkillWorkshopState>): SkillWorkshopState {
  const client = createClient();
  return {
    client: client as unknown as SkillWorkshopState["client"],
    connected: true,
    skillWorkshopLoading: false,
    skillWorkshopLoaded: false,
    skillWorkshopError: null,
    skillWorkshopInspectingKey: null,
    skillWorkshopProposals: [],
    skillWorkshopSelectedKey: null,
    skillWorkshopActionBusy: null,
    skillWorkshopActionNotice: null,
    skillWorkshopRevisionKey: null,
    skillWorkshopRevisionDraft: "",
    skillWorkshopStatusFilter: "all",
    skillWorkshopQuery: "",
    skillWorkshopFilePreviewKey: null,
    skillWorkshopFilePreviewQuery: "",
    skillWorkshopQueueWidth: 320,
    skillWorkshopMode: "proposals",
    skillWorkshopUseCurrentChatForRevisions: false,
    ...overrides,
  } as SkillWorkshopState;
}

describe("loadSkillWorkshopProposals", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("omits agentId from RPC params when agentId is undefined", async () => {
    const state = createState();
    state.client!.request.mockResolvedValueOnce({
      schema: "openclaw.skill-workshop.proposals-manifest.v1",
      updatedAt: new Date().toISOString(),
      proposals: [],
    });

    await loadSkillWorkshopProposals(state, undefined);

    expect(state.client!.request).toHaveBeenCalledOnce();
    expect(state.client!.request).toHaveBeenCalledWith("skills.proposals.list", {});
  });

  it("includes agentId in RPC params when agentId is provided", async () => {
    const state = createState();
    state.client!.request.mockResolvedValueOnce({
      schema: "openclaw.skill-workshop.proposals-manifest.v1",
      updatedAt: new Date().toISOString(),
      proposals: [],
    });

    await loadSkillWorkshopProposals(state, "research");

    expect(state.client!.request).toHaveBeenCalledOnce();
    expect(state.client!.request).toHaveBeenCalledWith("skills.proposals.list", {
      agentId: "research",
    });
  });
});

describe("loadSkillWorkshopProposalDetail", () => {
  it("omits agentId from inspect RPC params when agentId is undefined", async () => {
    const state = createState();
    state.client!.request.mockResolvedValueOnce({
      record: {
        id: "proposal-1",
        kind: "create",
        status: "pending",
        title: "Test",
        description: "",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        proposedVersion: "v1",
        target: { skillName: "test", skillKey: "test" },
      },
      content: "",
    });

    await loadSkillWorkshopProposalDetail(state, undefined, "proposal-1");

    expect(state.client!.request).toHaveBeenCalledOnce();
    expect(state.client!.request).toHaveBeenCalledWith("skills.proposals.inspect", {
      proposalId: "proposal-1",
    });
  });

  it("includes agentId in inspect RPC params when agentId is provided", async () => {
    const state = createState();
    state.client!.request.mockResolvedValueOnce({
      record: {
        id: "proposal-1",
        kind: "create",
        status: "pending",
        title: "Test",
        description: "",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        proposedVersion: "v1",
        target: { skillName: "test", skillKey: "test" },
      },
      content: "",
    });

    await loadSkillWorkshopProposalDetail(state, "research", "proposal-1");

    expect(state.client!.request).toHaveBeenCalledOnce();
    expect(state.client!.request).toHaveBeenCalledWith("skills.proposals.inspect", {
      proposalId: "proposal-1",
      agentId: "research",
    });
  });
});

describe("runSkillWorkshopLifecycleAction", () => {
  it("omits agentId from apply RPC params when agentId is undefined", async () => {
    const state = createState();
    state.client!.request.mockResolvedValueOnce(undefined);

    await runSkillWorkshopLifecycleAction(state, undefined, "apply", "proposal-1");

    const applyCall = state.client!.request.mock.calls.find(
      ([method]) => method === "skills.proposals.apply",
    );
    expect(applyCall).toEqual(["skills.proposals.apply", { proposalId: "proposal-1" }]);
  });

  it("includes agentId in reject RPC params when agentId is provided", async () => {
    const state = createState();
    state.client!.request.mockResolvedValueOnce(undefined);

    await runSkillWorkshopLifecycleAction(state, "research", "reject", "proposal-1");

    const rejectCall = state.client!.request.mock.calls.find(
      ([method]) => method === "skills.proposals.reject",
    );
    expect(rejectCall).toEqual([
      "skills.proposals.reject",
      { proposalId: "proposal-1", agentId: "research" },
    ]);
  });
});
