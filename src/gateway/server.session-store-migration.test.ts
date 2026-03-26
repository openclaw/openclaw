import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listAgentSessionDirsMock: vi
    .fn()
    .mockResolvedValue([
      "/tmp/openclaw/agents/main/sessions",
      "/tmp/openclaw/agents/worker/sessions",
    ]),
  migrateSessionStoreToDirectoryMock: vi.fn().mockResolvedValue({
    outcome: "missing",
    legacyEntries: 0,
    migratedEntries: 0,
    warnings: [],
  }),
}));

vi.mock("../commands/cleanup-utils.js", () => ({
  listAgentSessionDirs: mocks.listAgentSessionDirsMock,
}));

vi.mock("../config/sessions/store.js", async () => {
  const actual = await vi.importActual<typeof import("../config/sessions/store.js")>(
    "../config/sessions/store.js",
  );
  return {
    ...actual,
    migrateSessionStoreToDirectory: mocks.migrateSessionStoreToDirectoryMock,
  };
});

import { runStartupSessionStoreMigration } from "./server-session-store-migration.js";

describe("gateway startup session-store migration wiring", () => {
  it("migrates discovered stores and the configured session store path", async () => {
    const info = vi.fn();
    const warn = vi.fn();

    await runStartupSessionStoreMigration({
      stateDir: "/tmp/openclaw",
      configuredStorePath: "/custom/openclaw/main/sessions.json",
      log: { info, warn },
    });

    expect(mocks.listAgentSessionDirsMock).toHaveBeenCalledTimes(1);
    expect(mocks.listAgentSessionDirsMock).toHaveBeenCalledWith("/tmp/openclaw");
    expect(mocks.migrateSessionStoreToDirectoryMock).toHaveBeenCalledWith(
      "/tmp/openclaw/agents/main/sessions/sessions.json",
    );
    expect(mocks.migrateSessionStoreToDirectoryMock).toHaveBeenCalledWith(
      "/tmp/openclaw/agents/worker/sessions/sessions.json",
    );
    expect(mocks.migrateSessionStoreToDirectoryMock).toHaveBeenCalledWith(
      "/custom/openclaw/main/sessions.json",
    );
    expect(info).toHaveBeenCalledWith(
      "session-store migration summary: inspected=3 migrated=0 already_directory=0 skipped_empty=0 skipped_invalid=0 missing=3 failed=0",
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns when invalid or failed migrations are present in the summary", async () => {
    const info = vi.fn();
    const warn = vi.fn();
    mocks.migrateSessionStoreToDirectoryMock
      .mockReset()
      .mockResolvedValueOnce({
        storePath: "/tmp/openclaw/agents/main/sessions/sessions.json",
        outcome: "migrated",
        legacyEntries: 2,
        migratedEntries: 2,
        warnings: [],
      })
      .mockResolvedValueOnce({
        storePath: "/tmp/openclaw/agents/worker/sessions/sessions.json",
        outcome: "skipped_invalid",
        legacyEntries: 0,
        migratedEntries: 0,
        warnings: ["Legacy sessions.json does not contain an object store."],
      })
      .mockRejectedValueOnce(new Error("boom"));

    await runStartupSessionStoreMigration({
      stateDir: "/tmp/openclaw",
      configuredStorePath: "/custom/openclaw/main/sessions.json",
      log: { info, warn },
    });

    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "session-store migration summary: inspected=3 migrated=1 already_directory=0 skipped_empty=0 skipped_invalid=1 missing=0 failed=1",
      ),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "/tmp/openclaw/agents/worker/sessions/sessions.json (invalid legacy store)",
      ),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "/custom/openclaw/main/sessions.json (Migration failed: Error: boom)",
      ),
    );
  });
});
