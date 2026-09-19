import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { insertRegistryWorktree } from "../agents/worktrees/registry.js";
import {
  loadExactSessionEntryReadOnly,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { runSessionStartupMigration } from "../config/sessions/startup-migration.js";
import {
  ensureProjectRegistrySchema,
  insertProjectRegistryInDatabase,
} from "../projects/project-registry.kernel.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  isOpenClawAgentDatabaseOpen,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import * as sessionReaders from "./doctor-session-sqlite-readers.js";
import { noteSessionTranscriptHealth } from "./doctor-session-transcripts.js";

const note = vi.hoisted(() => vi.fn());
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note }));

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

it("repairs discovered worktree sessions only through Doctor and releases their databases", async () => {
  const root = fs.realpathSync.native(tempDirs.make("openclaw-doctor-worktree-route-"));
  const stateDir = path.join(root, "state");
  const repoRoot = path.join(root, "repo");
  const workspace = path.join(repoRoot, "packages", "app");
  const worktreeRoot = path.join(stateDir, "worktrees", "legacy");
  const spawnedCwd = path.join(worktreeRoot, "packages", "app");
  for (const directory of [workspace, spawnedCwd]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  await withEnvAsync({ OPENCLAW_AGENT_DIR: undefined, OPENCLAW_STATE_DIR: stateDir }, async () => {
    const env = { ...process.env };
    const cfg = { agents: { entries: { main: { workspace: repoRoot }, ops: { workspace } } } };
    // Persisted legacy project setup, not a public Git registration-flow proof.
    ensureProjectRegistrySchema({ env });
    const project = runOpenClawStateWriteTransaction(
      ({ db }) =>
        insertProjectRegistryInDatabase(db, {
          displayName: "Legacy workspace project",
          repoRoot: workspace,
          source: "registered",
        }),
      { env },
    );
    const scopes = ["main", "ops"].map((agentId) => ({
      agentId,
      env,
      sessionKey: `agent:${agentId}:legacy-worktree`,
    }));
    insertRegistryWorktree(env, {
      id: "legacy",
      name: "legacy",
      repoFingerprint: "0123456789abcdef",
      repoRoot,
      path: worktreeRoot,
      branch: "openclaw/legacy",
      baseRef: "HEAD",
      ownerKind: "session",
      ownerId: scopes[0]!.sessionKey,
      createdAt: 1,
      lastActiveAt: 1,
    });
    for (const scope of scopes) {
      await replaceSessionEntry(scope, {
        sessionId: `${scope.agentId}-worktree-session`,
        updatedAt: Date.now(),
        ...(scope.agentId === "main" ? { spawnedCwd, projectId: project.id } : {}),
        worktree: {
          id: scope.agentId === "main" ? "legacy" : "other",
          branch: "openclaw/legacy",
          repoRoot: scope.agentId === "main" ? repoRoot : workspace,
        },
      });
    }
    const readEntries = () => scopes.map((scope) => loadExactSessionEntryReadOnly(scope)?.entry);
    const before = readEntries();
    expect(before.every((entry) => entry?.worktree)).toBe(true);

    const log = { info: vi.fn(), warn: vi.fn() };
    await runSessionStartupMigration({ cfg, env, log });
    expect(readEntries()).toEqual(before);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("openclaw doctor --fix"));

    const targetDiscovery = vi.spyOn(sessionReaders, "listExistingAgentDatabaseTargets");
    await noteSessionTranscriptHealth({ cfg, env, shouldRepair: false });
    expect(targetDiscovery).toHaveBeenCalledTimes(1);
    targetDiscovery.mockClear();
    expect(readEntries()).toEqual(before);
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Found 2 managed-worktree session(s)"),
      "Session worktrees",
    );
    await closeOpenClawAgentDatabasesAsync();

    await noteSessionTranscriptHealth({ cfg, env, shouldRepair: true });
    expect(targetDiscovery).toHaveBeenCalledTimes(1);
    targetDiscovery.mockRestore();
    for (const [index, scope] of scopes.entries()) {
      const original = before[index]!;
      expect(loadExactSessionEntryReadOnly(scope)?.entry).toEqual({
        ...original,
        worktree: { ...original.worktree, canonicalWorkspaceDir: workspace },
      });
      expect(isOpenClawAgentDatabaseOpen(resolveOpenClawAgentSqlitePath(scope))).toBe(false);
    }
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Repaired canonical workspace metadata for 2 of 2"),
      "Session worktrees",
    );
  });
});
