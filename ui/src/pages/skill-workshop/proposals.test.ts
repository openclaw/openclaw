// @vitest-environment node
// Control UI tests cover skill workshop reads and evaluation.
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { SkillWorkshopProposal } from "../../lib/skill-workshop/index.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import {
  clearNoticeTimer,
  createFixture,
  inspectResult,
  ISO_NOW,
  manifest,
  proposal,
  proposalDecision,
  recordFrom,
  REVISION_HASH,
} from "../../test-helpers/skill-workshop-proposal-fixture.ts";
import {
  requestSkillWorkshopRevision,
  runSkillWorkshopEvaluation,
  runSkillWorkshopLifecycleAction,
} from "./proposal-actions.ts";
import {
  loadSkillWorkshopProposals,
  selectSkillWorkshopProposal,
  selectSkillWorkshopInstalledSkill,
} from "./proposals.ts";

vi.mock("../../lib/skill-workshop/diff-worker.ts", async () => {
  const { computeSkillWorkshopDiff } = await import("../../lib/skill-workshop/diff.ts");
  return {
    compareSkillWorkshopInstructions: vi.fn(async (previous: string, current: string) =>
      computeSkillWorkshopDiff(previous, current),
    ),
  };
});

describe("Skill Workshop proposal RPCs", () => {
  it("reads current installed content and compares only its own applied proposals", async () => {
    const installed = {
      name: "inbox-cleaner",
      skillKey: "inbox-cleaner",
      description: "Current inbox procedure",
    };
    const { state, context, request } = createFixture({ skillWorkshopMode: "skills" });
    request.mockImplementation(async (method, payload) => {
      if (method === "skills.proposals.list") {
        return {
          ...manifest("applied"),
          installedSkills: [installed],
          proposals: [
            { ...manifest("applied").proposals[0], id: "workshop" },
            { ...manifest("applied").proposals[0], id: "workspace" },
          ],
        };
      }
      if (method === "skills.workshop.read") {
        return { ...installed, content: "# Current procedure\n\nChanged by collection review." };
      }
      const { proposalId } = payload as { proposalId: string };
      return {
        ...inspectResult("applied"),
        record: {
          ...inspectResult("applied").record,
          id: proposalId,
          appliedAt: ISO_NOW,
          target: {
            skillName: "Inbox Cleaner",
            skillKey: installed.skillKey,
            source: proposalId === "workshop" ? "openclaw-workshop" : "openclaw-workspace",
          },
        },
      };
    });

    await loadSkillWorkshopProposals(state, context);

    expect(state.skillWorkshopInstalledSkills.map((skill) => skill.name)).toEqual([installed.name]);
    expect(state.skillWorkshopInstalledName).toBe(installed.name);
    const read = state.skillWorkshopInstalledSkills[0]?.read;
    expect(read).toMatchObject({
      status: "ready",
      content: "# Current procedure\n\nChanged by collection review.",
    });
    expect(read?.status === "ready" && read.savedVersions.map((version) => version.key)).toEqual([
      "workshop",
    ]);
    expect(request).toHaveBeenCalledWith("skills.workshop.read", {
      agentId: "research",
      name: installed.name,
    });
  });

  it("loads Suggestions without reading installed skill bodies", async () => {
    const { state, context, request } = createFixture();
    request.mockImplementation(async (method) =>
      method === "skills.proposals.list"
        ? {
            ...manifest(),
            installedSkills: [{ name: "inbox", skillKey: "inbox", description: "Inbox procedure" }],
          }
        : inspectResult(),
    );

    await loadSkillWorkshopProposals(state, context);

    expect(state.skillWorkshopProposals[0]?.body).toBe(
      "Review unread mail and archive low-priority threads.",
    );
    expect(request.mock.calls.filter(([method]) => method === "skills.workshop.read")).toEqual([]);
  });

  it("shares collection reads with clicks and keeps the latest selected skill", async () => {
    const installed = ["first", "second"].map((name) => ({
      name,
      skillKey: name,
      description: name,
    }));
    const first = createDeferred<unknown>();
    const second = createDeferred<unknown>();
    const { state, context, request } = createFixture({ skillWorkshopMode: "skills" });
    request.mockImplementation(async (method, payload) => {
      if (method === "skills.proposals.list") {
        return { ...manifest(), proposals: [], installedSkills: installed };
      }
      return (payload as { name: string }).name === "first" ? first.promise : second.promise;
    });

    const loading = loadSkillWorkshopProposals(state, context);
    await vi.waitFor(() =>
      expect(
        request.mock.calls.filter(([method]) => method === "skills.workshop.read"),
      ).toHaveLength(2),
    );
    const selecting = selectSkillWorkshopInstalledSkill(state, context, "second");
    second.resolve({ ...installed[1], content: "Second current body" });
    await selecting;
    first.resolve({ ...installed[0], content: "Late first body" });
    await loading;

    expect(state.skillWorkshopInstalledName).toBe("second");
    expect(
      state.skillWorkshopInstalledSkills.find((skill) => skill.name === "second")?.read,
    ).toMatchObject({
      status: "ready",
      content: "Second current body",
    });
    expect(request.mock.calls.filter(([method]) => method === "skills.workshop.read")).toHaveLength(
      2,
    );
  });

  it.each(["agent", "client"])("ignores an installed read after its %s changes", async (source) => {
    const installed = { name: "inbox-cleaner", skillKey: "inbox-cleaner", description: "Inbox" };
    const previous = createDeferred<unknown>();
    const { state, context, request, snapshot } = createFixture({
      skillWorkshopAgentId: "research",
      skillWorkshopInstalledSkills: [installed],
    });
    request.mockReturnValueOnce(previous.promise);
    const onProgress = vi.fn();
    const loading = selectSkillWorkshopInstalledSkill(state, context, installed.name, {
      onProgress,
    });
    if (source === "agent") {
      snapshot.assistantAgentId = "writer";
      state.skillWorkshopAgentId = "writer";
    } else {
      snapshot.client = createFixture().snapshot.client;
    }
    previous.resolve({ ...installed, content: "Stale source content" });
    await loading;

    expect(onProgress).not.toHaveBeenCalled();
    expect(state.skillWorkshopInstalledSkills[0]?.read).not.toHaveProperty("content");
    expect(state.skillWorkshopInstalledSkills[0]?.read).not.toMatchObject({
      status: "ready",
      content: "Stale source content",
    });
  });

  it("keeps a failed collection read until the operator explicitly retries it", async () => {
    const installed = { name: "inbox-cleaner", skillKey: "inbox-cleaner", description: "Inbox" };
    const { state, context, request } = createFixture({
      skillWorkshopAgentId: "research",
      skillWorkshopMode: "skills",
    });
    request.mockImplementation(async (method) => {
      if (method === "skills.proposals.list") {
        return { ...manifest(), proposals: [], installedSkills: [installed] };
      }
      throw new Error("Skill is temporarily unreadable");
    });
    await loadSkillWorkshopProposals(state, context);
    await selectSkillWorkshopInstalledSkill(state, context, installed.name);
    expect(state.skillWorkshopInstalledSkills[0]?.read).toMatchObject({
      status: "error",
      error: "Skill is temporarily unreadable",
    });
    expect(request.mock.calls.filter(([method]) => method === "skills.workshop.read")).toHaveLength(
      1,
    );
    request.mockResolvedValueOnce({
      name: "inbox-cleaner",
      skillKey: "inbox-cleaner",
      description: "Current inbox",
      content: "Recovered current body",
    });
    await selectSkillWorkshopInstalledSkill(state, context, "inbox-cleaner", { force: true });
    expect(state.skillWorkshopInstalledSkills[0]?.read).toMatchObject({
      status: "ready",
      content: "Recovered current body",
    });
    expect(request.mock.calls.filter(([method]) => method === "skills.workshop.read")).toHaveLength(
      2,
    );
  });

  it("does not dispatch proposal mutations with read-only operator access", async () => {
    const { state, context, request } = createFixture(
      { skillWorkshopProposals: [proposal()] },
      {
        hello: gatewayHelloForMethods(
          [
            "skills.proposals.apply",
            "skills.proposals.reject",
            "skills.proposals.evaluate",
            "skills.proposals.requestRevision",
          ],
          ["operator.read"],
        ),
      },
    );

    await runSkillWorkshopLifecycleAction(state, context, "apply", proposalDecision());
    await runSkillWorkshopLifecycleAction(state, context, "reject", proposalDecision());
    await expect(runSkillWorkshopEvaluation(state, context, "proposal-1")).resolves.toBe(false);
    await expect(requestSkillWorkshopRevision(state, context, "proposal-1", vi.fn())).resolves.toBe(
      null,
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("lists proposals with the selected agent id and carries it into the initial inspect", async () => {
    const { state, context, request } = createFixture();
    const inspected = createDeferred<ReturnType<typeof inspectResult>>();
    request.mockImplementation(async (method: string) => {
      if (method === "skills.proposals.list") {
        return manifest();
      }
      if (method === "skills.proposals.inspect") {
        return inspected.promise;
      }
      return {};
    });

    const loading = loadSkillWorkshopProposals(state, context);
    await vi.waitFor(() => expect(state.skillWorkshopInspectingKey).toBe("proposal-1"));
    expect(state.skillWorkshopProposals[0]?.revisionHash).toBeNull();
    inspected.resolve(inspectResult());
    await loading;

    expect(request).toHaveBeenNthCalledWith(1, "skills.proposals.list", {
      agentId: "research",
    });
    expect(request).toHaveBeenNthCalledWith(2, "skills.proposals.inspect", {
      agentId: "research",
      proposalId: "proposal-1",
    });
    expect(state.skillWorkshopProposals[0]?.kind).toBe("create");
    expect(state.skillWorkshopProposals[0]?.revisionHash).toBe(REVISION_HASH);
  });

  it("reports a failed inspect for a selection retained across refresh", async () => {
    const pendingManifest = manifest();
    const latest = pendingManifest.proposals[0];
    if (!latest) {
      throw new Error("Expected proposal fixture");
    }
    const previous = {
      ...latest,
      id: "proposal-0",
      updatedAt: "2026-06-15T12:00:00.000Z",
    };
    const { state, context, request } = createFixture({
      skillWorkshopAgentId: "research",
      skillWorkshopSelectedKey: "proposal-1",
      skillWorkshopMode: "suggestions",
    });
    request.mockImplementation(async (method: string) => {
      if (method === "skills.proposals.list") {
        return { ...pendingManifest, proposals: [latest, previous] };
      }
      throw new Error("inspect failed");
    });

    await loadSkillWorkshopProposals(state, context, { force: true });

    expect(state.skillWorkshopSelectedKey).toBe("proposal-1");
    expect(state.skillWorkshopError).toContain("inspect failed");
    expect(request.mock.calls.filter(([method]) => method === "skills.proposals.inspect")).toEqual([
      ["skills.proposals.inspect", { agentId: "research", proposalId: "proposal-1" }],
    ]);
  });

  it.each(["create", "update"] as const)(
    "keeps a missing %s draft dismissible beside a usable suggestion",
    async (kind) => {
      const missing = {
        ...manifest().proposals[0],
        kind,
        degradedState: "draft-missing",
      };
      const valid = { ...manifest().proposals[0], id: "proposal-2" };
      let status: SkillWorkshopProposal["status"] = "pending";
      const { state, context, request } = createFixture(
        {
          skillWorkshopAgentId: "research",
          skillWorkshopProposals: [proposal({ body: "Previously available draft." })],
          skillWorkshopRevisionDraft: "Revise this suggestion.",
        },
        {},
        ["list", "inspect", "apply", "evaluate", "requestRevision", "reject"].map(
          (method) => `skills.proposals.${method}`,
        ),
      );
      const validInspect = inspectResult();
      validInspect.record.id = "proposal-2";
      request.mockImplementation(async (method, payload) => {
        if (method === "skills.proposals.list") {
          return { ...manifest(), proposals: [{ ...missing, status }, valid] };
        }
        if (method === "skills.proposals.inspect") {
          expect(payload).toEqual({ agentId: "research", proposalId: "proposal-2" });
          return validInspect;
        }
        if (method === "skills.proposals.reject") {
          expect(payload).toEqual({
            agentId: "research",
            proposalId: "proposal-1",
            expectedRevisionHash: REVISION_HASH,
          });
          status = "rejected";
          return { ...recordFrom("rejected"), kind };
        }
        throw new Error(`Unexpected request: ${method}`);
      });

      await loadSkillWorkshopProposals(state, context);
      expect(state.skillWorkshopProposals[0]).toMatchObject({
        degradedState: "draft-missing",
        revisionHash: REVISION_HASH,
        body: "",
      });
      await runSkillWorkshopLifecycleAction(state, context, "apply", proposalDecision());
      await expect(runSkillWorkshopEvaluation(state, context, "proposal-1")).resolves.toBe(false);
      const sendRevision = vi.fn();
      await requestSkillWorkshopRevision(state, context, "proposal-1", sendRevision);
      expect(sendRevision).not.toHaveBeenCalled();
      expect(request).toHaveBeenCalledTimes(1);

      try {
        await runSkillWorkshopLifecycleAction(state, context, "reject", proposalDecision());
        expect(state.skillWorkshopError).toBeNull();
        expect(state.skillWorkshopProposals[1]?.body).toBe(validInspect.content);
      } finally {
        clearNoticeTimer(state);
      }
    },
  );

  it("preserves capped support-file size formatting through the shared helper", async () => {
    const { state, context, request } = createFixture();
    const baseInspect = inspectResult();
    const inspected = {
      ...baseInspect,
      record: {
        ...baseInspect.record,
        supportFiles: [{ path: "reference.md", sizeBytes: 1024 * 1024 }],
      },
      supportFiles: [{ path: "reference.md", content: "reference" }],
    };
    request.mockImplementation(async (method: string) => {
      if (method === "skills.proposals.list") {
        return manifest();
      }
      if (method === "skills.proposals.inspect") {
        return inspected;
      }
      return {};
    });

    await loadSkillWorkshopProposals(state, context);

    expect(state.skillWorkshopProposals[0]?.supportFiles[0]?.size).toBe("1024.0 KB");
  });

  it("uses the current session only when no agent is explicitly selected", async () => {
    const { state, context, request } = createFixture(
      { skillWorkshopProposals: [proposal({ body: "", bodyLoaded: false })] },
      { sessionKey: "agent:ops-team:main", assistantAgentId: null },
      ["skills.proposals.inspect"],
    );
    request.mockResolvedValue(inspectResult());

    await selectSkillWorkshopProposal(state, context, "proposal-1");

    expect(request).toHaveBeenCalledWith("skills.proposals.inspect", {
      agentId: "ops-team",
      proposalId: "proposal-1",
    });
    expect(state.skillWorkshopSelectedKey).toBe("proposal-1");
    const inspected = state.skillWorkshopProposals[0]!;
    expect(inspected.bodyLoaded).toBe(true);
    expect(inspected.body).toBe("Review unread mail and archive low-priority threads.");
    expect(inspected.slug).toBe("inbox-cleaner");
    expect(inspected.name).toBe("Inbox Cleaner");
    expect(inspected.version).toBe(1);
  });

  it("loads the explicitly selected agent even when the last chat belongs to another agent", async () => {
    const { state, context, request } = createFixture(
      {
        skillWorkshopAgentId: "research",
        skillWorkshopLoaded: true,
        skillWorkshopProposals: [proposal()],
      },
      { sessionKey: "agent:research:main", assistantAgentId: "ops" },
    );
    request.mockImplementation(async (method: string) => {
      if (method === "skills.proposals.list") {
        return manifest();
      }
      if (method === "skills.proposals.inspect") {
        return inspectResult();
      }
      return {};
    });

    await loadSkillWorkshopProposals(state, context);

    expect(state.skillWorkshopAgentId).toBe("ops");
    expect(request).toHaveBeenNthCalledWith(1, "skills.proposals.list", { agentId: "ops" });
    expect(request).toHaveBeenNthCalledWith(2, "skills.proposals.inspect", {
      agentId: "ops",
      proposalId: "proposal-1",
    });
  });

  it("clears stale proposals when the agent changes during an in-flight reload", async () => {
    const researchList = createDeferred<ReturnType<typeof manifest>>();
    const opsList = createDeferred<ReturnType<typeof manifest>>();
    const { state, context, request, snapshot } = createFixture({
      skillWorkshopAgentId: "research",
      skillWorkshopLoaded: true,
      skillWorkshopProposals: [proposal()],
    });
    request.mockImplementation(async (method: string, payload?: unknown) => {
      if (method !== "skills.proposals.list") {
        return inspectResult();
      }
      return (payload as { agentId?: string }).agentId === "research"
        ? researchList.promise
        : opsList.promise;
    });

    const researchReload = loadSkillWorkshopProposals(state, context, { force: true });
    snapshot.assistantAgentId = "ops";
    const opsReload = loadSkillWorkshopProposals(state, context);

    expect(state.skillWorkshopAgentId).toBe("ops");
    expect(state.skillWorkshopProposals).toEqual([]);

    researchList.resolve(manifest());
    await researchReload;
    expect(state.skillWorkshopProposals).toEqual([]);
    expect(state.skillWorkshopLoading).toBe(true);
    opsList.resolve(manifest());
    await opsReload;
    expect(state.skillWorkshopLoaded).toBe(true);

    expect(state.skillWorkshopAgentId).toBe("ops");
    expect(request).toHaveBeenCalledWith("skills.proposals.list", { agentId: "ops" });
  });

  it("discards selected proposal detail that resolves after the agent scope changes", async () => {
    const detail = createDeferred<ReturnType<typeof inspectResult>>();
    const { state, context, request } = createFixture(
      {
        skillWorkshopAgentId: "research",
        skillWorkshopProposals: [proposal({ body: "", bodyLoaded: false })],
      },
      {},
      ["skills.proposals.inspect"],
    );
    request.mockReturnValueOnce(detail.promise);

    const loading = selectSkillWorkshopProposal(state, context, "proposal-1");
    state.skillWorkshopAgentId = "ops";
    state.skillWorkshopProposals = [proposal({ body: "Ops proposal." })];
    state.skillWorkshopInspectingKey = "proposal-1";
    detail.resolve(inspectResult());
    await loading;

    expect(state.skillWorkshopProposals[0]?.body).toBe("Ops proposal.");
    expect(state.skillWorkshopInspectingKey).toBe("proposal-1");
    expect(state.skillWorkshopSelectedKey).toBeNull();
  });

  it("ignores a superseded selection and keeps its error out of the pane", async () => {
    const first = createDeferred<ReturnType<typeof inspectResult>>();
    const second = createDeferred<ReturnType<typeof inspectResult>>();
    const { state, context, request } = createFixture(
      {
        skillWorkshopAgentId: "research",
        skillWorkshopProposals: [
          proposal({ key: "proposal-1", body: "", bodyLoaded: false }),
          proposal({ key: "proposal-2", body: "", bodyLoaded: false }),
        ],
      },
      {},
      ["skills.proposals.inspect"],
    );
    request.mockImplementation(async (_method, payload) =>
      (payload as { proposalId: string }).proposalId === "proposal-1"
        ? first.promise
        : second.promise,
    );

    const stale = selectSkillWorkshopProposal(state, context, "proposal-1");
    const latest = selectSkillWorkshopProposal(state, context, "proposal-2");
    const base = inspectResult();
    second.resolve({ ...base, record: { ...base.record, id: "proposal-2" } });
    await latest;
    first.reject(new Error("inspect failed"));
    await stale;

    expect(state.skillWorkshopSelectedKey).toBe("proposal-2");
    expect(state.skillWorkshopError).toBeNull();
  });

  it("inspects a revision once even when its body is legitimately empty", async () => {
    const { state, context, request } = createFixture(
      {
        skillWorkshopAgentId: "research",
        skillWorkshopProposals: [proposal({ body: "", bodyLoaded: false })],
      },
      {},
      ["skills.proposals.inspect"],
    );
    const base = inspectResult();
    request.mockResolvedValue({ ...base, content: "" });

    await Promise.all([
      selectSkillWorkshopProposal(state, context, "proposal-1"),
      selectSkillWorkshopProposal(state, context, "proposal-1"),
    ]);
    await selectSkillWorkshopProposal(state, context, "proposal-1");

    expect(state.skillWorkshopProposals[0]?.body).toBe("");
    expect(state.skillWorkshopProposals[0]?.bodyLoaded).toBe(true);
    expect(
      request.mock.calls.filter(([method]) => method === "skills.proposals.inspect"),
    ).toHaveLength(1);
    expect(state.skillWorkshopSelectedKey).toBe("proposal-1");
  });
});
