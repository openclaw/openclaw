import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import {
  deleteSessionEntryLifecycle,
  listSessionEntriesReadOnly,
  replaceSessionEntry,
} from "./session-accessor.js";

// The mocked-platform suite proves the captures keep a mixed-case override, but it
// substitutes the database boundaries and never opens a store, so it cannot show what
// the deletion did. This suite runs the production entrypoint against a real SQLite
// store, and only on Windows, where process.env resolves keys case-insensitively
// because the platform does it, not because a spy says so.
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.unstubAllEnvs();
});

it.runIf(process.platform === "win32")(
  "deletes the entry under a mixed-case state directory and leaves the profile root untouched",
  async () => {
    const configuredRoot = tempDirs.make("openclaw-mixed-case-state-");
    const profileHome = tempDirs.make("openclaw-mixed-case-home-");
    vi.stubEnv("OPENCLAW_STATE_DIR", undefined);
    vi.stubEnv("OPENCLAW_HOME", profileHome);
    vi.stubEnv("OpenClaw_State_Dir", configuredRoot);
    // Windows itself has to be resolving the canonical spelling for this to mean anything.
    expect(process.env.OPENCLAW_STATE_DIR).toBe(configuredRoot);

    const agentDatabasePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    const stateDatabasePath = resolveOpenClawStateSqlitePath();
    const storePath = path.join(configuredRoot, "agents", "main", "sessions", "sessions.json");
    const sessionKey = "agent:main:mixed-case-delete";
    try {
      await replaceSessionEntry(
        { sessionKey, storePath },
        { sessionId: "mixed-case-delete", updatedAt: 1 },
      );
      expect(listSessionEntriesReadOnly({ agentId: "main", storePath })).toHaveLength(1);

      const deletion = await deleteSessionEntryLifecycle({
        agentId: "main",
        storePath,
        target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
        archiveTranscript: false,
        deleteTranscriptWithoutArchive: true,
      });

      expect(deletion.deleted).toBe(true);
      expect(listSessionEntriesReadOnly({ agentId: "main", storePath })).toHaveLength(0);
      // A lost override sends the lifecycle owner to ~/.openclaw instead.
      expect(fs.existsSync(path.join(profileHome, ".openclaw"))).toBe(false);
    } finally {
      // Windows keeps the directory busy until the handles and worker leases settle.
      await closeOpenClawAgentDatabaseByPathAsync(agentDatabasePath);
      await closeOpenClawStateDatabaseByPathAsync(stateDatabasePath);
    }
  },
);
