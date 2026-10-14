import "../../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import {
  isSessionEntryDataSql,
  observeHostDataSql,
} from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { ManagedWorktreeService } from "../../agents/worktrees/service.js";
import { initializeManagedWorktreeTestRepository } from "../../agents/worktrees/service.test-support.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/io.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { prepareSessionWorkspaceForRun } from "./session-create-project.js";

const authority = { assertCurrent() {} };
let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
let storePath: string;
let workspace: string;
let cfg: OpenClawConfig;
const ownedKeys = new Set<string>();

beforeAll(async () => {
  state = await createOpenClawTestState({ layout: "state-only", prefix: "workspace-actor-" });
  workspace = await initializeManagedWorktreeTestRepository(state.root);
  cfg = { agents: { entries: { main: { workspace } } } };
  setRuntimeConfigSnapshot(cfg);
  storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: state.env });
});
afterEach(async () => {
  vi.restoreAllMocks();
  const worktrees = new ManagedWorktreeService({ env: state.env });
  for (const key of ownedKeys) {
    const record = await worktrees.findLiveByOwner("session", key);
    if (record) {
      await worktrees.remove({ id: record.id, reason: "test-cleanup", allowSnapshotLoss: true });
    }
  }
  ownedKeys.clear();
});
afterAll(async () => {
  memorySessionActorOwners.closeDatabase({ agentId: "main", path: storePath });
  clearRuntimeConfigSnapshot();
  await state?.cleanup();
});

async function createPendingSession(name: string) {
  const sessionKey = `agent:main:dashboard:incognito-workspace-${name}`;
  const entry: InternalSessionEntry = {
    sessionId: name,
    updatedAt: Date.now(),
    incognito: true,
    pendingWorktree: { workspace, name, baseRef: "main", titleSource: name },
  };
  ownedKeys.add(sessionKey);
  await replaceSessionEntry({ sessionKey, storePath }, entry);
  return { sessionKey, entry };
}

function prepare(sessionKey: string, entry: InternalSessionEntry) {
  return prepareSessionWorkspaceForRun({
    entry,
    cfg,
    agentId: "main",
    runId: `run-${entry.sessionId}`,
    sessionKey,
    storePath,
    context: createDirectChatContext({ getRuntimeConfig: () => cfg }),
    signal: new AbortController().signal,
    assertCurrent: () => authority.assertCurrent(),
    runSetupScript: false,
  });
}

it("materializes and commits an unbound first-turn worktree without host session SQL", async () => {
  const { sessionKey, entry } = await createPendingSession("first-turn");
  const sql = observeHostDataSql();
  try {
    await prepare(sessionKey, entry);
    const saved = loadSessionEntry({ sessionKey, storePath });
    assert(saved?.worktree);
    const record = await new ManagedWorktreeService({ env: state.env }).findLiveByOwner(
      "session",
      sessionKey,
    );
    assert(record);
    expect(record).toMatchObject({ id: saved.worktree.id, name: "first-turn", baseRef: "main" });
    expect(saved).toMatchObject({
      sessionId: entry.sessionId,
      sessionRoot: record.path,
      spawnedCwd: record.path,
      worktree: { repoRoot: workspace },
    });
    expect(saved.pendingWorktree).toBeUndefined();
    expect(entry.worktree).toEqual(saved.worktree);
    expect(await readFile(path.join(record.path, "README.md"), "utf8")).toBe("base\n");
    expect(sql.queries.filter(isSessionEntryDataSql)).toEqual([]);
  } finally {
    sql.restore();
  }
});

it.each(["lifecycle", "intent"] as const)(
  "refuses a changed %s after resolving the repository and before workspace allocation",
  async (change) => {
    const { sessionKey, entry } = await createPendingSession(`changed-${change}`);
    const pendingWorktree = entry.pendingWorktree;
    assert(pendingWorktree);
    const entered = createDeferred();
    const resume = createDeferred();
    // oxlint-disable-next-line typescript/unbound-method -- The real method is called with its original receiver below.
    const resolveRepository = ManagedWorktreeService.prototype.resolveRepositoryPaths;
    vi.spyOn(ManagedWorktreeService.prototype, "resolveRepositoryPaths").mockImplementationOnce(
      async function (this: ManagedWorktreeService, ...args) {
        const resolved = await resolveRepository.apply(this, args);
        entered.resolve();
        await resume.promise;
        return resolved;
      },
    );
    const pending = prepare(sessionKey, entry);
    const settled = pending.then(
      () => ({ completed: true }),
      (error: unknown) => ({ error }),
    );
    try {
      await awaitGateBeforeSettlement(entered.promise, pending, "repository was not resolved");
      await patchSessionEntryCore({ sessionKey, storePath }, () =>
        change === "lifecycle"
          ? { lifecycleRevision: "replacement" }
          : { pendingWorktree: { ...pendingWorktree, name: "replacement" } },
      );
    } finally {
      resume.resolve();
      await settled;
    }
    expect(await settled).toMatchObject({
      error: expect.objectContaining({ message: expect.stringMatching(/changed|current/i) }),
    });
    const saved = loadSessionEntry({ sessionKey, storePath });
    expect(saved?.worktree).toBeUndefined();
    expect(saved?.pendingWorktree?.name).toBe(
      change === "intent" ? "replacement" : `changed-${change}`,
    );
    expect(
      await new ManagedWorktreeService({ env: state.env }).findLiveByOwner("session", sessionKey),
    ).toBeUndefined();
  },
);
