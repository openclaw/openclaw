import { afterEach, expect, it, vi } from "vitest";
import { CHAT_ROUTE_READY_EVENT } from "../chat/chat-history-events.ts";
import { createDraftFixture } from "./draft-submission-flow.test-support.ts";
import {
  browserPreference,
  expectWorktreeName,
  acceptIdlePlacement,
  resetWorktreeMocks,
} from "./draft-worktree-checks.test-support.ts";
import {
  acceptedWorktreeSession,
  disposeWorktreeDraft,
  selectCloudWorktree,
  submitPendingWorktree,
} from "./draft-worktree-submission.test-support.ts";

afterEach(resetWorktreeMocks);

async function namedWorktreeFixture(explicitBase = true, restore = false) {
  const fixture = createDraftFixture({
    scopes: ["operator.admin", "operator.read", "operator.write"],
    methods: ["sessions.create", "sessions.dispatch"],
    agents: [
      {
        id: "main",
        workspace: "/repo",
        workspaceGit: true,
        model: { primary: "openai/gpt-5.6-luna" },
      },
    ],
    request: async (method) =>
      method === "worktrees.branches"
        ? { repositoryStatus: "git", branches: ["main"], defaultBranch: "main" }
        : { status: "ok", endedAt: 1 },
  });
  await vi.waitFor(() => expect(fixture.place.repository.kind).toBe("git"));
  if (!restore) {
    fixture.place.selectWorktree(true);
    if (explicitBase) {
      fixture.place.setBaseRef("main");
    }
    fixture.place.setWorktreeName(explicitBase ? "first-task" : "  first-task  ");
  }
  fixture.flow.setMessage("first task");
  vi.mocked(fixture.context.navigateAndWait).mockImplementation(async () => {
    queueMicrotask(() => document.dispatchEvent(new Event(CHAT_ROUTE_READY_EVENT)));
  });
  return { ...fixture, create: vi.mocked(fixture.context.sessions.createResult) };
}

it.each([true, false])("consumes accepted names, explicit base=%s", async (explicitBase) => {
  const { create, flow, place } = await namedWorktreeFixture(explicitBase);
  if (!explicitBase) {
    expect(browserPreference()?.baseRef).toBeUndefined();
  }
  create.mockResolvedValue(acceptedWorktreeSession);
  expect(flow.submitDisabledReason()).toBeUndefined();
  await flow.submit(undefined, !explicitBase);
  expectWorktreeName(place);
  if (explicitBase) {
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        worktree: true,
        worktreeName: "first-task",
        worktreeBaseRef: "main",
      }),
      {
        reconciliation: "background",
        signal: expect.any(AbortSignal),
      },
    );
    expect(place).toMatchObject({ worktree: true, baseRef: "main" });
    expect(browserPreference()).toMatchObject({ worktree: true, baseRef: "main" });
    const next = await namedWorktreeFixture(true, true);
    next.flow.setMessage("next task");
    next.create.mockResolvedValue(acceptedWorktreeSession);
    await next.flow.submit(undefined, true);
    expect(next.create).toHaveBeenCalledOnce();
    expect(next.create.mock.calls[0]![0]).not.toHaveProperty("worktreeName");
  }
});
it.each(["null", "throw", "rejected"])("retains the name after %s admission", async (outcome) => {
  const { create, flow, place } = await namedWorktreeFixture();
  if (outcome === "throw") {
    create.mockRejectedValue(new Error("admission failed"));
  } else {
    create.mockResolvedValue(
      outcome === "null"
        ? null
        : {
            key: "agent:main:dashboard:first",
            initialRun: { status: "rejected", error: "worktree unavailable" },
          },
    );
  }
  await flow.submit(undefined, true);
  expect(create).toHaveBeenCalledOnce();
  expectWorktreeName(place, "first-task");
});

it.each(["reconnect", "same name again", "new repository", "new principal"])(
  "late acceptance respects %s",
  async (change) => {
    const fixture = await namedWorktreeFixture();
    const { context, flow, place, gateway } = fixture;
    const { admitted, submitting } = await submitPendingWorktree(fixture);
    flow.invalidate(change === "reconnect" ? "gateway-changed" : null);
    if (change !== "reconnect" && change !== "new principal") {
      flow.resetDraft();
    }
    if (change === "same name again") {
      place.setWorktreeName("next-task");
      place.setWorktreeName("first-task");
    }
    if (change === "new repository") {
      place.applyFolder("/other-repo");
      place.selectWorktree(true);
      place.setWorktreeName("first-task");
    }
    if (change === "new principal") {
      Object.assign(context.gateway.snapshot.client!, { recoveryScope: "principal-b" });
      Object.assign(context.gateway.snapshot.hello!.auth!, { recoveryScope: "principal-b" });
      gateway.synchronize(context.gateway);
    }
    admitted.resolve(acceptedWorktreeSession);
    await submitting;
    expect(place.worktreeName).toBe(change === "reconnect" ? "" : "first-task");
    expect(context.navigateAndWait).not.toHaveBeenCalled();
  },
);

it.each([false, true])("retries frozen placement, restored=%s", async (restored) => {
  const first = await namedWorktreeFixture();
  selectCloudWorktree(first);
  const start = vi.fn();
  first.context.placementStartup.start = start;
  first.create.mockResolvedValue(null);
  expect(first.flow.submitDisabledReason()).toBeUndefined();
  await first.flow.submit(undefined, true);
  expect(first.create).toHaveBeenCalledOnce();
  expect(start).not.toHaveBeenCalled();
  expect(first.place.worktreeName).toBe("first-task");
  expect(first.flow.pendingPlacement).toMatchObject({
    createParams: { worktreeName: "first-task" },
    phase: "creating",
  });
  const original = first.create.mock.calls[0]![0];
  if (restored) {
    disposeWorktreeDraft(first);
  }
  const retry = restored ? await namedWorktreeFixture(true, true) : first;
  if (restored) {
    expect(retry.flow.pendingPlacement.sessionKey).toBe(original!.key);
    expect(retry.place.worktreeName).toBe("");
  }
  retry.context.placementStartup.start = start;
  acceptIdlePlacement(retry);
  expect(retry.flow.submitDisabledReason()).toBeUndefined();
  await retry.flow.submit(undefined, true);
  expect(retry.create).toHaveBeenCalledTimes(restored ? 1 : 2);
  expect(retry.create).toHaveBeenLastCalledWith(original, {
    reconciliation: "background",
    signal: expect.any(AbortSignal),
  });
  expect(start).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      recovery: expect.objectContaining({ sessionKey: original!.key, phase: "dispatching" }),
      persistRecovery: true,
    }),
  );
  expectWorktreeName(retry.place);
});
