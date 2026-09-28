// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { SkillWorkshopProposal } from "../../lib/skill-workshop/index.ts";
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
  UPDATED_REVISION_HASH,
} from "../../test-helpers/skill-workshop-proposal-fixture.ts";
import {
  requestSkillWorkshopRevision,
  runSkillWorkshopEvaluation,
  runSkillWorkshopLifecycleAction,
} from "./proposal-actions.ts";
import {
  loadSkillWorkshopProposals,
  selectSkillWorkshopProposal,
  type SkillWorkshopState,
} from "./proposals.ts";

function mutationResponse(
  action: "apply" | "reject",
  status: SkillWorkshopProposal["status"],
): unknown {
  const record = recordFrom(status);
  return action === "apply" ? { record, targetSkillFile: "skills/inbox-cleaner/SKILL.md" } : record;
}

function terminalStatusFor(action: "apply" | "reject"): SkillWorkshopProposal["status"] {
  return action === "apply" ? "applied" : "rejected";
}

// Asserts the leak-free invariant shared by every in-flight agent-scope switch
// case: neither the notice nor the originating terminal row nor the
// unconfirmed-status error may surface in the new agent's workspace.
function expectNoLeak(state: SkillWorkshopState, action: "apply" | "reject"): void {
  const terminalStatus = terminalStatusFor(action);
  expect(state.skillWorkshopActionNotice).toBeNull();
  expect(
    state.skillWorkshopProposals.some(
      (item) => item.key === "proposal-1" && item.status === terminalStatus,
    ),
  ).toBe(false);
  expect(state.skillWorkshopError ?? "").not.toContain("did not confirm as expected");
}

describe("Skill Workshop proposal lifecycle actions", () => {
  it.each([
    ["apply", "skills.proposals.apply", "applied"],
    ["reject", "skills.proposals.reject", "rejected"],
  ] as const)(
    "%s sends the selected agent id and refreshes that agent scope",
    async (action, method, status) => {
      const { state, context, request } = createFixture(
        {
          skillWorkshopProposals: [proposal()],
          skillWorkshopSelectedKey: "proposal-1",
        },
        { assistantAgentId: "reviewer" },
        [method, "skills.proposals.list", "skills.proposals.inspect"],
      );
      request.mockImplementation(async (calledMethod: string) => {
        if (calledMethod === method) {
          return mutationResponse(action, status);
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
        await runSkillWorkshopLifecycleAction(state, context, action, proposalDecision());
      } finally {
        clearNoticeTimer(state);
      }

      expect(request).toHaveBeenNthCalledWith(1, method, {
        agentId: "reviewer",
        expectedRevisionHash: REVISION_HASH,
        proposalId: "proposal-1",
      });
      expect(request).toHaveBeenNthCalledWith(2, "skills.proposals.list", {
        agentId: "reviewer",
      });
      expect(request.mock.calls.map(([calledMethod]) => calledMethod)).toEqual([
        method,
        "skills.proposals.list",
      ]);
    },
  );

  it.each(
    (
      [
        ["shows the terminal notice from the authoritative mutation record", "success", "ok"],
        [
          "withholds the success notice when the mutation record is not terminal",
          "unconfirmed",
          "ok",
        ],
        ["keeps the authoritative success notice when the refresh fails", "success", "fails"],
        ["withholds success for an absent action record", "absent", "ok"],
        ["withholds success for another proposal's action record", "wrong-id", "ok"],
      ] as const
    ).flatMap(([name, outcome, refresh]) =>
      (["apply", "reject"] as const).map((action) => ({ name, action, outcome, refresh })),
    ),
  )("$name ($action)", async ({ action, outcome, refresh }) => {
    const method = `skills.proposals.${action}`;
    const terminal = terminalStatusFor(action);
    const mutationStatus: SkillWorkshopProposal["status"] =
      outcome === "unconfirmed" ? "pending" : terminal;
    const { state, context, request } = createFixture(
      { skillWorkshopProposals: [proposal()], skillWorkshopSelectedKey: "proposal-1" },
      {},
      [method, "skills.proposals.list", "skills.proposals.inspect"],
    );
    request.mockImplementation(async (calledMethod: string) => {
      if (calledMethod === method) {
        if (outcome === "absent") {
          return action === "apply" ? { targetSkillFile: "skills/inbox-cleaner/SKILL.md" } : null;
        }
        if (outcome === "wrong-id") {
          const record = { ...recordFrom(terminal), id: "another-proposal" };
          return action === "apply" ? { record, targetSkillFile: "skills/other/SKILL.md" } : record;
        }
        return mutationResponse(action, mutationStatus);
      }
      if (calledMethod === "skills.proposals.list") {
        if (refresh === "fails") {
          throw new Error("refresh failed");
        }
        return manifest(mutationStatus);
      }
      if (calledMethod === "skills.proposals.inspect") {
        if (refresh === "fails") {
          throw new Error("refresh inspect failed");
        }
        return inspectResult(mutationStatus);
      }
      return {};
    });

    try {
      await runSkillWorkshopLifecycleAction(state, context, action, proposalDecision());
    } finally {
      clearNoticeTimer(state);
    }

    if (outcome !== "success") {
      expect(state.skillWorkshopActionNotice?.label).not.toBe(
        action === "apply" ? "Applied" : "Rejected",
      );
      expect(state.skillWorkshopError).toContain("did not confirm as expected");
      expect(state.skillWorkshopProposals[0]?.status).toBe("pending");
      expect(state.skillWorkshopProposals).toHaveLength(1);
      return;
    }
    expect(state.skillWorkshopActionNotice?.label).toBe(
      action === "apply" ? "Applied" : "Rejected",
    );
    expect(state.skillWorkshopProposals[0]?.status).toBe(terminal);
    if (refresh === "ok") {
      expect(state.skillWorkshopError).toBeNull();
    } else {
      expect(state.skillWorkshopError ?? "").not.toContain("did not confirm as expected");
    }
  });

  it.each(
    (["apply", "reject"] as const).flatMap((action) =>
      (["success", "failure"] as const).map((refresh) => ({ action, refresh })),
    ),
  )(
    "$action publishes its complete receipt before a held $refresh refresh",
    async ({ action, refresh }) => {
      const updatedAt = "2026-06-16T12:05:00.000Z";
      const terminal = terminalStatusFor(action);
      const evaluation: NonNullable<SkillWorkshopProposal["evaluation"]> = {
        id: "evaluation-reviewed",
        proposedVersion: "v7",
        revisionHash: REVISION_HASH,
        trigger: "manual",
        startedAt: ISO_NOW,
        completedAt: ISO_NOW,
        outcomes: [],
      };
      const reviewed = proposal({
        body: "Review every unread thread. Confirm recipients before archiving.",
        version: 7,
        evaluation,
        supportFiles: [
          { path: "references/review.md", size: "15 B", contents: "Check recipients" },
          { path: "scripts/review.sh", size: "18 B", contents: "review --dry-run" },
        ],
      });
      const { state, context, request } = createFixture(
        {
          skillWorkshopAgentId: "research",
          skillWorkshopProposals: [reviewed],
          skillWorkshopSelectedKey: reviewed.key,
        },
        {},
        [`skills.proposals.${action}`, "skills.proposals.list", "skills.proposals.inspect"],
      );
      const list = createDeferred<ReturnType<typeof manifest>>();
      const record = {
        ...recordFrom(terminal),
        proposedVersion: "v7",
        updatedAt,
        evaluation: { ...evaluation, id: "evaluation-confirmed" },
      };
      request.mockImplementation(async (method) => {
        if (method === `skills.proposals.${action}`) {
          return action === "apply"
            ? { record, targetSkillFile: "skills/inbox-cleaner/SKILL.md" }
            : record;
        }
        if (method === "skills.proposals.list") {
          return list.promise;
        }
        throw new Error("inspection unavailable after confirmation");
      });
      const onProgress = vi.fn();
      const actionPromise = runSkillWorkshopLifecycleAction(
        state,
        context,
        action,
        proposalDecision(),
        { onProgress },
      );
      try {
        await vi.waitFor(() =>
          expect(request).toHaveBeenCalledWith("skills.proposals.list", { agentId: "research" }),
        );
        expect(state.skillWorkshopProposals[0]).toMatchObject({
          status: terminal,
          body: reviewed.body,
          bodyLoaded: true,
          supportFiles: reviewed.supportFiles,
          version: 7,
          revisionHash: REVISION_HASH,
          updatedAt: Date.parse(updatedAt),
          evaluation: { id: "evaluation-confirmed", revisionHash: REVISION_HASH },
        });
        expect(state.skillWorkshopActionNotice?.label).toBe(
          action === "apply" ? "Applied" : "Rejected",
        );
        expect(onProgress).toHaveBeenCalled();
        if (refresh === "failure") {
          list.reject(new Error("receipt refresh unavailable"));
        } else {
          const current = manifest(terminal);
          current.proposals[0]!.updatedAt = updatedAt;
          list.resolve(current);
        }
        await actionPromise;
        expect(state.skillWorkshopProposals[0]).toMatchObject({
          status: terminal,
          body: reviewed.body,
          bodyLoaded: true,
          supportFiles: reviewed.supportFiles,
          version: 7,
          revisionHash: REVISION_HASH,
          evaluation: { id: "evaluation-confirmed" },
        });
        expect(state.skillWorkshopActionNotice?.label).toBe(
          action === "apply" ? "Applied" : "Rejected",
        );
        if (refresh === "failure") {
          expect(state.skillWorkshopError).toContain("receipt refresh unavailable");
        }
      } finally {
        list.resolve(manifest(terminal));
        await actionPromise;
        clearNoticeTimer(state);
      }
    },
  );

  it.each(["pending", "error"] as const)(
    "ignores an earlier list's %s result while the action refresh owns loading and selection",
    async (outcome) => {
      const oldList = createDeferred<ReturnType<typeof manifest>>();
      const newList = createDeferred<ReturnType<typeof manifest>>();
      const second = proposal({ key: "proposal-2", name: "Second suggestion" });
      const { state, context, request } = createFixture(
        {
          skillWorkshopAgentId: "research",
          skillWorkshopProposals: [proposal(), second],
          skillWorkshopSelectedKey: "proposal-1",
        },
        {},
        ["skills.proposals.apply", "skills.proposals.list", "skills.proposals.inspect"],
      );
      let listCount = 0;
      request.mockImplementation(async (method) => {
        if (method === "skills.proposals.apply") {
          return mutationResponse("apply", "applied");
        }
        if (method === "skills.proposals.list") {
          listCount += 1;
          return listCount === 1 ? oldList.promise : newList.promise;
        }
        throw new Error("unexpected inspection");
      });
      const oldLoad = loadSkillWorkshopProposals(state, context, { force: true });
      const action = runSkillWorkshopLifecycleAction(state, context, "apply", proposalDecision());
      try {
        await vi.waitFor(() => expect(listCount).toBe(2));
        await selectSkillWorkshopProposal(state, context, "proposal-2");
        if (outcome === "pending") {
          oldList.resolve(manifest("pending"));
        } else {
          oldList.reject(new Error("retired list failure"));
        }
        await oldLoad;
        expect(state.skillWorkshopProposals.find((item) => item.key === "proposal-1")?.status).toBe(
          "applied",
        );
        expect(state.skillWorkshopSelectedKey).toBe("proposal-2");
        expect(state.skillWorkshopLoading).toBe(true);
        expect(state.skillWorkshopError).toBeNull();
        newList.reject(new Error("current list failure"));
        await action;
        expect(state.skillWorkshopLoading).toBe(false);
        expect(state.skillWorkshopError).toContain("current list failure");
        expect(state.skillWorkshopSelectedKey).toBe("proposal-2");
        expect(state.skillWorkshopActionNotice?.label).toBe("Applied");
      } finally {
        oldList.resolve(manifest());
        newList.resolve(manifest("applied"));
        await Promise.all([oldLoad, action]);
        clearNoticeTimer(state);
      }
    },
  );

  it.each(["pending", "error"] as const)(
    "ignores an earlier detail's %s result after confirmation while a newer selection loads",
    async (outcome) => {
      const oldDetail = createDeferred<ReturnType<typeof inspectResult>>();
      const newDetail = createDeferred<ReturnType<typeof inspectResult>>();
      const { state, context, request } = createFixture(
        {
          skillWorkshopAgentId: "research",
          skillWorkshopProposals: [proposal({ bodyLoaded: false })],
          skillWorkshopSelectedKey: "proposal-1",
        },
        {},
        ["skills.proposals.reject", "skills.proposals.list", "skills.proposals.inspect"],
      );
      request.mockImplementation(async (method, payload) => {
        if (method === "skills.proposals.reject") {
          return mutationResponse("reject", "rejected");
        }
        if (method === "skills.proposals.list") {
          const current = manifest("rejected");
          current.proposals.push({ ...manifest().proposals[0]!, id: "proposal-2" });
          return current;
        }
        return (payload as { proposalId: string }).proposalId === "proposal-1"
          ? oldDetail.promise
          : newDetail.promise;
      });
      const oldSelection = selectSkillWorkshopProposal(state, context, "proposal-1");
      const action = runSkillWorkshopLifecycleAction(state, context, "reject", proposalDecision());
      try {
        await vi.waitFor(() => expect(state.skillWorkshopInspectingKey).toBe("proposal-2"));
        if (outcome === "pending") {
          oldDetail.resolve(inspectResult("pending"));
        } else {
          oldDetail.reject(new Error("retired inspection failure"));
        }
        await oldSelection;
        expect(state.skillWorkshopProposals.find((item) => item.key === "proposal-1")?.status).toBe(
          "rejected",
        );
        expect(state.skillWorkshopSelectedKey).toBe("proposal-2");
        expect(state.skillWorkshopInspectingKey).toBe("proposal-2");
        expect(state.skillWorkshopError).toBeNull();
        newDetail.reject(new Error("current inspection failure"));
        await action;
        expect(state.skillWorkshopInspectingKey).toBeNull();
        expect(state.skillWorkshopError).toContain("current inspection failure");
        expect(state.skillWorkshopActionNotice?.label).toBe("Rejected");
      } finally {
        oldDetail.resolve(inspectResult());
        newDetail.resolve({
          ...inspectResult(),
          record: { ...inspectResult().record, id: "proposal-2" },
        });
        await Promise.all([oldSelection, action]);
        clearNoticeTimer(state);
      }
    },
  );

  it("a controller without page scope retains its receipt when disconnected before refresh", async () => {
    const method = "skills.proposals.apply";
    const { state, context, request, snapshot } = createFixture(
      {
        skillWorkshopProposals: [proposal()],
        skillWorkshopSelectedKey: "proposal-1",
      },
      {},
      [method, "skills.proposals.list", "skills.proposals.inspect"],
    );
    let connectionDropped = false;
    request.mockImplementation(async (calledMethod: string) => {
      if (calledMethod === method) {
        // The apply RPC returns the committed applied record, then the gateway
        // connection drops before the refresh, so both loaders silently early-
        // return and the merged applied row is preserved.
        connectionDropped = true;
        snapshot.phase = "reconnecting";
        return mutationResponse("apply", "applied");
      }
      if (calledMethod === "skills.proposals.list") {
        expect(connectionDropped).toBe(false);
        return manifest("pending");
      }
      if (calledMethod === "skills.proposals.inspect") {
        return inspectResult("pending");
      }
      return {};
    });

    try {
      await runSkillWorkshopLifecycleAction(state, context, "apply", proposalDecision());
    } finally {
      clearNoticeTimer(state);
    }

    expect(request).toHaveBeenCalledWith(method, {
      agentId: "research",
      expectedRevisionHash: REVISION_HASH,
      proposalId: "proposal-1",
    });
    expect(state.skillWorkshopActionNotice?.label).toBe("Applied");
    expect(state.skillWorkshopProposals[0]?.status).toBe("applied");
    expect(state.skillWorkshopError).toBeNull();
  });

  it.each(
    (
      [
        ["does not publish the terminal result across an in-flight scope switch", "success", false],
        [
          "does not publish the terminal result across a scope switch with a dropped connection",
          "success",
          true,
        ],
        [
          "does not write the unconfirmed-status error across an in-flight scope switch",
          "unconfirmed",
          false,
        ],
        [
          "does not show the revision-changed notice across an in-flight scope switch",
          "revision",
          false,
        ],
        [
          "does not write the generic action error across an in-flight scope switch",
          "generic",
          false,
        ],
      ] as const
    ).flatMap(([name, mode, disconnect]) =>
      (["apply", "reject"] as const).map((action) => ({ name, action, mode, disconnect })),
    ),
  )("$name ($action)", async ({ action, mode, disconnect }) => {
    const method = `skills.proposals.${action}`;
    const terminal = terminalStatusFor(action);
    const { state, context, request, snapshot } = createFixture(
      {
        skillWorkshopAgentId: "research",
        skillWorkshopProposals: [proposal()],
        skillWorkshopSelectedKey: "proposal-1",
      },
      {},
      [method, "skills.proposals.list", "skills.proposals.inspect"],
    );
    const deferred = createDeferred<ReturnType<typeof mutationResponse>>();
    request.mockImplementation(async (calledMethod: string) => {
      if (calledMethod === method) {
        return deferred.promise;
      }
      if (disconnect) {
        return {};
      }
      if (calledMethod === "skills.proposals.list") {
        // After the switch the new scope's list has no proposal-1, so any
        // appearing applied row would only come from an unscoped leak.
        return mode === "success"
          ? { schema: manifest().schema, updatedAt: manifest().updatedAt, proposals: [] }
          : manifest("pending");
      }
      if (calledMethod === "skills.proposals.inspect") {
        if (mode === "success") {
          throw new Error("proposal not in scope");
        }
        return inspectResult("pending");
      }
      return {};
    });

    let actionPromise: Promise<void>;
    try {
      actionPromise = runSkillWorkshopLifecycleAction(state, context, action, proposalDecision());
      // The mutation is in flight when the explicitly selected agent changes
      // (and, optionally, the connection drops before the refresh can run).
      snapshot.assistantAgentId = "ops";
      if (disconnect) {
        snapshot.phase = "reconnecting";
      }
      if (mode === "revision") {
        deferred.reject(
          new GatewayRequestError({
            code: "INVALID_REQUEST",
            message: "Skill proposal revision changed",
            details: {
              code: "SKILL_PROPOSAL_REVISION_CHANGED",
              currentRevisionHash: UPDATED_REVISION_HASH,
              expectedRevisionHash: REVISION_HASH,
            },
          }),
        );
      } else if (mode === "generic") {
        deferred.reject(new Error(`${action} failed`));
      } else {
        deferred.resolve(mutationResponse(action, mode === "unconfirmed" ? "pending" : terminal));
      }
      await actionPromise;
    } finally {
      clearNoticeTimer(state);
    }

    expect(request).toHaveBeenCalledWith(method, {
      agentId: "research",
      expectedRevisionHash: REVISION_HASH,
      proposalId: "proposal-1",
    });
    const calledMethods = request.mock.calls.map(([calledMethod]) => calledMethod);
    expect(calledMethods).not.toContain("skills.proposals.list");
    expect(calledMethods).not.toContain("skills.proposals.inspect");
    expectNoLeak(state, action);
    if (mode === "generic") {
      expect(state.skillWorkshopError).toBeNull();
    }
  });

  it.each(["apply", "reject"] as const)(
    "%s refuses to act without the reviewed revision hash",
    async (action) => {
      const method = `skills.proposals.${action}`;
      const { state, context, request } = createFixture(
        { skillWorkshopProposals: [proposal({ revisionHash: null })] },
        {},
        [method],
      );

      await runSkillWorkshopLifecycleAction(state, context, action, proposalDecision(null));

      expect(request).not.toHaveBeenCalled();
      expect(state.skillWorkshopError).toBe(
        "The current suggestion revision could not be identified.",
      );
    },
  );

  it.each([
    ["apply", "skills.proposals.apply"],
    ["reject", "skills.proposals.reject"],
  ] as const)(
    "%s refreshes a changed proposal without replaying the stale decision",
    async (action, method) => {
      const updatedAt = "2026-06-16T12:01:00.000Z";
      const updatedManifest = manifest();
      updatedManifest.updatedAt = updatedAt;
      updatedManifest.proposals[0] = {
        ...updatedManifest.proposals[0]!,
        description: "Clean inbox triage with an explicit archive review",
        updatedAt,
      };
      const updatedInspect = inspectResult();
      updatedInspect.record = {
        ...updatedInspect.record,
        description: "Clean inbox triage with an explicit archive review",
        proposedVersion: "v2",
        updatedAt,
      };
      updatedInspect.revisionHash = UPDATED_REVISION_HASH;
      updatedInspect.content = "Review unread mail, confirm archive candidates, then archive.";
      const { state, context, request } = createFixture(
        {
          skillWorkshopAgentId: "reviewer",
          skillWorkshopProposals: [proposal()],
          skillWorkshopSelectedKey: "proposal-1",
        },
        { assistantAgentId: "reviewer" },
        [method, "skills.proposals.list", "skills.proposals.inspect"],
      );
      let stale = true;
      let committed = false;
      request.mockImplementation(async (calledMethod: string) => {
        if (calledMethod === method) {
          if (stale) {
            stale = false;
            throw new GatewayRequestError({
              code: "INVALID_REQUEST",
              message: "Skill proposal revision changed",
              details: {
                code: "SKILL_PROPOSAL_REVISION_CHANGED",
                currentRevisionHash: UPDATED_REVISION_HASH,
                expectedRevisionHash: REVISION_HASH,
              },
            });
          }
          committed = true;
          const record = {
            ...recordFrom(terminalStatusFor(action)),
            proposedVersion: "v2",
            updatedAt,
          };
          return action === "apply"
            ? { record, targetSkillFile: "skills/inbox-cleaner/SKILL.md" }
            : record;
        }
        if (calledMethod === "skills.proposals.list") {
          return committed
            ? {
                ...updatedManifest,
                proposals: updatedManifest.proposals.map((entry) => ({
                  ...entry,
                  status: terminalStatusFor(action),
                })),
              }
            : updatedManifest;
        }
        if (calledMethod === "skills.proposals.inspect") {
          return updatedInspect;
        }
        return {};
      });

      await runSkillWorkshopLifecycleAction(state, context, action, proposalDecision());

      const actionCalls = () =>
        request.mock.calls.filter(([calledMethod]) => calledMethod === method);
      expect(actionCalls()).toEqual([
        [
          method,
          {
            agentId: "reviewer",
            expectedRevisionHash: REVISION_HASH,
            proposalId: "proposal-1",
          },
        ],
      ]);
      expect(state.skillWorkshopProposals[0]).toMatchObject({
        body: "Review unread mail, confirm archive candidates, then archive.",
        revisionHash: UPDATED_REVISION_HASH,
        version: 2,
      });
      expect(state.skillWorkshopActionNotice).toMatchObject({
        key: "proposal-1",
        label: "Suggestion changed. Review the updated draft before choosing another action.",
      });
      expect(state.skillWorkshopActionNoticeTimer).toBeNull();
      expect(state.skillWorkshopError).toBeNull();

      try {
        await runSkillWorkshopLifecycleAction(
          state,
          context,
          action,
          proposalDecision(UPDATED_REVISION_HASH),
        );
      } finally {
        clearNoticeTimer(state);
      }

      expect(actionCalls()).toHaveLength(2);
      expect(actionCalls()[1]).toEqual([
        method,
        {
          agentId: "reviewer",
          expectedRevisionHash: UPDATED_REVISION_HASH,
          proposalId: "proposal-1",
        },
      ]);
      expect(state.skillWorkshopProposals[0]).toMatchObject({
        status: terminalStatusFor(action),
        revisionHash: UPDATED_REVISION_HASH,
        version: 2,
      });
      expect(state.skillWorkshopActionNotice?.label).toBe(
        action === "apply" ? "Applied" : "Rejected",
      );
    },
  );

  it("evaluates the freshly inspected revision and merges the attributed result", async () => {
    const evaluation = {
      id: "evaluation-1",
      proposedVersion: "v1",
      revisionHash: REVISION_HASH,
      trigger: "manual",
      startedAt: ISO_NOW,
      completedAt: ISO_NOW,
      outcomes: [
        {
          pluginId: "quality-plugin",
          pluginVersion: "1.2.3",
          evaluatorId: "quality",
          status: "completed",
          result: {
            summary: "One blocking issue.",
            decision: "block",
            decisionReason: "The draft needs a rollback step.",
          },
        },
      ],
    } as const;
    const baseInspect = inspectResult();
    const evaluatedInspect = {
      ...baseInspect,
      record: { ...baseInspect.record, evaluation },
    };
    const evaluateResult = {
      record: evaluatedInspect.record,
      evaluation,
    };
    let inspectCalls = 0;
    const { state, context, request } = createFixture(
      {
        skillWorkshopAgentId: "research",
        skillWorkshopProposals: [proposal({ revisionHash: "c".repeat(64) })],
        skillWorkshopSelectedKey: "proposal-1",
      },
      {},
      ["skills.proposals.inspect", "skills.proposals.evaluate"],
    );
    request.mockImplementation(async (method: string) => {
      if (method === "skills.proposals.inspect") {
        inspectCalls += 1;
        return inspectCalls === 1 ? inspectResult() : evaluatedInspect;
      }
      if (method === "skills.proposals.evaluate") {
        return evaluateResult;
      }
      return {};
    });

    try {
      await expect(runSkillWorkshopEvaluation(state, context, "proposal-1")).resolves.toBe(true);
    } finally {
      clearNoticeTimer(state);
    }

    expect(request).toHaveBeenNthCalledWith(1, "skills.proposals.inspect", {
      agentId: "research",
      proposalId: "proposal-1",
    });
    expect(request).toHaveBeenNthCalledWith(2, "skills.proposals.evaluate", {
      agentId: "research",
      proposalId: "proposal-1",
      expectedRevisionHash: REVISION_HASH,
    });
    expect(request).toHaveBeenNthCalledWith(3, "skills.proposals.inspect", {
      agentId: "research",
      proposalId: "proposal-1",
    });
    expect(state.skillWorkshopProposals[0]?.evaluation?.outcomes[0]).toMatchObject({
      pluginId: "quality-plugin",
      evaluatorId: "quality",
      status: "completed",
      result: { decision: "block" },
    });
    const evaluated = state.skillWorkshopProposals[0]!;
    expect(evaluated.revisionHash).toBe(REVISION_HASH);
    expect(evaluated.body).toBe("Review unread mail and archive low-priority threads.");
    expect(evaluated.supportFiles).toEqual([]);
    expect(evaluated.slug).toBe("inbox-cleaner");
  });

  it("does not evaluate after the initiating source changes during inspection", async () => {
    const detail = createDeferred<ReturnType<typeof inspectResult>>();
    const { state, context, request } = createFixture(
      {
        skillWorkshopAgentId: "research",
        skillWorkshopProposals: [proposal({ body: "", bodyLoaded: false })],
      },
      {},
      ["skills.proposals.inspect", "skills.proposals.evaluate"],
    );
    let current = true;
    request.mockImplementation((method: string) =>
      method === "skills.proposals.inspect" ? detail.promise : Promise.resolve({}),
    );

    const evaluation = runSkillWorkshopEvaluation(state, context, "proposal-1", {
      isCurrent: () => current,
    });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    current = false;
    detail.resolve(inspectResult());

    await expect(evaluation).resolves.toBe(false);
    expect(request).not.toHaveBeenCalledWith("skills.proposals.evaluate", expect.anything());
  });

  it("drops an inspected evaluation that belongs to a different revision", async () => {
    const baseInspect = inspectResult();
    const { state, context, request } = createFixture(
      { skillWorkshopProposals: [proposal({ body: "", bodyLoaded: false })] },
      {},
      ["skills.proposals.inspect"],
    );
    request.mockResolvedValue({
      ...baseInspect,
      record: {
        ...baseInspect.record,
        evaluation: {
          id: "evaluation-stale",
          proposedVersion: "v0",
          revisionHash: "c".repeat(64),
          trigger: "manual",
          startedAt: ISO_NOW,
          completedAt: ISO_NOW,
          outcomes: [],
        },
      },
    });

    await selectSkillWorkshopProposal(state, context, "proposal-1");

    expect(state.skillWorkshopProposals[0]?.revisionHash).toBe(REVISION_HASH);
    expect(state.skillWorkshopProposals[0]?.evaluation).toBeUndefined();
  });

  it("rejects an evaluation response for a different revision", async () => {
    const baseInspect = inspectResult();
    const mismatchedEvaluation = {
      id: "evaluation-stale",
      proposedVersion: "v0",
      revisionHash: "c".repeat(64),
      trigger: "manual",
      startedAt: ISO_NOW,
      completedAt: ISO_NOW,
      outcomes: [],
    } as const;
    const { state, context, request } = createFixture(
      {
        skillWorkshopAgentId: "research",
        skillWorkshopProposals: [proposal()],
      },
      {},
      ["skills.proposals.inspect", "skills.proposals.evaluate"],
    );
    request.mockImplementation(async (method: string) =>
      method === "skills.proposals.inspect"
        ? baseInspect
        : {
            record: { ...baseInspect.record, evaluation: mismatchedEvaluation },
            evaluation: mismatchedEvaluation,
          },
    );

    await expect(runSkillWorkshopEvaluation(state, context, "proposal-1")).resolves.toBe(false);

    expect(state.skillWorkshopError).toBe("The suggestion revision changed during evaluation.");
    expect(state.skillWorkshopProposals[0]?.evaluation).toBeUndefined();
  });

  it("loads legacy inspect responses but refuses revision-sensitive evaluation", async () => {
    const { revisionHash: _revisionHash, ...legacyInspect } = inspectResult();
    const { state, context, request } = createFixture(
      {
        skillWorkshopAgentId: "research",
        skillWorkshopProposals: [proposal()],
      },
      {},
      ["skills.proposals.inspect", "skills.proposals.evaluate"],
    );
    request.mockResolvedValue(legacyInspect);

    await expect(runSkillWorkshopEvaluation(state, context, "proposal-1")).resolves.toBe(false);

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("skills.proposals.inspect", {
      agentId: "research",
      proposalId: "proposal-1",
    });
    expect(state.skillWorkshopError).toBe(
      "The current suggestion revision could not be identified.",
    );
    expect(state.skillWorkshopProposals[0]?.revisionHash).toBeNull();
  });

  it("preserves the loaded proposal agent for originless revisions", async () => {
    const { state, context } = createFixture(
      {
        skillWorkshopAgentId: "research",
        skillWorkshopProposals: [proposal()],
        skillWorkshopRevisionDraft: "Tighten the trigger.",
      },
      {},
      ["skills.proposals.requestRevision"],
    );
    const sendRevisionRequest = vi.fn(async () => ({
      id: "revision-1",
      sessionKey: "agent:research:workshop",
      status: "admitted" as const,
    }));

    try {
      await requestSkillWorkshopRevision(state, context, "proposal-1", sendRevisionRequest);
    } finally {
      clearNoticeTimer(state);
    }

    expect(sendRevisionRequest).toHaveBeenCalledWith(
      "Tighten the trigger.",
      expect.objectContaining({ key: "proposal-1" }),
      "research",
      REVISION_HASH,
    );
  });
});
