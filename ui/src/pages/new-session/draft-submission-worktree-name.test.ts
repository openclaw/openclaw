import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { SessionCreateOutcome } from "../../lib/sessions/create.ts";
import { CHAT_ROUTE_READY_EVENT } from "../chat/chat-history-events.ts";
import { createDraftFixture } from "./draft-submission-flow.test-support.ts";
import {
  acceptedWorktreeSession,
  disposeWorktreeDraft,
  selectCloudWorktree,
} from "./draft-worktree-submission.test-support.ts";
import { loadNewSessionPreference } from "./preferences.ts";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

async function namedWorktreeFixture(explicitBase = true, name = "first-task", restore = false) {
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
    fixture.place.setWorktreeName(name);
  }
  fixture.flow.setMessage("first task");
  vi.mocked(fixture.context.navigateAndWait).mockImplementation(async () => {
    queueMicrotask(() => document.dispatchEvent(new Event(CHAT_ROUTE_READY_EVENT)));
  });
  return fixture;
}

describe("submitted custom worktree names", () => {
  it.each([true, false])(
    "consumes an accepted name with explicit base=%s",
    async (explicitBase) => {
      const { context, flow, place } = await namedWorktreeFixture(
        explicitBase,
        explicitBase ? "first-task" : "  first-task  ",
      );
      if (!explicitBase) {
        expect(loadNewSessionPreference("ws://gateway.example", "main")?.baseRef).toBeUndefined();
      }
      vi.mocked(context.sessions.createResult).mockResolvedValue(acceptedWorktreeSession);
      expect(flow.submitDisabledReason()).toBeUndefined();
      await flow.submit(undefined, !explicitBase);
      expect(place.worktreeName).toBe("");
      expect(
        loadNewSessionPreference("ws://gateway.example", "main")?.worktreeName,
      ).toBeUndefined();
      if (explicitBase) {
        expect(context.sessions.createResult).toHaveBeenCalledWith(
          expect.objectContaining({
            worktree: true,
            worktreeName: "first-task",
            worktreeBaseRef: "main",
          }),
          { reconciliation: "background" },
        );
        expect(place.worktree).toBe(true);
        expect(place.baseRef).toBe("main");
        expect(loadNewSessionPreference("ws://gateway.example", "main")).toMatchObject({
          worktree: true,
          baseRef: "main",
        });
        const next = await namedWorktreeFixture(true, "", true);
        next.flow.setMessage("next task");
        vi.mocked(next.context.sessions.createResult).mockResolvedValue({
          key: "agent:main:dashboard:next",
          initialRun: { status: "started", runId: "next-run" },
        });
        await next.flow.submit(undefined, true);
        expect(next.context.sessions.createResult).toHaveBeenCalledOnce();
        expect(vi.mocked(next.context.sessions.createResult).mock.calls[0]![0]).not.toHaveProperty(
          "worktreeName",
        );
      }
    },
  );
  it.each(["null", "throw", "rejected"])("retains the name after %s admission", async (outcome) => {
    const { context, flow, place } = await namedWorktreeFixture();
    const create = vi.mocked(context.sessions.createResult);
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
    expect(place.worktreeName).toBe("first-task");
    expect(loadNewSessionPreference("ws://gateway.example", "main")?.worktreeName).toBe(
      "first-task",
    );
  });

  it.each(["reconnect", "same name again", "new repository", "new principal"])(
    "late acceptance retires only its captured selection: %s",
    async (change) => {
      const { context, flow, place, gateway } = await namedWorktreeFixture();
      const admitted = createDeferred<SessionCreateOutcome>();
      vi.mocked(context.sessions.createResult).mockReturnValue(admitted.promise);
      const submitting = flow.submit(undefined, true);
      await vi.waitFor(() => expect(context.sessions.createResult).toHaveBeenCalledOnce());
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

  it.each([false, true])(
    "preserves frozen placement custody through a retry, restored=%s",
    async (restored) => {
      const first = await namedWorktreeFixture();
      selectCloudWorktree(first);
      const start = vi.fn();
      first.context.placementStartup.start = start;
      vi.mocked(first.context.sessions.createResult).mockResolvedValue(null);
      expect(first.flow.submitDisabledReason()).toBeUndefined();
      await first.flow.submit(undefined, true);
      expect(first.context.sessions.createResult).toHaveBeenCalledOnce();
      expect(start).not.toHaveBeenCalled();
      expect(first.place.worktreeName).toBe("first-task");
      expect(first.flow.pendingPlacement.createParams?.worktreeName).toBe("first-task");
      expect(first.flow.pendingPlacement.phase).toBe("creating");
      const original = vi.mocked(first.context.sessions.createResult).mock.calls[0]![0];
      if (restored) {
        disposeWorktreeDraft(first);
      }
      const retry = restored ? await namedWorktreeFixture(true, "", true) : first;
      if (restored) {
        expect(retry.flow.pendingPlacement.sessionKey).toBe(original!.key);
        expect(retry.place.worktreeName).toBe("");
      }
      retry.context.placementStartup.start = start;
      vi.mocked(retry.context.sessions.createResult).mockImplementation(async (params) => ({
        key: params!.key!,
        initialRun: { status: "idle" },
      }));
      expect(retry.flow.submitDisabledReason()).toBeUndefined();
      await retry.flow.submit(undefined, true);
      if (restored) {
        expect(retry.context.sessions.createResult).toHaveBeenCalledExactlyOnceWith(original, {
          reconciliation: "background",
        });
      } else {
        expect(vi.mocked(retry.context.sessions.createResult).mock.calls[1]![0]).toEqual(original);
      }
      expect(start).toHaveBeenCalledOnce();
      expect(start).toHaveBeenCalledWith(
        expect.objectContaining({
          recovery: expect.objectContaining({ sessionKey: original!.key, phase: "dispatching" }),
          persistRecovery: true,
        }),
      );
      expect(retry.place.worktreeName).toBe("");
      expect(
        loadNewSessionPreference("ws://gateway.example", "main")?.worktreeName,
      ).toBeUndefined();
    },
  );
});
