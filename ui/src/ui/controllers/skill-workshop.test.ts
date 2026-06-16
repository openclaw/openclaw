// Control UI tests cover skill workshop controller behavior.
import { describe, expect, it, vi } from "vitest";
import type { SkillWorkshopProposal } from "../views/skill-workshop.ts";
import {
  loadSkillWorkshopProposalDetail,
  loadSkillWorkshopProposals,
  runSkillWorkshopLifecycleAction,
  type SkillWorkshopState,
} from "./skill-workshop.ts";

type TestRequest = (method: string, payload?: unknown) => Promise<unknown>;

const ISO_NOW = "2026-06-16T12:00:00.000Z";

function createState(overrides: Partial<SkillWorkshopState> = {}): {
  state: SkillWorkshopState;
  request: ReturnType<typeof vi.fn<TestRequest>>;
} {
  const request = vi.fn<TestRequest>();
  const state: SkillWorkshopState = {
    client: { request } as unknown as SkillWorkshopState["client"],
    connected: true,
    assistantAgentId: "research",
    agentsList: { defaultId: "main", mainKey: "main" },
    hello: null,
    sessionKey: "global",
    skillWorkshopLoading: false,
    skillWorkshopLoaded: false,
    skillWorkshopError: null,
    skillWorkshopInspectingKey: null,
    skillWorkshopProposals: [],
    skillWorkshopSelectedKey: null,
    skillWorkshopActionBusy: null,
    skillWorkshopActionNotice: null,
    skillWorkshopActionNoticeTimer: null,
    skillWorkshopRevisionKey: null,
    skillWorkshopRevisionDraft: "",
    skillWorkshopStatusFilter: "pending",
    skillWorkshopQuery: "",
    skillWorkshopFilePreviewKey: null,
    skillWorkshopFilePreviewQuery: "",
    skillWorkshopQueueWidth: 360,
    skillWorkshopMode: "today",
    skillWorkshopUseCurrentChatForRevisions: false,
    ...overrides,
  };
  return { state, request };
}

function manifest(status: SkillWorkshopProposal["status"] = "pending") {
  return {
    schema: "openclaw.skill-workshop.proposals-manifest.v1",
    updatedAt: ISO_NOW,
    proposals: [
      {
        id: "proposal-1",
        kind: "create",
        status,
        title: "Inbox Cleaner",
        description: "Clean inbox triage",
        skillName: "Inbox Cleaner",
        skillKey: "inbox-cleaner",
        createdAt: ISO_NOW,
        updatedAt: ISO_NOW,
        scanState: "clean",
      },
    ],
  };
}

function inspectResult(status: SkillWorkshopProposal["status"] = "pending") {
  return {
    record: {
      id: "proposal-1",
      kind: "create",
      status,
      title: "Inbox Cleaner",
      description: "Clean inbox triage",
      createdAt: ISO_NOW,
      updatedAt: ISO_NOW,
      proposedVersion: "v1",
      target: {
        skillName: "Inbox Cleaner",
        skillKey: "inbox-cleaner",
      },
    },
    content: "Review unread mail and archive low-priority threads.",
    supportFiles: [],
  };
}

function proposal(overrides: Partial<SkillWorkshopProposal> = {}): SkillWorkshopProposal {
  return {
    key: "proposal-1",
    slug: "inbox-cleaner",
    name: "Inbox Cleaner",
    oneLine: "Clean inbox triage",
    body: "Review unread mail.",
    status: "pending",
    version: 1,
    createdAt: Date.parse(ISO_NOW),
    updatedAt: Date.parse(ISO_NOW),
    recencyGroup: "today",
    ageLabel: "now",
    supportFiles: [],
    isNew: false,
    ...overrides,
  };
}

function clearNoticeTimer(state: SkillWorkshopState): void {
  if (state.skillWorkshopActionNoticeTimer) {
    globalThis.clearTimeout(state.skillWorkshopActionNoticeTimer);
    state.skillWorkshopActionNoticeTimer = null;
  }
}

describe("Skill Workshop proposal RPCs", () => {
  it("lists proposals with the selected agent id and carries it into the initial inspect", async () => {
    const { state, request } = createState({ assistantAgentId: "research" });
    request.mockImplementation(async (method: string) => {
      if (method === "skills.proposals.list") {
        return manifest();
      }
      if (method === "skills.proposals.inspect") {
        return inspectResult();
      }
      return {};
    });

    await loadSkillWorkshopProposals(state);

    expect(request).toHaveBeenNthCalledWith(1, "skills.proposals.list", {
      agentId: "research",
    });
    expect(request).toHaveBeenNthCalledWith(2, "skills.proposals.inspect", {
      agentId: "research",
      proposalId: "proposal-1",
    });
  });

  it("inspects proposals with the current agent from the selected session", async () => {
    const { state, request } = createState({
      assistantAgentId: "research",
      sessionKey: "agent:ops-team:main",
      skillWorkshopProposals: [proposal({ body: "" })],
    });
    request.mockResolvedValue(inspectResult());

    await loadSkillWorkshopProposalDetail(state, "proposal-1");

    expect(request).toHaveBeenCalledWith("skills.proposals.inspect", {
      agentId: "ops-team",
      proposalId: "proposal-1",
    });
  });

  it.each([
    ["apply", "skills.proposals.apply", "applied"],
    ["reject", "skills.proposals.reject", "rejected"],
  ] as const)(
    "%s sends the selected agent id and refreshes that agent scope",
    async (action, method, status) => {
      const { state, request } = createState({
        assistantAgentId: "reviewer",
        skillWorkshopProposals: [proposal()],
        skillWorkshopSelectedKey: "proposal-1",
      });
      request.mockImplementation(async (calledMethod: string) => {
        if (calledMethod === method) {
          return {};
        }
        if (calledMethod === "skills.proposals.list") {
          return manifest(status);
        }
        if (calledMethod === "skills.proposals.inspect") {
          return inspectResult(status);
        }
        return {};
      });

      try {
        await runSkillWorkshopLifecycleAction(state, action, "proposal-1");
      } finally {
        clearNoticeTimer(state);
      }

      expect(request).toHaveBeenNthCalledWith(1, method, {
        agentId: "reviewer",
        proposalId: "proposal-1",
      });
      expect(request).toHaveBeenNthCalledWith(2, "skills.proposals.list", {
        agentId: "reviewer",
      });
      expect(request).toHaveBeenNthCalledWith(3, "skills.proposals.inspect", {
        agentId: "reviewer",
        proposalId: "proposal-1",
      });
    },
  );
});
