import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { DiscoveredPersistenceArtifacts } from "./storage.js";

const loadAuthProfileStoreSnapshotsFromPostgresMock = vi.hoisted(() =>
  vi.fn<() => Promise<Array<{ agentDir: string; store: AuthProfileStore }>>>(async () => []),
);
const loadSubagentRunsFromPostgresMock = vi.hoisted(() =>
  vi.fn<() => Promise<Map<string, unknown>>>(async () => new Map()),
);
const discoverPersistenceArtifactsMock = vi.hoisted(() =>
  vi.fn<() => Promise<DiscoveredPersistenceArtifacts>>(async () => ({
    sessionStores: [],
    transcripts: [],
    authStores: [],
    subagentRegistryPath: undefined,
    memoryDocuments: [],
  })),
);
const replaceRuntimeAuthProfileStoreSnapshotsMock = vi.hoisted(() => vi.fn());
const clearRuntimeAuthProfileStoreSnapshotsMock = vi.hoisted(() => vi.fn());
const replaceRuntimeSubagentRunsSnapshotMock = vi.hoisted(() => vi.fn());
const clearRuntimeSubagentRunsSnapshotMock = vi.hoisted(() => vi.fn());

function createDiscoveredArtifacts(
  overrides?: Partial<DiscoveredPersistenceArtifacts>,
): DiscoveredPersistenceArtifacts {
  return {
    sessionStores: [],
    transcripts: [],
    authStores: [],
    subagentRegistryPath: undefined,
    memoryDocuments: [],
    ...overrides,
  };
}

vi.mock("../agents/auth-profiles.js", () => ({
  replaceRuntimeAuthProfileStoreSnapshots: (
    entries: Array<{ agentDir?: string; store: AuthProfileStore }>,
  ) => replaceRuntimeAuthProfileStoreSnapshotsMock(entries),
  clearRuntimeAuthProfileStoreSnapshots: () => clearRuntimeAuthProfileStoreSnapshotsMock(),
}));

vi.mock("../agents/subagent-registry-state.js", () => ({
  replaceRuntimeSubagentRunsSnapshot: (runs: Map<string, unknown>) =>
    replaceRuntimeSubagentRunsSnapshotMock(runs),
  clearRuntimeSubagentRunsSnapshot: () => clearRuntimeSubagentRunsSnapshotMock(),
}));

vi.mock("./service.js", () => ({
  loadAuthProfileStoreSnapshotsFromPostgres: () => loadAuthProfileStoreSnapshotsFromPostgresMock(),
  loadSubagentRunsFromPostgres: () => loadSubagentRunsFromPostgresMock(),
}));

vi.mock("./storage.js", () => ({
  discoverPersistenceArtifacts: () => discoverPersistenceArtifactsMock(),
}));

const {
  bootstrapPostgresRuntimeState,
  clearPostgresRuntimeState,
  hasBootstrappedPostgresAuthRuntimeState,
} = await import("./runtime.js");

describe("postgres runtime bootstrap", () => {
  const config = {
    persistence: {
      backend: "postgres" as const,
      postgres: {
        url: "postgresql://openclaw:test@localhost/openclaw",
      },
    },
  };

  beforeEach(() => {
    clearPostgresRuntimeState();
    loadAuthProfileStoreSnapshotsFromPostgresMock.mockClear();
    loadAuthProfileStoreSnapshotsFromPostgresMock.mockResolvedValue([]);
    loadSubagentRunsFromPostgresMock.mockClear();
    loadSubagentRunsFromPostgresMock.mockResolvedValue(new Map());
    discoverPersistenceArtifactsMock.mockClear();
    discoverPersistenceArtifactsMock.mockResolvedValue(createDiscoveredArtifacts());
    replaceRuntimeAuthProfileStoreSnapshotsMock.mockClear();
    clearRuntimeAuthProfileStoreSnapshotsMock.mockClear();
    replaceRuntimeSubagentRunsSnapshotMock.mockClear();
    clearRuntimeSubagentRunsSnapshotMock.mockClear();
  });

  it("does not mark auth bootstrap complete before migration validation passes", async () => {
    discoverPersistenceArtifactsMock.mockResolvedValueOnce(
      createDiscoveredArtifacts({
        authStores: ["/tmp/auth-profiles.json"],
      }),
    );

    await expect(
      bootstrapPostgresRuntimeState({
        config,
        auth: true,
        subagents: false,
      }),
    ).rejects.toThrow("Run `openclaw storage migrate --to postgres` before enabling");

    expect(hasBootstrappedPostgresAuthRuntimeState(config)).toBe(false);
    expect(replaceRuntimeAuthProfileStoreSnapshotsMock).not.toHaveBeenCalled();
    expect(clearRuntimeAuthProfileStoreSnapshotsMock).not.toHaveBeenCalled();
  });
});
