import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { SessionCreateOutcome } from "../../lib/sessions/create.ts";
import { CHAT_ROUTE_READY_EVENT } from "../chat/chat-history-events.ts";
import { createDraftFixture } from "./draft-submission-flow.test-support.ts";
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
  it.each([false, true])(
    "consumes an accepted name with background=%s without losing checkout preferences",
    async (background) => {
      const { context, flow, place } = await namedWorktreeFixture();
      vi.mocked(context.sessions.createResult).mockResolvedValue({
        key: "agent:main:dashboard:first",
        initialRun: { status: "started", runId: "first-run" },
      });
      expect(flow.submitDisabledReason()).toBeUndefined();
      await flow.submit(undefined, background);
      expect(context.sessions.createResult).toHaveBeenCalledWith(
        expect.objectContaining({
          worktree: true,
          worktreeName: "first-task",
          worktreeBaseRef: "main",
        }),
        { reconciliation: "background" },
      );
      expect(place.worktreeName).toBe("");
      expect(place.worktree).toBe(true);
      expect(place.baseRef).toBe("main");
      expect(loadNewSessionPreference("ws://gateway.example", "main")).toMatchObject({
        worktree: true,
        baseRef: "main",
      });
      expect(
        loadNewSessionPreference("ws://gateway.example", "main")?.worktreeName,
      ).toBeUndefined();
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

  it.each([
    "unchanged",
    "reconnect",
    "new name",
    "same name again",
    "new repository",
    "new principal",
  ])("late acceptance retires only its captured selection: %s", async (change) => {
    const { context, flow, place, gateway } = await namedWorktreeFixture();
    const admitted = createDeferred<SessionCreateOutcome>();
    vi.mocked(context.sessions.createResult).mockReturnValue(admitted.promise);
    const submitting = flow.submit(undefined, true);
    await vi.waitFor(() => expect(context.sessions.createResult).toHaveBeenCalledOnce());
    flow.invalidate(change === "reconnect" ? "gateway-changed" : null);
    if (change !== "unchanged" && change !== "reconnect" && change !== "new principal") {
      flow.resetDraft();
    }
    if (change === "new name") {
      place.setWorktreeName("next-task");
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
    admitted.resolve({
      key: "agent:main:dashboard:first",
      initialRun: { status: "started", runId: "first-run" },
    });
    await submitting;
    expect(place.worktreeName).toBe(
      change === "unchanged" || change === "reconnect"
        ? ""
        : change === "new name"
          ? "next-task"
          : "first-task",
    );
    expect(context.navigateAndWait).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "placement custody preserves retry's name with failed shell=%s",
    async (failed) => {
      const { context, flow, place, gateway } = await namedWorktreeFixture();
      vi.spyOn(gateway, "cloudProfiles", "get").mockReturnValue([
        { id: "cloud", providerId: "crabbox", executionModes: ["worker-turn", "remote-exec"] },
      ]);
      vi.spyOn(gateway, "cloudProfilesReady", "get").mockReturnValue(true);
      vi.spyOn(gateway, "cloudProfilesPending", "get").mockReturnValue(false);
      place.selectCloudProfile("cloud");
      const start = vi.fn();
      context.placementStartup.start = start;
      vi.mocked(context.sessions.createResult).mockImplementation(async (params) =>
        failed
          ? null
          : {
              key: params!.key!,
              initialRun: { status: "idle" },
            },
      );
      expect(flow.submitDisabledReason()).toBeUndefined();
      await flow.submit(undefined, true);
      expect(context.sessions.createResult).toHaveBeenCalledOnce();
      if (failed) {
        expect(start).not.toHaveBeenCalled();
        expect(place.worktreeName).toBe("first-task");
        expect(flow.pendingPlacement.createParams?.worktreeName).toBe("first-task");
        const original = vi.mocked(context.sessions.createResult).mock.calls[0]![0];
        vi.mocked(context.sessions.createResult).mockImplementation(async (params) => ({
          key: params!.key!,
          initialRun: { status: "idle" },
        }));
        expect(flow.submitDisabledReason()).toBeUndefined();
        await flow.submit(undefined, true);
        expect(vi.mocked(context.sessions.createResult).mock.calls[1]![0]).toEqual(original);
        expect(place.worktreeName).toBe("");
        expect(
          loadNewSessionPreference("ws://gateway.example", "main")?.worktreeName,
        ).toBeUndefined();
      } else {
        expect(start).toHaveBeenCalledWith(
          expect.objectContaining({
            recovery: expect.objectContaining({
              sessionKey: vi.mocked(context.sessions.createResult).mock.calls[0]![0]!.key,
              phase: "dispatching",
            }),
            persistRecovery: true,
          }),
        );
        expect(place.worktreeName).toBe("");
        expect(
          loadNewSessionPreference("ws://gateway.example", "main")?.worktreeName,
        ).toBeUndefined();
        // Retry dispatches the same created session, whose creation recorded the name.
        expect(vi.mocked(context.sessions.createResult).mock.calls[0]![0]).toMatchObject({
          worktreeName: "first-task",
        });
      }
    },
  );
});

it.each(["first-task", "  first-task  "])(
  "consumes %j with the discovered default base and implicit workspace folder",
  async (name) => {
    const { context, flow, place } = await namedWorktreeFixture(false, name);
    expect(loadNewSessionPreference("ws://gateway.example", "main")?.baseRef).toBeUndefined();
    vi.mocked(context.sessions.createResult).mockResolvedValue({
      key: "agent:main:dashboard:first",
      initialRun: { status: "started", runId: "first-run" },
    });
    await flow.submit(undefined, true);
    expect(place.worktreeName).toBe("");
    expect(loadNewSessionPreference("ws://gateway.example", "main")?.worktreeName).toBeUndefined();
  },
);

it("retires the frozen name after a creating placement is restored into a fresh draft", async () => {
  const first = await namedWorktreeFixture();
  vi.spyOn(first.gateway, "cloudProfiles", "get").mockReturnValue([
    { id: "cloud", providerId: "crabbox", executionModes: ["worker-turn", "remote-exec"] },
  ]);
  vi.spyOn(first.gateway, "cloudProfilesReady", "get").mockReturnValue(true);
  vi.spyOn(first.gateway, "cloudProfilesPending", "get").mockReturnValue(false);
  first.place.selectCloudProfile("cloud");
  vi.mocked(first.context.sessions.createResult).mockResolvedValue(null);
  await first.flow.submit(undefined, true);
  const original = vi.mocked(first.context.sessions.createResult).mock.calls[0]![0];
  expect(first.flow.pendingPlacement.phase).toBe("creating");
  first.gateway.disconnect();
  first.place.browser.disconnect();
  first.flow.disconnect();

  const retry = await namedWorktreeFixture(true, "", true);
  expect(retry.flow.pendingPlacement.sessionKey).toBe(original!.key);
  expect(retry.place.worktreeName).toBe("");
  const start = vi.fn();
  retry.context.placementStartup.start = start;
  vi.mocked(retry.context.sessions.createResult).mockImplementation(async (params) => ({
    key: params!.key!,
    initialRun: { status: "idle" },
  }));
  expect(retry.flow.submitDisabledReason()).toBeUndefined();
  await retry.flow.submit(undefined, true);
  expect(retry.context.sessions.createResult).toHaveBeenCalledExactlyOnceWith(original, {
    reconciliation: "background",
  });
  expect(start).toHaveBeenCalledOnce();
  expect(loadNewSessionPreference("ws://gateway.example", "main")?.worktreeName).toBeUndefined();
});
