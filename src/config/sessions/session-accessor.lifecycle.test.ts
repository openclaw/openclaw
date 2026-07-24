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

function makeSpanEntry() {
  return {
    sessionId: "stale-session-id",
    updatedAt: 1700000000000,
    systemSent: false,
    label: "Boot",
  };
}

describe("preserveTemporarySessionMapping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forces hadEntry false for boot session keys even when an entry exists", async () => {
    loadExactSessionEntryMock.mockReturnValue({
      entry: makeSpanEntry(),
    });

    const operation = vi.fn(async () => "done");

    const result = await preserveTemporarySessionMapping(
      { sessionKey: "agent:main:boot" },
      operation,
    );

    expect(result.result).toBe("done");
    // When hadEntry is false, restore deletes the entry instead of restoring it
    expect(replaceSessionEntryMock).not.toHaveBeenCalled();
    expect(applySessionEntryLifecycleMutationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        removals: [{ sessionKey: "agent:main:boot" }],
        skipMaintenance: true,
      }),
    );
    // The entry was NOT loaded (skipped for boot keys)
    expect(loadExactSessionEntryMock).not.toHaveBeenCalled();
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
