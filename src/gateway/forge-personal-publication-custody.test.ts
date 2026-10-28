import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  events: [] as string[],
  readOwner: vi.fn(),
  lease: vi.fn(),
  bindLifetime: vi.fn(),
}));
vi.mock("./github-publication-availability.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./github-publication-availability.js")>()),
  readGitHubPublicationWorktreeOwner: mocks.readOwner,
}));
vi.mock("../agents/worktrees/run-lease.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/worktrees/run-lease.js")>()),
  acquireWorktreeRunLease: mocks.lease,
}));
vi.mock("../config/sessions/lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/sessions/lifecycle.js")>()),
  resolveSessionWorkStartError: () => null,
}));
vi.mock("./github-publication-source.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./github-publication-source.js")>()),
  bindGitHubPublicationSourceLifetime: mocks.bindLifetime,
}));

import {
  preparePersonalForgePublicationSource,
  withPersonalForgePublicationWorkspace,
} from "./forge-personal-publication-custody.js";

it("keeps reservation, native owner, and exclusive lease until a provider operation settles", async () => {
  mocks.events.length = 0;
  const worktree = { id: "managed-id", path: "/managed/topic", branch: "topic" };
  mocks.readOwner.mockResolvedValue({
    worktree,
    assertCurrent: () => {
      mocks.events.push("owner-current");
      return { loaded: { entry: { sessionId: "session" } } };
    },
    release: () => mocks.events.push("owner-release"),
  });
  mocks.lease.mockImplementation(async (_id: string, options: { exclusive: boolean }) => {
    expect(options.exclusive).toBe(true);
    mocks.events.push("lease-acquire");
    return { release: async () => mocks.events.push("lease-release") };
  });
  const action = {
    owner: "person",
    sessionId: "session",
    sessionKey: "agent:main:session",
    agentId: "main",
    lifecycleRevision: null,
    assertCurrent: () => mocks.events.push("action-current"),
  };
  const placements = {
    withLocalWorkspaceReservation: async (
      _action: unknown,
      run: (assert: () => void) => Promise<unknown>,
    ) => {
      mocks.events.push("reserve");
      return run(() => mocks.events.push("reservation-current"));
    },
  };
  const result = await withPersonalForgePublicationWorkspace(
    placements as never,
    action,
    async (workspace) => {
      expect(workspace.worktree).toBe(worktree);
      workspace.assertCurrent();
      mocks.events.push("provider-effect");
      return "done";
    },
  );
  expect(result).toBe("done");
  expect(mocks.events).toContain("provider-effect");
  expect(mocks.events.slice(-2)).toEqual(["lease-release", "owner-release"]);
});

it("releases a prepared source when runtime authority expires before admission", async () => {
  const release = vi.fn(async () => {});
  const action = {
    owner: "person",
    sessionId: "session",
    sessionKey: "agent:main:session",
    agentId: "main",
    lifecycleRevision: null,
    version: 2 as const,
    signal: new AbortController().signal,
    assertCurrent() {},
    prepareSource: vi.fn(async () => ({ version: 1 as const, release })),
  };
  const selector = {
    agentId: "main",
    sessionKey: action.sessionKey,
    sessionId: action.sessionId,
    lifecycleRevision: null,
    personalOwnerProfileId: action.owner,
    worktreeId: "managed-id",
  };
  await expect(
    preparePersonalForgePublicationSource(action, selector, () => {
      throw new Error("runtime stopped");
    }),
  ).rejects.toThrow("runtime stopped");
  expect(action.prepareSource).toHaveBeenCalledWith(selector);
  expect(release).toHaveBeenCalledOnce();
});
