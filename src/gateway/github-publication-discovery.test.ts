import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { clearNativeGitHubTokenCache } from "../agents/github-read-identity.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import {
  readGitHubPublicationFact,
  startGitHubPublicationDiscovery,
} from "./github-publication-discovery.js";
import { prepareGitHubPublicationFact } from "./worker-environments/worker-github-binding.js";

// mock-isolation: Exercise discovery ownership without GitHub, Git, or credential I/O.
vi.mock("./worker-environments/worker-github-binding.js", () => ({
  prepareGitHubPublicationFact: vi.fn(),
}));

const session = { agentId: "main", sessionKey: "agent:main:discovery", sessionId: "session-1" };
const published = {
  available: true as const,
  github: {
    token: "synthetic-discovery-token",
    login: "discovery-bot",
    branch: "openclaw/session-1",
  },
};
type PreparedFact = Awaited<ReturnType<typeof prepareGitHubPublicationFact>>;
type Projection = NonNullable<Parameters<typeof startGitHubPublicationDiscovery>[0]["projection"]>;
type SelectionListener = Parameters<Projection["onSelectionChange"]>[0];

type WorkspaceBinding = Pick<
  NonNullable<Extract<Parameters<SelectionListener>[0], { kind: "row" }>["row"]>["entry"],
  "repositoryWorkspaceId" | "worktree"
>;

describe("GitHub publication discovery", () => {
  let clock: ReturnType<typeof createGatewaySchedulerClock>;
  let scheduler: ReturnType<typeof createTestGatewayScheduler>;
  let owner: ReturnType<typeof startGitHubPublicationDiscovery> | undefined;
  let pending: Array<ReturnType<typeof createDeferred<PreparedFact>>>;

  const holdPreparation = () => {
    const gate = createDeferred<PreparedFact>();
    pending.push(gate);
    vi.mocked(prepareGitHubPublicationFact).mockReturnValueOnce(gate.promise);
    return gate;
  };
  const fact = (expected: PreparedFact = published) =>
    expect(readGitHubPublicationFact(session)).toEqual(expected);
  const start = () => {
    let listener: SelectionListener | undefined;
    owner = startGitHubPublicationDiscovery({
      scheduler,
      projection: {
        onSelectionChange: (next) => {
          listener = next;
        },
      },
    });
    return (
      binding: WorkspaceBinding = { repositoryWorkspaceId: "workspace-2" },
      key = session.sessionKey,
      sessionId = session.sessionId,
    ) =>
      listener?.({
        kind: "row",
        row: { key, agentId: session.agentId, entry: { sessionId, updatedAt: 1, ...binding } },
      });
  };
  const discover = async () => {
    readGitHubPublicationFact(session);
    await clock.wake();
    fact();
  };
  const invalidateAll = () => {
    clearNativeGitHubTokenCache();
    sessionChanges.emit({ all: true, scope: "config" });
  };

  beforeEach(() => {
    clock = createGatewaySchedulerClock(1_000);
    scheduler = createTestGatewayScheduler(clock.clock);
    pending = [];
    vi.mocked(prepareGitHubPublicationFact).mockReset().mockResolvedValue(published);
  });

  afterEach(async () => {
    for (const gate of pending) {
      gate.resolve(undefined);
    }
    await owner?.stop();
    owner = undefined;
    await scheduler.stop();
  });

  it("does no discovery for a hydrated corpus until a session requests its publication hint", async () => {
    const rebind = start();
    for (let index = 0; index < 300; index++) {
      rebind({ repositoryWorkspaceId: "workspace-1" }, `agent:main:idle-${index}`, `idle-${index}`);
      await clock.wake();
    }
    expect(vi.mocked(prepareGitHubPublicationFact).mock.calls.length).toBe(0);
    expect(clock.armedAtMs).toBeNull();

    expect(readGitHubPublicationFact(session)).toEqual({ available: false });
    await clock.wake();
    expect(prepareGitHubPublicationFact).toHaveBeenCalledOnce();
    expect(readGitHubPublicationFact(session)).toEqual(published);
  });

  it.each([
    { kind: "repository", binding: { repositoryWorkspaceId: "workspace-1" } },
    {
      kind: "worktree",
      binding: { worktree: { id: "worktree-1", repoRoot: "/synthetic/repo", branch: "session-1" } },
    },
  ])("waits for demand after an unobserved row acquires a $kind binding", async ({ binding }) => {
    fact({ available: false });
    const rebind = start();

    rebind({});
    invalidateAll();
    await clock.wake();
    expect(prepareGitHubPublicationFact).not.toHaveBeenCalled();
    expect(clock.armedAtMs).toBeNull();

    rebind(binding);
    await clock.wake();
    expect(prepareGitHubPublicationFact).not.toHaveBeenCalled();

    const gate = holdPreparation();
    fact({ available: false });
    const preparing = clock.wake();
    expect(prepareGitHubPublicationFact).toHaveBeenCalledOnce();
    for (let turn = 0; turn < 5; turn++) {
      fact({ available: false });
    }
    gate.resolve(published);
    await preparing;
    expect(readGitHubPublicationFact(session)).toEqual(published);
  });

  it("revokes a removed binding before its queued preparation starts", async () => {
    const rebind = start();
    readGitHubPublicationFact(session);
    expect(prepareGitHubPublicationFact).not.toHaveBeenCalled();

    rebind({});
    invalidateAll();
    vi.mocked(prepareGitHubPublicationFact).mockImplementationOnce(async (params) => {
      // The preparation owner checks this live guard before performing I/O.
      expect(params.assertCurrent?.()).toBe(false);
      return published;
    });
    await clock.wake();
    expect(prepareGitHubPublicationFact).toHaveBeenCalledOnce();
    expect(clock.armedAtMs).toBeNull();
    expect(readGitHubPublicationFact(session)).toEqual({ available: false });
  });

  it.each(["removed", "rebound"])("discards in-flight results for %s bindings", async (binding) => {
    const rebind = start();
    if (binding === "removed") {
      await discover();
      clearNativeGitHubTokenCache();
    } else {
      readGitHubPublicationFact(session);
    }
    const stale = holdPreparation();
    const oldRefresh = clock.wake();
    const oldPreparation = vi.mocked(prepareGitHubPublicationFact).mock.calls.at(-1)![0];
    expect(oldPreparation.assertCurrent?.()).toBe(true);
    rebind(binding === "removed" ? {} : undefined);
    expect(oldPreparation.assertCurrent?.()).toBe(false);
    if (binding === "removed") {
      invalidateAll();
      await clock.wake();
      expect(prepareGitHubPublicationFact).toHaveBeenCalledTimes(2);
      stale.resolve(published);
      await oldRefresh;
      expect(clock.armedAtMs).toBeNull();
      fact({ available: false });
      rebind();
    }
    const replacement = {
      ...published,
      github: { ...published.github, branch: "openclaw/rebound" },
    };
    vi.mocked(prepareGitHubPublicationFact).mockResolvedValueOnce(replacement);
    await clock.wake();
    stale.resolve(published);
    await oldRefresh;
    expect(prepareGitHubPublicationFact).toHaveBeenCalledTimes(binding === "removed" ? 3 : 2);
    fact(replacement);
  });

  it.each([
    { change: "identity", invalidate: () => clearNativeGitHubTokenCache() },
    { change: "config", invalidate: () => sessionChanges.emit({ all: true, scope: "config" }) },
    { change: "expiry", invalidate: () => clock.advanceBy(5 * 60_000) },
  ])(
    "retains visibility but retires credentials while $change changes refresh asynchronously",
    async ({ change, invalidate }) => {
      owner = startGitHubPublicationDiscovery({ scheduler });
      await discover();
      expect(clock.armedAtMs).toBeNull();

      const gate = holdPreparation();
      await invalidate();
      expect(prepareGitHubPublicationFact).toHaveBeenCalledOnce();
      if (change === "expiry") {
        expect(clock.armedAtMs).toBeNull();
      }
      fact({ available: true });
      const refresh = clock.wake();
      fact({ available: true });
      expect(prepareGitHubPublicationFact).toHaveBeenCalledTimes(2);
      const replacement = {
        ...published,
        github: { ...published.github, token: "synthetic-refreshed-token" },
      };
      gate.resolve(change === "expiry" ? replacement : undefined);
      await refresh;
      fact(change === "expiry" ? replacement : { available: false });
      expect(clock.armedAtMs).toBeNull();
    },
  );

  it("retires published facts and pending refreshes when the owner stops", async () => {
    const gate = holdPreparation();
    owner = startGitHubPublicationDiscovery({ scheduler });
    readGitHubPublicationFact(session);
    const refresh = clock.wake();
    const preparation = vi.mocked(prepareGitHubPublicationFact).mock.calls[0]![0];
    const stopped = owner.stop();
    expect(preparation.assertCurrent?.()).toBe(false);
    expect(readGitHubPublicationFact(session)).toEqual({ available: false });

    invalidateAll();
    gate.resolve(published);
    await Promise.all([refresh, stopped]);
    await clock.advanceBy(60_000);
    expect(prepareGitHubPublicationFact).toHaveBeenCalledOnce();
    expect(readGitHubPublicationFact(session)).toEqual({ available: false });
  });
});
