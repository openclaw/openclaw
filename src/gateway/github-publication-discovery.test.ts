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

function projectionFixture() {
  let listener: SelectionListener | undefined;
  const row = {
    key: session.sessionKey,
    agentId: session.agentId,
    entry: { sessionId: session.sessionId, updatedAt: 1, repositoryWorkspaceId: "workspace-1" },
  };
  const projection = {
    ensureMaterialized: async () => {},
    selectEntries: () => [row],
    onSelectionChange: (next: SelectionListener) => {
      listener = next;
    },
  };
  return {
    projection,
    rebind: () => {
      row.entry = { ...row.entry, repositoryWorkspaceId: "workspace-2" };
      listener?.({ kind: "row", row });
    },
  };
}

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

  it("serves an unavailable fact immediately while background preparation is pending", async () => {
    expect(readGitHubPublicationFact(session)).toEqual({ available: false });
    const gate = holdPreparation();
    owner = startGitHubPublicationDiscovery({ scheduler });
    expect(readGitHubPublicationFact(session)).toEqual({ available: false });
    const refresh = clock.wake();

    for (let turn = 0; turn < 5; turn++) {
      expect(readGitHubPublicationFact(session)).toEqual({ available: false });
    }
    expect(prepareGitHubPublicationFact).toHaveBeenCalledOnce();

    gate.resolve(published);
    await refresh;
    expect(readGitHubPublicationFact(session)).toEqual(published);
  });

  it.each([
    { change: "identity", invalidate: () => clearNativeGitHubTokenCache() },
    { change: "config", invalidate: () => sessionChanges.emit({ all: true, scope: "config" }) },
  ])(
    "retains visibility but retires credentials while $change changes refresh asynchronously",
    async ({ invalidate }) => {
      owner = startGitHubPublicationDiscovery({ scheduler });
      readGitHubPublicationFact(session);
      await clock.wake();
      expect(readGitHubPublicationFact(session)).toEqual(published);

      const gate = holdPreparation();
      invalidate();
      expect(readGitHubPublicationFact(session)).toEqual({ available: true });
      const refresh = clock.wake();
      expect(readGitHubPublicationFact(session)).toEqual({ available: true });
      gate.resolve(undefined);
      await refresh;
      expect(readGitHubPublicationFact(session)).toEqual({ available: false });
    },
  );

  it("discards a late result after the session workspace binding changes", async () => {
    const { projection, rebind } = projectionFixture();
    const stale = holdPreparation();
    owner = startGitHubPublicationDiscovery({ scheduler, projection });
    await clock.wake();
    const oldRefresh = clock.wake();
    const oldPreparation = vi.mocked(prepareGitHubPublicationFact).mock.calls[0]![0];
    expect(oldPreparation.assertCurrent?.()).toBe(true);

    rebind();
    expect(oldPreparation.assertCurrent?.()).toBe(false);
    const replacement = {
      ...published,
      github: { ...published.github, branch: "openclaw/rebound" },
    };
    vi.mocked(prepareGitHubPublicationFact).mockResolvedValueOnce(replacement);
    await clock.wake();
    stale.resolve(published);
    await oldRefresh;

    expect(readGitHubPublicationFact(session)).toEqual(replacement);
  });

  it("retires published facts and pending refreshes when the owner stops", async () => {
    const gate = holdPreparation();
    owner = startGitHubPublicationDiscovery({ scheduler });
    readGitHubPublicationFact(session);
    const refresh = clock.wake();
    const preparation = vi.mocked(prepareGitHubPublicationFact).mock.calls[0]![0];
    const stopped = owner.stop();
    expect(preparation.assertCurrent?.()).toBe(false);
    expect(readGitHubPublicationFact(session)).toEqual({ available: false });

    clearNativeGitHubTokenCache();
    sessionChanges.emit({ all: true, scope: "config" });
    gate.resolve(published);
    await Promise.all([refresh, stopped]);
    await clock.advanceBy(60_000);
    expect(prepareGitHubPublicationFact).toHaveBeenCalledOnce();
    expect(readGitHubPublicationFact(session)).toEqual({ available: false });
  });
});
