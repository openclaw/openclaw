import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../types.openclaw.js";
import { purgeAgentSessionStoreEntries } from "./cleanup-service.js";

const sessionAccessorMocks = vi.hoisted(() => ({
  applySessionEntryLifecycleMutation: vi.fn(async () => ({
    removedEntries: 0,
    removedSessionKeys: [],
    archivedTranscriptDirectories: [],
    unreferencedArtifacts: null,
    maintenanceReport: null,
    afterCount: 0,
  })),
  purgeDeletedAgentSessionEntries: vi.fn(async () => ({
    removedEntries: 0,
    removedSessionKeys: [],
    archivedTranscriptDirectories: [],
    unreferencedArtifacts: null,
    maintenanceReport: null,
    afterCount: 0,
  })),
}));

const loggerMocks = vi.hoisted(() => {
  const logger = { debug: vi.fn() };
  return {
    getLogger: vi.fn(() => logger),
    logger,
  };
});

vi.mock("./session-accessor.js", () => sessionAccessorMocks);
vi.mock("../../logging/logger.js", () => loggerMocks);

describe("purgeAgentSessionStoreEntries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("purges deleted-agent entries through the storage boundary", async () => {
    const cfg = {
      session: { store: "/tmp/openclaw-agent-purge-sessions.json" },
      agents: {
        list: [
          { id: "main", workspace: "/workspace/main" },
          { id: "ops", workspace: "/workspace/ops" },
        ],
      },
    } satisfies OpenClawConfig;

    await purgeAgentSessionStoreEntries(cfg, "ops");

    expect(sessionAccessorMocks.purgeDeletedAgentSessionEntries).toHaveBeenCalledWith({
      cfg,
      agentId: "ops",
      storeAgentId: "main",
      storePath: "/tmp/openclaw-agent-purge-sessions.json",
    });
    expect(sessionAccessorMocks.applySessionEntryLifecycleMutation).not.toHaveBeenCalled();
  });

  it("keeps purge failure diagnostics as metadata plus a final message", async () => {
    sessionAccessorMocks.purgeDeletedAgentSessionEntries.mockRejectedValueOnce(new Error("boom"));
    const cfg = {
      session: { store: "/tmp/openclaw-agent-purge-sessions.json" },
      agents: { list: [{ id: "ops", workspace: "/workspace/ops" }] },
    } satisfies OpenClawConfig;

    await purgeAgentSessionStoreEntries(cfg, "ops");

    expect(loggerMocks.logger.debug).toHaveBeenCalledOnce();
    expect(loggerMocks.logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ error: "Error: boom" }),
      "session store purge skipped during agent delete",
    );
  });
});
