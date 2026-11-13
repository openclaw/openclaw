import fs from "node:fs/promises";
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
  cleanScratch,
  closeScratchCleanupCursor,
  type ScratchCleanupCursor,
} from "../infra/scratch-cleanup.js";
import {
  bindSessionControllerSource,
  reserveSessionControllerSource,
  retireSessionControllerInput,
} from "../sessions/session-controller.mailbox.js";
import { SCRATCH_TTL_MS } from "../shared/scratch-expiry.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { prepareScratchMaintenanceTargets } from "./scratch-maintenance-custody.js";

const fixtures = vi.hoisted(() => ({
  release: vi.fn(),
  read: vi.fn(),
  revisions: new Map<string, number>(),
  projectRoot: "/fixture/project",
  busyRoot: "/fixture/busy",
}));
// mock-isolation: Fixed inventory replaces host database discovery; run custody remains real.
vi.mock("../agents/worktrees/registry-read.js", () => ({
  readWorktreeCleanupState: async () => ({
    records: [
      { id: "idle", path: "/fixture/idle", ownerKind: "session", ownerId: "agent:main:idle" },
      { id: "busy", path: fixtures.busyRoot, ownerKind: "session", ownerId: "agent:main:busy" },
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
  listProjectRegistry: async () => [{ repoRoot: fixtures.projectRoot }],
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
  fixtures.projectRoot = "/fixture/project";
  fixtures.busyRoot = "/fixture/busy";
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

it("drains expired base-clone scratch after work moves to a managed workspace", async () => {
  const tempDirs = createTrackedTempDirs();
  const root = await fs.realpath(await tempDirs.make("scratch-project-custody-"));
  fixtures.projectRoot = path.join(root, "project");
  fixtures.busyRoot = path.join(root, "managed");
  const now = Date.now();
  const files = await Promise.all(
    [fixtures.projectRoot, fixtures.busyRoot].map(async (checkout) => {
      const file = path.join(checkout, ".openclaw/tmp/old/build.txt");
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, "scratch");
      const expired = new Date(now - SCRATCH_TTL_MS - 1_000);
      await fs.utimes(file, expired, expired);
      return file;
    }),
  );
  const unmanaged = await Promise.all(
    [".worktrees", ".openclaw/worktrees"].map(async (directory) => {
      const file = path.join(fixtures.projectRoot, directory, "manual", "source.txt");
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, "unowned work");
      return file;
    }),
  );
  const inputs = [fixtures.projectRoot, fixtures.busyRoot].map((workspaceDir, index) => {
    const key = `agent:main:cleanup-${index}`;
    const input = reserveSessionControllerSource(key, { policy: { mode: "followup" } });
    bindSessionControllerSource(
      input,
      createQueueTestRun(
        { prompt: "synthetic" },
        { agentId: "main", sessionKey: key, workspaceDir, cwd: workspaceDir },
      ),
    );
    return input;
  });
  const prepared = await prepareScratchMaintenanceTargets(config);
  const cursor: ScratchCleanupCursor = {};
  const run = () =>
    cleanScratch({
      targets: prepared.targets.filter((target) =>
        [fixtures.projectRoot, fixtures.busyRoot].includes(target.root),
      ),
      now,
      assertCurrent: () => {},
      pause: async () => {},
      cursor,
    });
  try {
    expect(await run()).toMatchObject({ skippedLive: 2, entriesRemoved: 0 });
    retireSessionControllerInput(inputs[0]!);
    await inputs[0]!.settlement.promise;
    expect(await run()).toMatchObject({ skippedLive: 1, entriesRemoved: 1, bytesRemoved: 7 });
    await expect(fs.stat(files[0]!)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(files[1]!, "utf8")).toBe("scratch");
    for (const file of unmanaged) {
      expect(await fs.readFile(file, "utf8")).toBe("unowned work");
    }
  } finally {
    for (const input of inputs) {
      retireSessionControllerInput(input);
      await input.settlement.promise;
    }
    await closeScratchCleanupCursor(cursor);
    prepared.release();
    await tempDirs.cleanup();
  }
});

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
