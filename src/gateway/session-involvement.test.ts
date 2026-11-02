// Complete cold handler transforms during collection, before timed visibility RPCs.
import "./server-methods/sessions-mutations.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { requireGit } from "../agents/worktrees/git.js";
import { insertRegistryWorktree } from "../agents/worktrees/registry.js";
import type { ManagedWorktreeRecord } from "../agents/worktrees/types.js";
import { loadSessionEntry, replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { projectPublicSessionEntry } from "../config/sessions/session-entry-projection.js";
import * as involvementStore from "../config/sessions/session-involvement-store.js";
import * as agentDb from "../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { linkEmail } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { readMentionStoreSnapshot } from "./mention-inbox-store.worker.js";
import * as mentionInbox from "./mention-inbox.test-support.js";
import { identifiedClient } from "./server-methods/sessions-sharing.test-support.js";
import { listSessionFixture } from "./session-list.test-support.js";
import {
  resolveLocalWorkspaceOwner,
  withLocalWorkspaceProjection,
} from "./worker-environments/local-workspace-projection.js";

const { SESSION_KEY, SESSION_ID } = mentionInbox;
type InboxFixture = Parameters<Parameters<typeof mentionInbox.withMentionInbox>[0]>[0];
const sessionScope = { agentId: "main", sessionKey: SESSION_KEY };
const readEntry = () => loadSessionEntry(sessionScope)!;
function listInvolvement(f: InboxFixture, personal = true) {
  return listSessionFixture({
    cfg: { agents: { entries: { main: {} } } },
    storePath: "",
    store: { [SESSION_KEY]: readEntry() },
    opts: personal ? {} : { profileRelation: { profileId: f.bob.id, relationship: "involving" } },
    ...(personal ? { involvingActorId: f.bob.id } : { ownerFirstActorId: f.alice.id }),
  });
}
async function setHidden(
  f: InboxFixture,
  hidden: boolean,
  key = SESSION_KEY,
  expectedSessionId = SESSION_ID,
  client = f.bobClient,
) {
  const params = { key, expectedSessionId, hidden };
  expect((await f.call("sessions.setInvolvement", params, client)).ok).toBe(true);
}

it("includes a mentioned recipient without recording an authored contribution", () =>
  mentionInbox.withMentionInbox(async (f) => {
    const list = async (profileId = f.bob.id, involving = true) => {
      const entry = readEntry();
      expect(projectPublicSessionEntry(entry)).not.toHaveProperty("profileInvolvement");
      expect(entry.participants).toBeUndefined();
      return await listSessionFixture({
        cfg: { agents: { entries: { main: {} } } },
        storePath: "",
        store: { [SESSION_KEY]: entry },
        // Inbox expiry is independent of the session archive-age policy.
        opts: { archived: "all" },
        ...(involving ? { involvingActorId: profileId } : { ownerFirstActorId: profileId }),
      });
    };
    expect((await list()).sessions).toEqual([]);
    await f.post();
    expect((await list()).sessions.map((row) => row.key)).toEqual([SESSION_KEY]);
    const ids = (await f.items()).map((item) => item.id);
    await mentionInbox.dismissMentionInbox(f.inbox, f.bobClient, ids);
    expect((await list()).sessions.map((row) => row.key)).toEqual([SESSION_KEY]);
    const setVisibility = async (hidden: boolean) => {
      const sql = observeHostDataSql();
      try {
        await setHidden(f, hidden);
        const write = /\b(?:insert\s+into|update|delete\s+from)\s+["`]?session_nodes\b/i;
        expect(sql.queries.filter((query) => write.test(query))).toEqual([]);
      } finally {
        sql.restore();
      }
    };
    await setVisibility(true);
    expect((await list()).sessions).toEqual([]);
    expect((await list(f.bob.id, false)).sessions[0]?.hiddenFromInvolvingMe).toBe(true);
    expect((await list(f.alice.id)).sessions).toHaveLength(1);
    await f.post();
    expect((await list()).sessions).toEqual([]);
    // A stale generic metadata replacement must not erase the personal choice.
    const renamed = { sessionId: SESSION_ID, updatedAt: Date.now(), displayName: "Renamed" };
    replaceSessionEntrySync(sessionScope, renamed);
    expect((await list()).sessions).toEqual([]);
    await f.clock.advanceBy(8 * 24 * 60 * 60_000);
    expect(readMentionStoreSnapshot(-1, openOpenClawStateDatabase().db)?.sources).toHaveLength(0);
    await f.inbox.dispose();
    const restarted = f.openInbox("after-retention");
    await f.post("source-one", {}, restarted);
    expect((await list()).sessions).toEqual([]);
    await f.post("fresh-mention", {}, restarted);
    expect((await list()).sessions.map((row) => row.key)).toEqual([SESSION_KEY]);
    await setVisibility(true);
    await setVisibility(false);
    expect((await list()).sessions).toHaveLength(1);
    // Reset retains the logical node; a fork must not inherit anyone's list choices.
    const previous = readEntry();
    replaceSessionEntrySync(sessionScope, { ...previous, sessionId: "reset-generation" });
    expect((await list()).sessions).toHaveLength(1);
    const forkScope = { ...sessionScope, sessionKey: "agent:main:fork" };
    replaceSessionEntrySync(forkScope, { ...previous, sessionId: "fork-generation" });
    expect(loadSessionEntry(forkScope)).not.toHaveProperty("profileInvolvement");
  }));

it("preserves existing metadata, personal choices and replay watermarks across cold reopen", () =>
  mentionInbox.withMentionInbox(async (f) => {
    const scopes = ["", "-shown", "-untouched"].map((suffix) => ({
      agentId: "main",
      sessionKey: `${SESSION_KEY}${suffix}`,
    }));
    const metadata = { displayName: "Existing session", label: "keep-label", pinnedAt: 12345 };
    for (const [index, scope] of scopes.entries()) {
      await f.setSession({ sessionId: `${SESSION_ID}-${index}`, ...metadata }, scope.sessionKey);
    }
    const entries = () => scopes.map((scope) => loadSessionEntry(scope)!);
    type Entry = ReturnType<typeof readEntry>;
    const profile = (row: Entry) => row.profileInvolvement?.profiles[f.bob.id];
    const existing = entries();
    expect(existing.every((entry) => entry.profileInvolvement === undefined)).toBe(true);
    let inbox = f.inbox;
    const reopen = async () => {
      await inbox.dispose();
      await agentDb.closeOpenClawAgentDatabasesAsync();
      agentDb.closeOpenClawAgentDatabasesForTest();
      await closeStateDatabaseForTest();
      inbox = f.openInbox("cold-reopen");
    };
    const post = (sourceId: string, index: number) => {
      const { sessionKey } = scopes[index]!;
      const { sessionId } = existing[index]!;
      return f.post(sourceId, { sessionKey, sessionId }, inbox);
    };
    const setVisibility = (index: number, hidden: boolean) =>
      setHidden(f, hidden, scopes[index]!.sessionKey, existing[index]!.sessionId);
    await post("before-restart", 0);
    await setVisibility(0, true);
    await post("explicitly-shown", 1);
    await setVisibility(1, true);
    await setVisibility(1, false);
    const beforeClose = entries();
    await reopen();
    expect(entries()).toEqual(beforeClose);
    expect(
      entries()
        .slice(0, 2)
        .map((row) => profile(row)?.hidden),
    ).toEqual([true, false]);
    expect(entries()[2]).toEqual(existing[2]);
    await post("before-restart", 0);
    expect(entries()).toEqual(beforeClose);
    await post("after-restart", 0);
    const fresh = entries();
    expect(fresh[0]).toMatchObject(existing[0]!);
    const generation = profile(beforeClose[0]!)!.lastMention!.generation;
    const mentioned = { hidden: false, lastMention: { generation, sequence: 3 } };
    expect(profile(fresh[0]!)).toMatchObject(mentioned);
    expect(fresh.slice(1)).toEqual(beforeClose.slice(1));
    await reopen();
    expect(entries()).toEqual(fresh);
  }));

it("withholds a fresh Inbox alert when the involvement writer refuses a changed entry", () =>
  mentionInbox.withMentionInbox(async (f) => {
    await f.post("existing");
    await involvementStore.updateSessionProfileInvolvementAsync(sessionScope, {
      expectedSessionId: SESSION_ID,
      profileIds: [f.bob.id],
      change: { kind: "visibility", hidden: true },
    });
    const before = readEntry().profileInvolvement;
    f.push.mockClear();
    const record = involvementStore.updateSessionProfileInvolvementAsync;
    const changed = vi
      .spyOn(involvementStore, "updateSessionProfileInvolvementAsync")
      .mockImplementationOnce(async (...args) => {
        // Both shapes remain shared, but the captured raw entry no longer matches.
        await f.setSession({ visibility: undefined });
        return record(...args);
      });
    try {
      await f.post("refused");
      await expect(changed.mock.results[0]?.value).resolves.toBe(false);
      expect(readEntry().profileInvolvement).toEqual(before);
      expect((await f.items()).map((item) => item.messageId)).toEqual(["message-existing"]);
      expect(f.push).not.toHaveBeenCalled();
    } finally {
      changed.mockRestore();
    }
  }));

it("rejects personal hide requests for another identity or stale/inaccessible sessions", () =>
  mentionInbox.withMentionInbox(async (f) => {
    const params = { key: SESSION_KEY, expectedSessionId: SESSION_ID, hidden: true };
    const deny = async (
      overrides: Partial<typeof params> & { profileId?: string } = {},
      client: Parameters<InboxFixture["call"]>[2] = f.bobClient,
    ) => {
      const result = await f.call("sessions.setInvolvement", { ...params, ...overrides }, client);
      expect(result.ok).toBe(false);
    };
    await deny({ profileId: f.alice.id });
    await deny({ expectedSessionId: "stale" });
    await deny({}, { ...f.bobClient, internal: { syntheticClient: true } });
    await f.setSession({ visibility: "draft" });
    await deny();
    await f.setSession({ incognito: true });
    await deny();
    expect(readEntry()).not.toHaveProperty("profileInvolvement");
  }));

it("does not let a personal show choice change another viewer's involvement query", () =>
  mentionInbox.withMentionInbox(async (f) => {
    for (const hidden of [true, false, true]) {
      await setHidden(f, hidden);
      expect((await listInvolvement(f)).sessions).toHaveLength(hidden ? 0 : 1);
      expect((await listInvolvement(f, false)).sessions).toEqual([]);
    }
  }));

it("keeps merged visibility separate from mention evidence when both profiles were mentioned", () =>
  mentionInbox.withMentionInbox(async (f) => {
    const old = ensureProfileForEmail("previous@mentions.example.test");
    const oldClient = { ...identifiedClient(old.id, "Previous"), connId: "previous" };
    await f.post("old-mention", { recipientProfileIds: [old.id] });
    await f.post("existing-current-profile-mention");
    await setHidden(f, true, SESSION_KEY, SESSION_ID, oldClient);
    linkEmail("previous@mentions.example.test", f.bob.id);
    expect((await listInvolvement(f)).sessions).toEqual([]);
    expect((await listInvolvement(f, false)).sessions).toHaveLength(1);
    await f.post("existing-current-profile-mention");
    expect((await listInvolvement(f)).sessions).toEqual([]);
    await f.post("new-mention");
    expect((await listInvolvement(f)).sessions).toHaveLength(1);
  }));

it("keeps a retained workspace usable through personal Hide and Show, but rejects a reset", () =>
  mentionInbox.withMentionInbox(async (f) => {
    const repo = path.join(process.env.OPENCLAW_STATE_DIR!, "involvement-project");
    await fs.mkdir(repo);
    const git = (...args: string[]) => requireGit(repo, args);
    await git("init", "--quiet", "-b", "main");
    await git("config", "user.name", "Test");
    await git("config", "user.email", "test@example.invalid");
    await fs.writeFile(path.join(repo, "project.txt"), "initial work\n");
    await git("add", "project.txt");
    await git("commit", "--quiet", "-m", "Initial project");
    const worktree: ManagedWorktreeRecord = {
      id: randomUUID(),
      name: "involvement",
      repoFingerprint: "fixture",
      repoRoot: repo,
      path: repo,
      branch: "main",
      baseRef: "main",
      ownerKind: "session",
      ownerId: SESSION_KEY,
      createdAt: 1,
      lastActiveAt: 1,
    };
    await insertRegistryWorktree(process.env, worktree);
    await f.setSession({ worktree });
    using owner = await resolveLocalWorkspaceOwner({ ...sessionScope, cfg: {} });
    expect(owner).toBeDefined();
    if (!owner) {
      throw new Error("Managed workspace fixture was not admitted");
    }
    const projection = await withLocalWorkspaceProjection(owner, (state) => state.prepare());
    for (const hidden of [true, false]) {
      await setHidden(f, hidden);
      expect(readEntry().profileInvolvement?.profiles[f.bob.id]?.hidden).toBe(hidden);
      expect(projectPublicSessionEntry(readEntry())).not.toHaveProperty("profileInvolvement");
      // Keep the same active workspace owner across another person's personal action.
      owner.assertCurrent();
      const contents = hidden ? "continued after Hide\n" : "completed after Show\n";
      await fs.writeFile(path.join(projection, "project.txt"), contents);
      await withLocalWorkspaceProjection(owner, (state) => state.synchronize("canonical"));
      expect(await fs.readFile(path.join(repo, "project.txt"), "utf8")).toBe(contents);
    }
    await f.setSession({ lifecycleRevision: "reset-after-personal-actions" });
    expect(() => owner.assertCurrent()).toThrow("Local sandbox workspace authority changed");
  }));
