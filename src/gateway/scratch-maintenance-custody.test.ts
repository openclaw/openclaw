import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createQueueTestRun } from "../auto-reply/reply/queue.test-helpers.js";
import {
  claimAgentRunContext,
  getAgentRunLifecycleGeneration,
  registerAgentRunContext,
  releaseAgentRunContext,
  resetAgentRunRegistryForTest,
  retainQueuedAgentRunContext,
} from "../infra/agent-run-registry.js";
import {
  bindSessionControllerSource,
  reserveSessionControllerSource,
  retireSessionControllerInput,
} from "../sessions/session-controller.mailbox.js";
import { prepareScratchMaintenanceTargets } from "./scratch-maintenance-custody.js";

const fixtures = vi.hoisted(() => ({
  release: vi.fn(),
  read: vi.fn(),
  revisions: new Map<string, number>(),
}));
// mock-isolation: Fixed inventory replaces host database discovery; run custody remains real.
vi.mock("../agents/worktrees/registry-read.js", () => ({
  readWorktreeCleanupState: async () => ({
    records: [
      { id: "idle", path: "/fixture/idle", ownerKind: "session", ownerId: "agent:main:idle" },
      { id: "busy", path: "/fixture/busy", ownerKind: "session", ownerId: "agent:main:busy" },
    ],
    leases: { liveScopes: [], staleScopes: [] },
  }),
}));
// mock-isolation: The fixed inventory has no database publication lifecycle.
vi.mock("../agents/worktrees/run-end-lifecycle.js", () => ({
  captureWorktreeRunEndContext: () => ({}),
  captureWorktreeRegistryAuthority: (_context: unknown, changes: { id: string }[]) => {
    const captured = changes.map(({ id }) => [id, fixtures.revisions.get(id) ?? 0] as const);
    return () => {
      if (captured.some(([id, revision]) => (fixtures.revisions.get(id) ?? 0) !== revision)) {
        throw new Error("registry authority changed");
      }
    };
  },
}));
// mock-isolation: Selected session metadata is fixture data, never a host database read.
vi.mock("../config/sessions/session-accessor.entry-read-runtime.js", () => ({
  readResolvedSessionStoreTargetsInWorker: fixtures.read,
}));
// mock-isolation: No real host project registry is used by this custody integration.
vi.mock("../projects/project-registry.js", () => ({
  listProjectRegistry: async () => [{ repoRoot: "/fixture/project" }],
}));
// mock-isolation: The fixture has no remote workers; real local run ownership drives protection.
vi.mock("./session-worker-placement-context.js", () => ({
  resolveSessionWorkerPlacementContext: () => ({
    workerSessionPlacementService: {
      prepareMaintenancePlacements: async () => ({
        placements: [],
        assertCurrent: () => {},
        release: fixtures.release,
      }),
    },
  }),
}));

beforeEach(() => {
  fixtures.release.mockClear();
  fixtures.read.mockClear();
  fixtures.revisions.clear();
  fixtures.read.mockImplementation(
    async ({ sessionKeys }: { sessionKeys: string[] }) =>
      new Map(
        sessionKeys.map((key) => [
          key,
          {
            canonicalKey: key,
            agentId: "main",
            entry: {
              sessionId: key,
              updatedAt: Date.now(),
              spawnedCwd: key === "agent:main:busy" ? "/fixture/busy/nested" : "/fixture/idle",
            },
          },
        ]),
      ),
  );
});
afterEach(() => resetAgentRunRegistryForTest());
const config = { agents: { entries: { main: { workspace: "/fixture/project" } } } };

it.each(["running", "queued", "mailbox"] as const)(
  "protects only checkouts owned by %s work and releases protection",
  async (state) => {
    const runId = "scratch-run";
    const context = { sessionKey: "agent:main:busy", agentId: "main", sessionId: "busy-session" };
    let release: () => void | Promise<void>;
    if (state === "running") {
      const claim = claimAgentRunContext(runId, context, { trackOwner: true });
      release = () => releaseAgentRunContext(runId, claim);
    } else if (state === "queued") {
      registerAgentRunContext(runId, context);
      const queued = retainQueuedAgentRunContext(runId, getAgentRunLifecycleGeneration());
      release = () => queued?.("abandoned");
    } else {
      const input = reserveSessionControllerSource(context.sessionKey, {
        policy: { mode: "followup" },
      });
      release = async () => {
        retireSessionControllerInput(input);
        await input.settlement.promise;
      };
    }
    const prepared = await prepareScratchMaintenanceTargets(config);
    try {
      const live = () =>
        prepared.targets.filter((target) => target.isLive()).map((target) => target.root);
      expect(live()).toEqual([path.resolve("/fixture/busy")]);
      await release();
      expect(live()).toEqual([]);
      // Recent, unarchived sessions alone do not retain scratch.
      expect(
        prepared.targets.find((target) => target.root === path.resolve("/fixture/idle"))?.isLive(),
      ).toBe(false);
    } finally {
      await release();
      prepared.release();
    }
    expect(fixtures.release).toHaveBeenCalledOnce();
  },
);

it("defers an unmapped newly admitted run instead of deleting from an unknown checkout", async () => {
  const prepared = await prepareScratchMaintenanceTargets(config);
  const claim = claimAgentRunContext(
    "new-run",
    { sessionKey: "agent:main:new" },
    { trackOwner: true },
  );
  try {
    const idle = prepared.targets[0]!;
    expect(() => idle.isLive()).toThrow("fresh checkout binding");
    await idle.prepare?.();
    expect(idle.isLive()).toBe(true);
    expect(prepared.targets[1]!.isLive()).toBe(false);
  } finally {
    releaseAgentRunContext("new-run", claim);
    prepared.release();
  }
});

it("keeps unrelated checkouts eligible when another worktree acquires a lease", async () => {
  const prepared = await prepareScratchMaintenanceTargets(config);
  try {
    fixtures.revisions.set("busy", 1);
    fixtures.revisions.set("*", 1);
    expect(prepared.targets[0]!.isLive()).toBe(false);
    expect(() => prepared.targets[1]!.isLive()).toThrow("registry authority changed");
  } finally {
    prepared.release();
  }
});

it("publishes a late-bound queue workspace without rereading session metadata", async () => {
  const prepared = await prepareScratchMaintenanceTargets(config);
  // First check consumes the prepared facts before a new source arrives.
  expect(prepared.targets[0]!.isLive()).toBe(false);
  const input = reserveSessionControllerSource("agent:main:new", { policy: { mode: "followup" } });
  await prepared.targets[0]!.prepare?.();
  expect(prepared.targets[0]!.isLive()).toBe(true);
  bindSessionControllerSource(
    input,
    createQueueTestRun(
      { prompt: "synthetic" },
      {
        agentId: "main",
        sessionKey: "agent:main:new",
        workspaceDir: "/fixture/project",
        cwd: "/fixture/project/subdir",
      },
    ),
  );
  try {
    await prepared.targets[0]!.prepare?.();
    expect(prepared.targets[0]!.isLive()).toBe(false);
    expect(prepared.targets[2]!.isLive()).toBe(true);
    expect(fixtures.read).toHaveBeenCalledOnce();
  } finally {
    retireSessionControllerInput(input);
    await input.settlement.promise;
    prepared.release();
  }
});

it.each(["unbound", "running"] as const)(
  "retains both queued paths and %s session custody",
  async (state) => {
    const key = "agent:main:mixed";
    const bound = reserveSessionControllerSource(key, { policy: { mode: "followup" } });
    bindSessionControllerSource(
      bound,
      createQueueTestRun(
        { prompt: "synthetic" },
        {
          agentId: "main",
          sessionKey: key,
          workspaceDir: "/fixture/project",
          cwd: "/fixture/project/subdir",
        },
      ),
    );
    const unbound =
      state === "unbound"
        ? reserveSessionControllerSource(key, { policy: { mode: "followup" } })
        : undefined;
    const claim =
      state === "running"
        ? claimAgentRunContext("mixed-run", { sessionKey: key }, { trackOwner: true })
        : undefined;
    const prepared = await prepareScratchMaintenanceTargets(config);
    try {
      expect(prepared.targets[0]!.isLive()).toBe(true);
      expect(prepared.targets[1]!.isLive()).toBe(false);
      expect(prepared.targets[2]!.isLive()).toBe(true);
    } finally {
      releaseAgentRunContext("mixed-run", claim);
      for (const input of [bound, ...(unbound ? [unbound] : [])]) {
        retireSessionControllerInput(input);
        await input.settlement.promise;
      }
      prepared.release();
    }
  },
);
