import { beforeEach, describe, expect, it, vi } from "vitest";

const loadExactSessionEntryMock = vi.hoisted(() => vi.fn());
const replaceSessionEntryMock = vi.hoisted(() => vi.fn());
const applySessionEntryLifecycleMutationMock = vi.hoisted(() => vi.fn(async () => {}));
const resolveAccessStorePathMock = vi.hoisted(() => vi.fn(() => "/test/store"));

vi.mock("./session-accessor.entry.js", () => ({
  loadExactSessionEntry: loadExactSessionEntryMock,
  replaceSessionEntry: replaceSessionEntryMock,
  resolveAccessStorePath: resolveAccessStorePathMock,
  loadSessionEntry: vi.fn(),
  listSessionEntries: vi.fn(),
  patchSessionEntry: vi.fn(),
}));

vi.mock("./session-accessor.sqlite.js", () => ({
  applySqliteSessionEntryLifecycleMutation: applySessionEntryLifecycleMutationMock,
  applySqliteSessionEntryReplacements: vi.fn(),
  applySqliteSessionStoreProjection: vi.fn(),
  cleanupSqliteSessionLifecycleArtifacts: vi.fn(),
  deleteSqliteSessionEntryLifecycle: vi.fn(),
  purgeSqliteDeletedAgentSessionEntries: vi.fn(),
  resetSqliteSessionEntryLifecycle: vi.fn(),
  rollbackSqliteAgentHarnessSessionEntryLifecycle: vi.fn(),
  rollbackSqlitePluginOwnedSessionEntryLifecycle: vi.fn(),
}));

const { preserveTemporarySessionMapping } = await import("./session-accessor.lifecycle.js");

function makeSpanEntry(overrides?: Record<string, unknown>) {
  return {
    sessionId: "stale-session-id",
    updatedAt: 1700000000000,
    systemSent: false,
    label: "Boot",
    ...overrides,
  };
}

describe("preserveTemporarySessionMapping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forces hadEntry false for legacy boot entries missing lifecycleRevision", async () => {
    // Legacy pre-7.1 boot entries lack lifecycleRevision and carry stale
    // sessionIds that fail admission. They must be deleted during restore.
    loadExactSessionEntryMock.mockReturnValue({
      entry: makeSpanEntry(),
      // No lifecycleRevision → legacy
    });

    const operation = vi.fn(async () => "done");

    const result = await preserveTemporarySessionMapping(
      { sessionKey: "agent:main:boot" },
      operation,
    );

    expect(result.result).toBe("done");
    // hadEntry false → restore deletes instead of replacing
    expect(replaceSessionEntryMock).not.toHaveBeenCalled();
    expect(applySessionEntryLifecycleMutationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        removals: [{ sessionKey: "agent:main:boot" }],
        skipMaintenance: true,
      }),
    );
    // Entry was loaded to inspect lifecycleRevision
    expect(loadExactSessionEntryMock).toHaveBeenCalled();
  });

  it("preserves current boot entries that have lifecycleRevision", async () => {
    // Current boot entries carry lifecycleRevision and must be snapshot
    // and restored normally — not deleted.
    loadExactSessionEntryMock.mockReturnValue({
      entry: makeSpanEntry({ lifecycleRevision: "abc-123" }),
    });
    replaceSessionEntryMock.mockResolvedValue(makeSpanEntry({ lifecycleRevision: "abc-123" }));

    const operation = vi.fn(async () => "done");

    await preserveTemporarySessionMapping({ sessionKey: "agent:main:boot" }, operation);

    // hadEntry true → restore replaces (preserves) the entry
    expect(replaceSessionEntryMock).toHaveBeenCalled();
    expect(applySessionEntryLifecycleMutationMock).not.toHaveBeenCalled();
    expect(loadExactSessionEntryMock).toHaveBeenCalled();
  });

  it("forces hadEntry false for boot keys when no entry exists at all", async () => {
    loadExactSessionEntryMock.mockReturnValue(null);

    const operation = vi.fn(async () => "done");

    await preserveTemporarySessionMapping({ sessionKey: "agent:main:boot" }, operation);

    // No entry → hadEntry false → delete path (no-op since nothing exists)
    expect(replaceSessionEntryMock).not.toHaveBeenCalled();
    expect(applySessionEntryLifecycleMutationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        removals: [{ sessionKey: "agent:main:boot" }],
        skipMaintenance: true,
      }),
    );
    expect(loadExactSessionEntryMock).toHaveBeenCalled();
  });

  it("preserves normal behavior for non-boot session keys with an existing entry", async () => {
    loadExactSessionEntryMock.mockReturnValue({
      entry: makeSpanEntry(),
    });
    replaceSessionEntryMock.mockResolvedValue(makeSpanEntry());

    const operation = vi.fn(async () => "done");

    await preserveTemporarySessionMapping(
      { sessionKey: "agent:main:telegram:direct:42" },
      operation,
    );

    // Non-boot key: entry was loaded and restored
    expect(loadExactSessionEntryMock).toHaveBeenCalled();
    expect(replaceSessionEntryMock).toHaveBeenCalled();
  });

  it("preserves normal behavior for non-boot session keys with no existing entry", async () => {
    loadExactSessionEntryMock.mockReturnValue(null);

    const operation = vi.fn(async () => "done");

    await preserveTemporarySessionMapping(
      { sessionKey: "agent:main:cron:daily-report" },
      operation,
    );

    // Non-boot key: entry was loaded
    expect(loadExactSessionEntryMock).toHaveBeenCalled();
    // hadEntry false → delete, not replace
    expect(replaceSessionEntryMock).not.toHaveBeenCalled();
    expect(applySessionEntryLifecycleMutationMock).toHaveBeenCalled();
  });
});
