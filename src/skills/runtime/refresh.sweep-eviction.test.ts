import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import { resolveSkillDiscoveryLimits } from "../loading/skill-root-discovery.js";
import type {
  WorkspaceSkillSourceRequest,
  WorkspaceSkillSources,
} from "../loading/workspace-skill-sources.types.js";
import type { SkillsDiscoveryInput } from "./discovery-worker-contract.js";
import { getSkillsSnapshotVersion, registerSkillsChangeListener } from "./refresh-state.js";
import {
  closeSkillsWatchers,
  prepareLocalSkillSources,
  refreshSkillsDiscovery,
} from "./refresh.js";

/** Matches MAX_SOURCES in refresh.ts. A sweep past this cap evicts the overflow. */
const SOURCE_CAP = 128;

type SkillChange = { reason: string; workspaceDir?: string };
type ScanInput = Extract<SkillsDiscoveryInput, { kind: "scan" }>;

const temporary = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeSkillsWatchers(true);
    cleanup();
  }),
);

const emptySources = (): WorkspaceSkillSources => ({
  entries: [],
  executionEntries: [],
  runtime: { platform: "test", bins: [] },
});

function isScanInput(input: unknown): input is ScanInput {
  return (
    typeof input === "object" &&
    input !== null &&
    "kind" in input &&
    input.kind === "scan" &&
    "requests" in input &&
    Array.isArray(input.requests)
  );
}

function scanResult(input: ScanInput) {
  return {
    kind: "scan" as const,
    results: input.requests.map((request) => ({
      key: request.key,
      fingerprint: "fixture",
      watchDirectories: [],
      sources: emptySources(),
    })),
  };
}

function stubDiscoveryScans(
  onScan?: (input: ScanInput, scanNumber: number) => Promise<void> | void,
) {
  let scans = 0;
  vi.spyOn(WorkerTaskPool.prototype, "run").mockImplementation(async (input: unknown) => {
    if (!isScanInput(input)) {
      throw new Error("Unexpected skills discovery task");
    }
    scans += 1;
    await onScan?.(input, scans);
    return scanResult(input);
  });
}

function agentConfig(root: string, count: number): OpenClawConfig {
  const entries: NonNullable<NonNullable<OpenClawConfig["agents"]>["entries"]> = {};
  for (let index = 0; index < count; index++) {
    const id = `agent-${index.toString().padStart(3, "0")}`;
    entries[id] = { workspace: path.join(root, id) };
  }
  return {
    agents: { entries },
    plugins: { enabled: false },
    skills: { load: { watch: false } },
  };
}

function workspaceDir(root: string, index: number): string {
  return path.join(root, `agent-${index.toString().padStart(3, "0")}`);
}

function sourceRequest(dir: string): WorkspaceSkillSourceRequest {
  return {
    sourcePlan: {
      workspaceDir: dir,
      roots: [],
      pluginSkillRoots: [],
      managedSkillsDir: dir,
    },
    limits: resolveSkillDiscoveryLimits(),
    additionalBins: [],
  };
}

async function withSkillChanges<T>(
  run: (events: SkillChange[]) => Promise<T>,
): Promise<{ events: SkillChange[]; result: T }> {
  const events: SkillChange[] = [];
  const unregister = registerSkillsChangeListener((event) => {
    events.push(
      event.workspaceDir
        ? { reason: event.reason, workspaceDir: event.workspaceDir }
        : { reason: event.reason },
    );
  });
  try {
    return { events, result: await run(events) };
  } finally {
    unregister();
  }
}

async function fillSources(root: string, count: number): Promise<void> {
  await Promise.all(
    Array.from({ length: count }, (_, index) =>
      prepareLocalSkillSources(sourceRequest(path.join(root, `filled-${index}`)), {
        watch: false,
      }),
    ),
  );
}

it("publishes one skills change for an all-agent sweep above the source cap", async () => {
  stubDiscoveryScans();
  const root = temporary.make("skills-sweep-eviction-");
  const before = getSkillsSnapshotVersion();
  const { events } = await withSkillChanges(() =>
    refreshSkillsDiscovery({
      config: agentConfig(root, SOURCE_CAP + 2),
      reason: "config-change",
    }),
  );
  expect(events).toEqual([{ reason: "config-change" }]);
  const covered = getSkillsSnapshotVersion();
  expect(covered).toBeGreaterThan(before);
  expect(getSkillsSnapshotVersion(workspaceDir(root, 0))).toBe(covered);
  expect(getSkillsSnapshotVersion(workspaceDir(root, 1))).toBe(covered);
});

it("publishes evicted workspace changes when an all-agent sweep fails", async () => {
  stubDiscoveryScans((_input, scanNumber) => {
    if (scanNumber > 1) {
      throw new Error("skills scan failed");
    }
  });
  const root = temporary.make("skills-sweep-failed-");
  const { events } = await withSkillChanges(async () => {
    await expect(
      refreshSkillsDiscovery({
        config: agentConfig(root, SOURCE_CAP + 2),
        reason: "config-change",
      }),
    ).rejects.toThrow("skills scan failed");
  });
  expect(
    events.filter((event) => event.reason === "watch").map((event) => event.workspaceDir),
  ).toEqual([workspaceDir(root, 0), workspaceDir(root, 1)]);
  expect(
    events
      .filter((event) => event.reason === "watch-unavailable")
      .map((event) => event.workspaceDir),
  ).toEqual([workspaceDir(root, SOURCE_CAP), workspaceDir(root, SOURCE_CAP + 1)]);
  expect(events.some((event) => event.workspaceDir === undefined)).toBe(false);
});

it("publishes an eviction while registering one workspace outside a sweep", async () => {
  stubDiscoveryScans();
  const root = temporary.make("skills-evict-outside-");
  await fillSources(root, SOURCE_CAP);
  const { events } = await withSkillChanges(() =>
    prepareLocalSkillSources(sourceRequest(path.join(root, "filled-extra")), { watch: false }),
  );
  expect(events).toEqual([{ reason: "watch", workspaceDir: path.join(root, "filled-0") }]);
});

it("publishes an eviction from a workspace-scoped refresh that also loads config", async () => {
  stubDiscoveryScans();
  const root = temporary.make("skills-scoped-refresh-");
  await fillSources(root, SOURCE_CAP);
  const scoped = path.join(root, "scoped");
  const { events } = await withSkillChanges(() =>
    refreshSkillsDiscovery({
      workspaceDir: scoped,
      config: {
        agents: { entries: { scoped: { workspace: scoped } } },
        plugins: { enabled: false },
        skills: { load: { watch: false } },
      },
    }),
  );
  expect(events).toEqual([
    { reason: "watch", workspaceDir: path.join(root, "filled-0") },
    { reason: "manual", workspaceDir: scoped },
  ]);
});

it("publishes only the closing change when config refresh stays under the source cap", async () => {
  stubDiscoveryScans();
  const root = temporary.make("skills-config-reset-");
  const config = agentConfig(root, 2);
  const { events } = await withSkillChanges(async () => {
    await refreshSkillsDiscovery({ config, reason: "config-change" });
    await refreshSkillsDiscovery({ config, reason: "config-change" });
  });
  expect(events).toEqual([{ reason: "config-change" }, { reason: "config-change" }]);
});

it("publishes a concurrent registration eviction while an all-agent sweep is in flight", async () => {
  const entered = createDeferred();
  const release = createDeferred();
  stubDiscoveryScans(async (_input, scanNumber) => {
    if (scanNumber === 2) {
      entered.resolve();
      await release.promise;
    }
  });
  const root = temporary.make("skills-sweep-overlap-");
  const sweep = refreshSkillsDiscovery({
    config: agentConfig(root, SOURCE_CAP + 2),
    reason: "config-change",
  });
  await entered.promise;
  const { events } = await withSkillChanges(async (changes) => {
    const read = prepareLocalSkillSources(sourceRequest(path.join(root, "concurrent")), {
      watch: false,
    });
    expect(changes).toEqual([{ reason: "watch", workspaceDir: workspaceDir(root, 2) }]);
    release.resolve();
    await Promise.all([sweep, read]);
  });
  expect(events).toEqual([
    { reason: "watch", workspaceDir: workspaceDir(root, 2) },
    { reason: "config-change" },
  ]);
});

it("publishes recorded evictions when a concurrent refresh retires the sweep", async () => {
  const entered = createDeferred();
  const release = createDeferred();
  stubDiscoveryScans(async (_input, scanNumber) => {
    if (scanNumber === 2) {
      entered.resolve();
      await release.promise;
    }
  });
  const root = temporary.make("skills-sweep-retired-");
  const sweep = refreshSkillsDiscovery({ config: agentConfig(root, SOURCE_CAP + 2) });
  await entered.promise;
  const { events } = await withSkillChanges(async () => {
    const reset = refreshSkillsDiscovery({
      config: agentConfig(root, 1),
      reason: "config-change",
    });
    release.resolve();
    await expect(sweep).rejects.toThrow("Skills discovery was retired before publication");
    await reset;
  });
  expect(
    events.filter((event) => event.reason === "watch").map((event) => event.workspaceDir),
  ).toEqual([workspaceDir(root, 0), workspaceDir(root, 1)]);
  expect(events.filter((event) => event.workspaceDir === undefined)).toEqual([
    { reason: "config-change" },
  ]);
});
