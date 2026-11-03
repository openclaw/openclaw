import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { createRepositoryPublicationDiscovery } from "./github-publication-discovery.js";
import { loadGitHubRepositoryRuntimeFixture } from "./github-repository-fixture-api.test-support.js";
import { prepareRepositoryWorkerPublicationFact } from "./worker-environments/worker-github-binding.js";

// Keep workspace qualification outside this demand-cache test; its worker suite exercises real ownership.
vi.mock("./worker-environments/worker-github-binding.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./worker-environments/worker-github-binding.js")>()),
  prepareRepositoryWorkerPublicationFact: vi.fn(),
}));
// The actual vendor issues an opaque identity lease; only credential discovery is synthetic.
vi.mock("../../extensions/github-repositories/tool-identity-api.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  prepareGitHubPublicationIdentity: async () => ({
    source: "system-detected",
    account: { accountId: 42, login: "discovery-bot" },
    env: { GH_TOKEN: "synthetic-discovery-token" },
  }),
  matchesPreparedGitHubPublicationIdentity: () => true,
}));

const { createGitHubPublicationProvider } = await loadGitHubRepositoryRuntimeFixture();

const session = { agentId: "main", sessionKey: "agent:main:discovery", sessionId: "session-1" };
type PreparedFact = Awaited<ReturnType<typeof prepareRepositoryWorkerPublicationFact>>;

type Projection = NonNullable<
  Parameters<typeof createRepositoryPublicationDiscovery>[0]["projection"]
>;
type SelectionListener = Parameters<Projection["onSelectionChange"]>[0];

type WorkspaceBinding = Pick<
  NonNullable<Extract<Parameters<SelectionListener>[0], { kind: "row" }>["row"]>["entry"],
  "repositoryWorkspaceId" | "worktree"
>;

function projectionFixture(binding: WorkspaceBinding = { repositoryWorkspaceId: "workspace-1" }) {
  let listener: SelectionListener | undefined;
  const row = {
    key: session.sessionKey,
    agentId: session.agentId,
    entry: { sessionId: session.sessionId, updatedAt: 1, ...binding },
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
    observe: (observed: typeof row) => listener?.({ kind: "row", row: observed }),
    rebind: (next: WorkspaceBinding = { repositoryWorkspaceId: "workspace-2" }) => {
      row.entry = { sessionId: session.sessionId, updatedAt: 1, ...next };
      listener?.({ kind: "row", row });
    },
  };
}

// Stored-row publications replace the retired projection listener: qualification stays with the worker owner.
function workspaceChanged() {
  sessionChanges.emit({
    sessionKey: session.sessionKey,
    agentId: session.agentId,
    scope: "session-entry",
  });
}

describe("Gateway-owned publication discovery", () => {
  let clock: ReturnType<typeof createGatewaySchedulerClock>;
  let scheduler: ReturnType<typeof createTestGatewayScheduler>;
  let service: AbortController;
  let provider: ReturnType<typeof createGitHubPublicationProvider>;
  let owner: ReturnType<typeof createRepositoryPublicationDiscovery>;
  let published: NonNullable<PreparedFact>;
  let pending: Array<ReturnType<typeof createDeferred<PreparedFact>>>;

  const holdPreparation = () => {
    const gate = createDeferred<PreparedFact>();
    const entered = createDeferred();
    pending.push(gate);
    vi.mocked(prepareRepositoryWorkerPublicationFact).mockImplementationOnce(() => {
      entered.resolve();
      return gate.promise;
    });
    return { ...gate, entered: entered.promise };
  };

  beforeEach(async () => {
    clock = createGatewaySchedulerClock(1_000);
    scheduler = createTestGatewayScheduler(clock.clock);
    service = new AbortController();
    provider = createGitHubPublicationProvider({
      getConfig: () => ({}),
      refreshIdentity: async () => {},
      refreshPersonal: async () => {},
      assertCurrent: () => service.signal.throwIfAborted(),
      signal: service.signal,
    });
    const identity = await provider.prepareWorkerIdentity!({
      agentId: session.agentId,
      originUrl: "https://github.com/openclaw/openclaw.git",
      assertCurrent: () => service.signal.throwIfAborted(),
    });
    if (!identity) {
      throw new Error("Missing provider-issued fixture identity");
    }
    published = {
      available: true,
      identity,
      workspaceKey: "workspace-1",
      branch: "openclaw/session-1",
    };
    pending = [];
    vi.mocked(prepareRepositoryWorkerPublicationFact).mockReset().mockResolvedValue(published);
    owner = createRepositoryPublicationDiscovery({ scheduler, getProvider: () => provider });
  });

  afterEach(async () => {
    for (const gate of pending) {
      gate.resolve(undefined);
    }
    service.abort();
    await scheduler.stop();
  });

  it("does no discovery for a hydrated corpus until a session requests its publication hint", async () => {
    for (let index = 0; index < 300; index++) {
      sessionChanges.emit({
        sessionKey: `agent:main:idle-${index}`,
        agentId: "main",
        scope: "session-entry",
      });
      await clock.wake();
    }
    expect(prepareRepositoryWorkerPublicationFact).not.toHaveBeenCalled();
    expect(clock.armedAtMs).toBeNull();
    owner.invalidate();
    sessionChanges.emit({ all: true, scope: "config" });
    await clock.wake();
    expect(prepareRepositoryWorkerPublicationFact).not.toHaveBeenCalled();
    expect(clock.armedAtMs).toBeNull();
    expect(owner.read(session)).toEqual({ available: false });
    await clock.wake();
    expect(prepareRepositoryWorkerPublicationFact).toHaveBeenCalledOnce();
    expect(owner.read(session)).toEqual(published);
  });

  it("replaces queued work when the requested session binding changes before preparation", async () => {
    owner.read(session);
    workspaceChanged();
    const replacement = { ...published, workspaceKey: "workspace-2", branch: "openclaw/rebound" };
    vi.mocked(prepareRepositoryWorkerPublicationFact).mockResolvedValueOnce(replacement);
    expect(prepareRepositoryWorkerPublicationFact).not.toHaveBeenCalled();
    await clock.wake();
    expect(prepareRepositoryWorkerPublicationFact).toHaveBeenCalledOnce();
    expect(owner.read(session)).toEqual(replacement);
  });

  it("revokes a removed binding before its queued preparation starts", async () => {
    const { projection, rebind } = projectionFixture();
    owner = createRepositoryPublicationDiscovery({
      scheduler,
      projection,
      getProvider: () => provider,
    });
    owner.read(session);

    rebind({});
    owner.invalidate();
    sessionChanges.emit({ all: true, scope: "config" });
    vi.mocked(prepareRepositoryWorkerPublicationFact).mockImplementationOnce(async (params) => {
      // The preparation owner checks this live guard before performing I/O.
      expect(() => params.assertCurrent?.()).toThrow();
      return published;
    });
    await clock.wake();
    expect(vi.mocked(prepareRepositoryWorkerPublicationFact).mock.calls.length).toBeLessThanOrEqual(
      1,
    );
    expect(clock.armedAtMs).toBeNull();
    expect(owner.read(session)).toEqual({ available: false });
  });

  it("retires removed bindings without reviving them on identity or config changes", async () => {
    const { projection, rebind } = projectionFixture();
    owner = createRepositoryPublicationDiscovery({
      scheduler,
      projection,
      getProvider: () => provider,
    });
    owner.read(session);
    await clock.wake();
    expect(owner.read(session)).toEqual(published);

    const stale = holdPreparation();
    owner.invalidate();
    const oldRefresh = clock.wake();
    await stale.entered;
    const oldPreparation = vi.mocked(prepareRepositoryWorkerPublicationFact).mock.calls[1]![0];
    expect(() => oldPreparation.assertCurrent?.()).not.toThrow();
    rebind({});
    expect(() => oldPreparation.assertCurrent?.()).toThrow();
    owner.invalidate();
    sessionChanges.emit({ all: true, scope: "config" });
    await clock.wake();
    expect(prepareRepositoryWorkerPublicationFact).toHaveBeenCalledTimes(2);

    stale.resolve(published);
    await oldRefresh;
    expect(clock.armedAtMs).toBeNull();
    // Explicit demand still returns immediately and can prepare a previously unknown target.
    expect(owner.read(session)).toEqual({ available: false });
    rebind();
    const replacement = {
      ...published,
      branch: "openclaw/rebound",
    };
    vi.mocked(prepareRepositoryWorkerPublicationFact).mockResolvedValueOnce(replacement);
    await clock.wake();
    expect(prepareRepositoryWorkerPublicationFact).toHaveBeenCalledTimes(3);
    expect(owner.read(session)).toEqual(replacement);
  });

  it("serves an unavailable fact immediately while one background preparation is pending", async () => {
    const gate = holdPreparation();
    expect(owner.read(session)).toEqual({ available: false });
    const refresh = clock.wake();
    await gate.entered;
    for (let turn = 0; turn < 5; turn++) {
      expect(owner.read(session)).toEqual({ available: false });
    }
    expect(prepareRepositoryWorkerPublicationFact).toHaveBeenCalledOnce();
    gate.resolve(published);
    await refresh;
    expect(owner.read(session)).toEqual(published);
  });

  it.each(["identity", "config"] as const)(
    "retains visibility but retires the opaque identity while %s changes refresh asynchronously",
    async (change) => {
      owner.read(session);
      await clock.wake();
      expect(owner.read(session)).toEqual(published);
      const gate = holdPreparation();
      if (change === "identity") {
        owner.invalidate();
      } else {
        sessionChanges.emit({ all: true, scope: "config" });
      }
      expect(owner.read(session)).toEqual({ available: true });
      expect(owner.read(session)).not.toHaveProperty("identity");
      const refresh = clock.wake();
      await gate.entered;
      expect(owner.read(session)).toEqual({ available: true });
      gate.resolve(undefined);
      await refresh;
      expect(owner.read(session)).toEqual({ available: false });
    },
  );

  it("sleeps while idle and retires expired identity authority on the next read", async () => {
    owner.read(session);
    await clock.wake();
    expect(owner.read(session)).toEqual(published);
    expect(clock.armedAtMs).toBeNull();
    await clock.advanceBy(5 * 60_000);
    expect(prepareRepositoryWorkerPublicationFact).toHaveBeenCalledOnce();
    expect(clock.armedAtMs).toBeNull();
    const gate = holdPreparation();
    expect(owner.read(session)).toEqual({ available: true });
    expect(owner.read(session)).not.toHaveProperty("identity");
    const refresh = clock.wake();
    await gate.entered;
    expect(prepareRepositoryWorkerPublicationFact).toHaveBeenCalledTimes(2);
    gate.resolve(published);
    await refresh;
    expect(owner.read(session)).toEqual(published);
    expect(clock.armedAtMs).toBeNull();
  });

  it("discards a late result and fences its prepared guard after the session workspace binding changes", async () => {
    const stale = holdPreparation();
    owner.read(session);
    const oldRefresh = clock.wake();
    await stale.entered;
    const oldPreparation = vi.mocked(prepareRepositoryWorkerPublicationFact).mock.calls[0]![0];
    expect(oldPreparation.assertCurrent).not.toThrow();
    workspaceChanged();
    expect(oldPreparation.assertCurrent).toThrow("Repository discovery owner changed");
    const replacement = { ...published, workspaceKey: "workspace-2", branch: "openclaw/rebound" };
    vi.mocked(prepareRepositoryWorkerPublicationFact).mockResolvedValueOnce(replacement);
    await clock.wake();
    stale.resolve(published);
    await oldRefresh;
    expect(owner.read(session)).toEqual(replacement);
  });

  it("retires published facts and pending refreshes when the Gateway owner stops", async () => {
    const gate = holdPreparation();
    owner.read(session);
    const refresh = clock.wake();
    await gate.entered;
    const preparation = vi.mocked(prepareRepositoryWorkerPublicationFact).mock.calls[0]![0];
    scheduler.beginClose();
    expect(preparation.assertCurrent).toThrow();
    expect(owner.read(session)).toEqual({ available: false });
    owner.invalidate();
    sessionChanges.emit({ all: true, scope: "config" });
    gate.resolve(published);
    await Promise.all([refresh, scheduler.stop()]);
    await clock.advanceBy(60_000);
    expect(prepareRepositoryWorkerPublicationFact).toHaveBeenCalledOnce();
    expect(owner.read(session)).toEqual({ available: false });
  });

  it("withdraws a removed source's cached identity before its replacement read settles", async () => {
    owner.read(session);
    await clock.wake();
    expect(owner.read(session)).toEqual(published);
    const missing = holdPreparation();
    workspaceChanged();
    expect(owner.read(session)).toEqual({ available: true });
    const preparing = clock.wake();
    await missing.entered;
    const stale = vi.mocked(prepareRepositoryWorkerPublicationFact).mock.calls.at(-1)![0];
    owner.invalidate();
    expect(() => stale.assertCurrent?.()).toThrow();
    missing.resolve(undefined);
    await preparing;
    vi.mocked(prepareRepositoryWorkerPublicationFact).mockResolvedValue(undefined);
    await clock.wake();
    expect(owner.read(session)).toEqual({ available: false });
    owner.invalidate();
    sessionChanges.emit({ all: true, scope: "config" });
    await clock.wake();
    expect(owner.read(session)).toEqual({ available: false });
  });

  it("withholds cached authority after its vendor service is disabled", async () => {
    owner.read(session);
    await clock.wake();
    expect(owner.read(session)).toEqual(published);
    service.abort();
    expect(owner.read(session)).toEqual({ available: false });
    await clock.wake();
    expect(prepareRepositoryWorkerPublicationFact).toHaveBeenCalledOnce();
  });
});
