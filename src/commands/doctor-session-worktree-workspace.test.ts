import { expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import * as sessions from "../config/sessions/session-accessor.js";
import { runSessionStartupMigration } from "../config/sessions/startup-migration.js";
import * as agentDb from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { noteSessionTranscriptHealth } from "./doctor-session-transcripts.js";

const note = vi.hoisted(() => vi.fn());
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note }));
const expectNote = (text: string) =>
  expect(note).toHaveBeenCalledWith(expect.stringContaining(text), "Session worktrees");

it("repairs discovered worktree sessions only through Doctor and releases their databases", () =>
  withOpenClawTestState({ layout: "state-only", label: "doctor-worktree" }, async (state) => {
    const { env, workspaceDir: workspace } = state;
    const cfg = { agents: { entries: { main: { workspace }, ops: { workspace } } } };
    setRuntimeConfigSnapshot(cfg);
    const scopes = ["main", "ops"].map((agentId) => ({
      agentId,
      env,
      sessionKey: `agent:${agentId}:legacy-worktree`,
    }));
    for (const scope of scopes) {
      await sessions.replaceSessionEntry(scope, {
        sessionId: `${scope.agentId}-worktree-session`,
        updatedAt: Date.now(),
        worktree: {
          id: scope.agentId,
          branch: "openclaw/legacy",
          repoRoot: workspace,
        },
      });
    }
    const readEntries = () =>
      scopes.map((scope) => sessions.loadExactSessionEntryReadOnly(scope)?.entry);
    const before = readEntries();

    const log = { info: vi.fn(), warn: vi.fn() };
    await runSessionStartupMigration({ cfg, env, log });
    expect(readEntries()).toEqual(before);
    expect(log.warn).not.toHaveBeenCalled();

    await noteSessionTranscriptHealth({ cfg, env, shouldRepair: false });
    expect(readEntries()).toEqual(before);
    expectNote("Found 2 managed-worktree session(s)");
    await agentDb.closeOpenClawAgentDatabasesAsync();

    await noteSessionTranscriptHealth({ cfg, env, shouldRepair: true });
    for (const [index, scope] of scopes.entries()) {
      const original = before[index]!;
      expect(sessions.loadExactSessionEntryReadOnly(scope)?.entry).toEqual({
        ...original,
        worktree: { ...original.worktree, canonicalWorkspaceDir: workspace },
      });
      expect(
        agentDb.isOpenClawAgentDatabaseOpen(agentDb.resolveOpenClawAgentSqlitePath(scope)),
      ).toBe(false);
    }
    expectNote("Repaired saved workspace metadata for 2 of 2");
  }));
