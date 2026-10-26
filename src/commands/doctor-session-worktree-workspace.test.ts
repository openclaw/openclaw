import { expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  loadExactSessionEntryReadOnly,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { runSessionStartupMigration } from "../config/sessions/startup-migration.js";
import {
  closeOpenClawAgentDatabasesAsync,
  isOpenClawAgentDatabaseOpen,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { noteSessionTranscriptHealth } from "./doctor-session-transcripts.js";

const note = vi.hoisted(() => vi.fn());
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note }));

it("repairs discovered worktree sessions only through Doctor and releases their databases", async () => {
  await withOpenClawTestState({ layout: "state-only", label: "doctor-worktree" }, async (state) => {
    const { env, workspaceDir: workspace } = state;
    const cfg = { agents: { entries: { main: { workspace }, ops: { workspace } } } };
    setRuntimeConfigSnapshot(cfg);
    const scopes = ["main", "ops"].map((agentId) => ({
      agentId,
      env,
      sessionKey: `agent:${agentId}:legacy-worktree`,
    }));
    for (const scope of scopes) {
      await replaceSessionEntry(scope, {
        sessionId: `${scope.agentId}-worktree-session`,
        updatedAt: Date.now(),
        worktree: {
          id: scope.agentId,
          branch: "openclaw/legacy",
          repoRoot: workspace,
        },
      });
    }
    const readEntries = () => scopes.map((scope) => loadExactSessionEntryReadOnly(scope)?.entry);
    const before = readEntries();
    expect(before.every((entry) => entry?.worktree)).toBe(true);

    const log = { info: vi.fn(), warn: vi.fn() };
    await runSessionStartupMigration({ cfg, env, log });
    expect(readEntries()).toEqual(before);
    expect(log.warn).not.toHaveBeenCalled();

    await noteSessionTranscriptHealth({ cfg, env, shouldRepair: false });
    expect(readEntries()).toEqual(before);
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Found 2 managed-worktree session(s)"),
      "Session worktrees",
    );
    await closeOpenClawAgentDatabasesAsync();

    await noteSessionTranscriptHealth({ cfg, env, shouldRepair: true });
    for (const [index, scope] of scopes.entries()) {
      const original = before[index]!;
      expect(loadExactSessionEntryReadOnly(scope)?.entry).toEqual({
        ...original,
        worktree: { ...original.worktree, canonicalWorkspaceDir: workspace },
      });
      expect(isOpenClawAgentDatabaseOpen(resolveOpenClawAgentSqlitePath(scope))).toBe(false);
    }
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Repaired saved workspace metadata for 2 of 2"),
      "Session worktrees",
    );
  });
});
