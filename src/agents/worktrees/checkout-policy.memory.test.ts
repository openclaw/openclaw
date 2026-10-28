import { afterEach, expect, it } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  replaceSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { usesSourceOnlyWorktreeGit } from "./checkout-policy.js";
import type { ManagedWorktreeRecord } from "./types.js";

afterEach(() => memorySessionActorOwners.reset());

it("uses current memory custody and sandbox policy for repository programs without host SQL", async () => {
  await withOpenClawTestState({ label: "memory-worktree-policy" }, async (state) => {
    const sessionKey = "agent:main:dashboard:incognito-worktree";
    const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: state.env });
    const scope = { agentId: "main", sessionKey, storePath, env: state.env };
    const record: ManagedWorktreeRecord = {
      id: "worktree",
      name: "fixture",
      repoFingerprint: "0123456789abcdef",
      repoRoot: state.path("repo"),
      path: state.path("worktree"),
      branch: "fixture",
      baseRef: "main",
      ownerKind: "session",
      ownerId: sessionKey,
      createdAt: 1,
      lastActiveAt: 1,
    };
    const config = () => ({ agents: { defaults: { sandbox: { mode: "all" as const } } } });
    const read = () => usesSourceOnlyWorktreeGit(record, state.env, config);
    const observe = observeHostDataSql();
    try {
      expect(await read()).toBe(true);
      expect(memorySessionActorOwners.read({ agentId: "main", path: storePath })).toBeUndefined();
      await replaceSessionEntry(scope, {
        sessionId: "session",
        updatedAt: 1,
        incognito: true,
        sandboxMode: "off",
        worktree: { id: record.id, branch: record.branch, repoRoot: record.repoRoot },
      });
      expect(await read()).toBe(false);
      await upsertSessionEntryCore(scope, { sandboxMode: undefined });
      expect(await read()).toBe(true);
      await upsertSessionEntryCore(scope, { sandboxMode: "off", worktree: undefined });
      expect(await read()).toBe(true);
      memorySessionActorOwners.closeSession({ agentId: "main", path: storePath }, sessionKey);
      expect(await read()).toBe(true);
      expect(observe.queries).toEqual([]);
    } finally {
      observe.restore();
    }
  });
});
