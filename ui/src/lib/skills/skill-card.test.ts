// @vitest-environment node
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { loadSkillCard, loadSkills, refreshSkills, setSkillsAgentId } from "./index.ts";
import { createState, type SkillsState } from "./skills.test-support.ts";

function createSkillCardReport(): NonNullable<SkillsState["skillsReport"]> {
  return {
    workspaceDir: "/tmp/workspace",
    managedSkillsDir: "/tmp/skills",
    skills: [
      {
        name: "AgentReceipt",
        description: "Trust card fixture",
        skillKey: "agentreceipt",
        source: "workspace",
        bundled: false,
        filePath: "/tmp/workspace/skills/agentreceipt/SKILL.md",
        baseDir: "/tmp/workspace/skills/agentreceipt",
        always: false,
        disabled: false,
        blockedByAllowlist: false,
        blockedByAgentFilter: false,
        eligible: true,
        platformIncompatible: false,
        modelVisible: true,
        userInvocable: true,
        commandVisible: true,
        requirements: { anyBins: [], bins: [], env: [], config: [], os: [] },
        missing: { anyBins: [], bins: [], env: [], config: [], os: [] },
        configChecks: [],
        install: [],
        skillCard: {
          present: true,
          path: "/tmp/workspace/skills/agentreceipt/skill-card.md",
          sizeBytes: 34,
        },
      },
    ],
  };
}

describe("loadSkillCard", () => {
  it("loads local Skill Card content on demand and reuses unchanged content", async () => {
    const { state, request } = createState();
    state.skillsAgentId = "research";
    request.mockResolvedValueOnce({
      schema: "openclaw.skills.skill-card.v1",
      skillKey: "agentreceipt",
      path: "/tmp/workspace/skills/agentreceipt/skill-card.md",
      sizeBytes: 34,
      content: "# AgentReceipt\n\nLocal trust card.\n",
    });
    state.skillsReport = createSkillCardReport();

    await loadSkillCard(state, "agentreceipt");

    expect(request).toHaveBeenCalledWith("skills.skillCard", {
      agentId: "research",
      skillKey: "agentreceipt",
    });
    expect(state.skillCardContents.agentreceipt).toBe("# AgentReceipt\n\nLocal trust card.\n");
    expect(state.skillCardContentKeys.agentreceipt).toBe(
      "/tmp/workspace/skills/agentreceipt/skill-card.md\u000034\u0000",
    );
    expect(state.skillCardLoadingKey).toBeNull();
    expect(state.skillCardErrors).toEqual({});

    await loadSkillCard(state, "agentreceipt");
    expect(request).toHaveBeenCalledOnce();
  });

  it.each(["size", "removed"] as const)(
    "drops cached content after a status report changes the card's %s",
    async (change) => {
      const { state, request } = createState();
      state.skillsReport = createSkillCardReport();
      request.mockResolvedValueOnce({ skillKey: "agentreceipt", content: "ALPHA" });
      await loadSkillCard(state, "agentreceipt");
      const report = createSkillCardReport();
      const skill = expectDefined(report.skills[0], "skill card report entry");
      const card = expectDefined(skill.skillCard, "skill card metadata");
      skill.skillCard = change === "size" ? { ...card, sizeBytes: 40 } : undefined;
      request.mockResolvedValueOnce(report);

      await loadSkills(state);

      expect(state.skillCardContents.agentreceipt).toBeUndefined();
      const readsBeforeReopen = request.mock.calls.length;
      request.mockResolvedValueOnce({ skillKey: "agentreceipt", content: "BRAVO" });
      await loadSkillCard(state, "agentreceipt");
      expect(request).toHaveBeenCalledTimes(readsBeforeReopen + (change === "size" ? 1 : 0));
      expect(state.skillCardContents.agentreceipt).toBe(change === "size" ? "BRAVO" : undefined);
    },
  );

  it("retries a failed card read on the next open without refreshing inventory", async () => {
    const { state, request } = createState();
    state.skillsReport = createSkillCardReport();
    request.mockRejectedValueOnce(new Error("Card unavailable"));

    await loadSkillCard(state, "agentreceipt");
    expect(state.skillCardErrors.agentreceipt).toBe("Card unavailable");
    expect(state.skillCardLoadingKey).toBeNull();
    request.mockResolvedValueOnce({ skillKey: "agentreceipt", content: "BRAVO" });
    await loadSkillCard(state, "agentreceipt");

    expect(state.skillCardContents.agentreceipt).toBe("BRAVO");
    expect(state.skillCardErrors).toEqual({});
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "skills.skillCard",
      "skills.skillCard",
    ]);
  });

  it.each(["success", "failure"] as const)(
    "invalidates same-metadata content when an explicit refresh ends in %s",
    async (outcome) => {
      const { state, request } = createState();
      const report = createSkillCardReport();
      const agents = createDeferred();
      state.skillsReport = report;
      request.mockResolvedValueOnce({ skillKey: "agentreceipt", content: "ALPHA" });
      await loadSkillCard(state, "agentreceipt");
      if (outcome === "success") {
        request.mockResolvedValueOnce(report);
      } else {
        request.mockRejectedValueOnce(new Error("Status unavailable"));
      }

      const refresh = refreshSkills(state, () => agents.promise);
      expect(state.skillCardContents).toEqual({});
      expect(state.skillCardErrors).toEqual({});
      await loadSkillCard(state, "agentreceipt");
      expect(request).toHaveBeenCalledOnce();
      agents.resolve();
      await refresh;

      expect(state.skillCardContents).toEqual({});
      expect(state.skillCardLoadingKey).toBeNull();
      expect(state.skillsError).toBe(outcome === "failure" ? "Status unavailable" : null);
      request.mockResolvedValueOnce({ skillKey: "agentreceipt", content: "BRAVO" });
      await loadSkillCard(state, "agentreceipt");
      expect(state.skillCardContents.agentreceipt).toBe("BRAVO");
      expect(request.mock.calls.filter(([method]) => method === "skills.skillCard")).toHaveLength(
        2,
      );
    },
  );

  it.each([
    ["refresh", "success"],
    ["refresh", "error"],
    ["agent", "success"],
    ["agent", "error"],
    ["client", "success"],
    ["client", "error"],
  ] as const)(
    "keeps a newer card read pending when an old %s read settles with %s",
    async (boundary, outcome) => {
      const { state, request } = createState();
      const report = createSkillCardReport();
      const oldCard = createDeferred<unknown>();
      const newCard = createDeferred<unknown>();
      state.skillsReport = report;
      request.mockReturnValueOnce(oldCard.promise);
      const oldLoad = loadSkillCard(state, "agentreceipt");

      let currentRequest = request;
      if (boundary === "refresh") {
        request.mockResolvedValueOnce(report);
        await refreshSkills(state, async () => undefined);
      } else if (boundary === "agent") {
        setSkillsAgentId(state, "research");
        state.skillsReport = report;
      } else {
        const replacement = createState();
        state.client = replacement.state.client;
        state.skillCardLoadingKey = null;
        currentRequest = replacement.request;
      }
      currentRequest.mockReturnValueOnce(newCard.promise);
      const newLoad = loadSkillCard(state, "agentreceipt");
      expect(currentRequest).toHaveBeenLastCalledWith("skills.skillCard", {
        agentId: boundary === "agent" ? "research" : "main",
        skillKey: "agentreceipt",
      });

      if (outcome === "success") {
        oldCard.resolve({ skillKey: "agentreceipt", content: "ALPHA" });
      } else {
        oldCard.reject(new Error("Obsolete read failed"));
      }
      await oldLoad;
      expect(state.skillCardContents).toEqual({});
      expect(state.skillCardErrors).toEqual({});
      expect(state.skillCardLoadingKey).toBe("agentreceipt");

      newCard.resolve({ skillKey: "agentreceipt", content: "BRAVO" });
      await newLoad;
      expect(state.skillCardContents.agentreceipt).toBe("BRAVO");
      expect(state.skillCardErrors).toEqual({});
      expect(state.skillCardLoadingKey).toBeNull();
    },
  );

  it("does not cache stale Skill Card content after local metadata changes mid-request", async () => {
    const { state, request } = createState();
    let resolveCard: (value: unknown) => void = () => {
      throw new Error("expected card request to be pending");
    };
    request.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCard = resolve;
        }),
    );
    state.skillsReport = createSkillCardReport();
    state.skillsReport.skills[0]!.clawhub = {
      status: "linked",
      valid: true,
      registry: "https://clawhub.ai",
      slug: "agentreceipt",
      installedVersion: "1.2.3",
      installedAt: 123,
      originPath: "/tmp/workspace/skills/agentreceipt/.clawhub/origin.json",
      lockPath: "/tmp/workspace/.clawhub/lock.json",
    };

    const pending = loadSkillCard(state, "agentreceipt");
    state.skillsReport = {
      ...state.skillsReport,
      skills: [
        {
          ...expectDefined(state.skillsReport.skills[0], "skill card report entry"),
          clawhub: {
            status: "linked",
            valid: true,
            registry: "https://clawhub.ai",
            slug: "agentreceipt",
            installedVersion: "1.2.4",
            installedAt: 456,
            originPath: "/tmp/workspace/skills/agentreceipt/.clawhub/origin.json",
            lockPath: "/tmp/workspace/.clawhub/lock.json",
          },
        },
      ],
    };
    resolveCard({
      schema: "openclaw.skills.skill-card.v1",
      skillKey: "agentreceipt",
      path: "/tmp/workspace/skills/agentreceipt/skill-card.md",
      sizeBytes: 34,
      content: "old card",
    });
    await pending;

    expect(state.skillCardContents.agentreceipt).toBeUndefined();
    expect(state.skillCardContentKeys.agentreceipt).toBeUndefined();
  });
});
