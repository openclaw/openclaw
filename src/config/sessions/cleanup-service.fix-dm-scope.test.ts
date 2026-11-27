import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { runSessionsCleanup } from "./cleanup-service.js";
import {
  loadSessionEntry,
  loadTranscriptEventsSync,
  replaceSessionEntrySync,
} from "./session-accessor.js";
import { appendTranscriptEventSync } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-cleanup-fix-dm-scope-");

it("retires only direct rows that no route binding still scopes per peer", async () => {
  const storePath = path.join(sessionDirs.make(), "agents", "main", "sessions", "sessions.json");
  const keys = {
    boundChannel: "agent:main:telegram:direct:123",
    boundAccount: "agent:main:slack:work:direct:u1",
    boundPeer: "agent:main:direct:alice",
    boundWildcardPeer: "agent:main:whatsapp:direct:99",
    boundWildcardAccount: "agent:main:matrix:personal:direct:u3",
    otherAgentBinding: "agent:main:discord:direct:456",
    otherAccount: "agent:main:slack:home:direct:u2",
    otherPeer: "agent:main:direct:bob",
    scopedBinding: "agent:main:teams:direct:u4",
  };
  for (const [sessionId, sessionKey] of Object.entries(keys)) {
    replaceSessionEntrySync(
      { agentId: "main", storePath, sessionKey },
      { sessionId, updatedAt: Date.now() },
    );
  }
  const cfg: OpenClawConfig = {
    bindings: [
      { agentId: "main", match: { channel: "Telegram" }, session: { dmScope: "per-channel-peer" } },
      {
        agentId: "main",
        match: { channel: "slack", accountId: "work" },
        session: { dmScope: "per-account-channel-peer" },
      },
      {
        agentId: "main",
        match: { channel: "matrix", accountId: "*" },
        session: { dmScope: "per-account-channel-peer" },
      },
      {
        agentId: "main",
        match: { channel: "signal", peer: { kind: "direct", id: "111" } },
        session: { dmScope: "per-peer" },
      },
      {
        agentId: "main",
        match: { channel: "whatsapp", peer: { kind: "direct", id: " * " } },
        session: { dmScope: "per-channel-peer" },
      },
      {
        agentId: "main",
        match: { channel: "teams", guildId: "tenant" },
        session: { dmScope: "per-channel-peer" },
      },
      { agentId: "ops", match: { channel: "discord" }, session: { dmScope: "per-channel-peer" } },
    ],
    session: { identityLinks: { alice: ["signal:111"] } },
  };

  const result = await runSessionsCleanup({
    cfg,
    opts: { dryRun: true, fixDmScope: true },
    targets: [{ agentId: "main", storePath }],
  });

  expect([...(result.previewResults[0]?.dmScopeRetiredKeys ?? [])].toSorted()).toEqual(
    [keys.otherAccount, keys.otherAgentBinding, keys.otherPeer].toSorted(),
  );
});

it("keeps bound history and archives only the unbound row when applying the repair", async () => {
  const storePath = path.join(sessionDirs.make(), "agents", "main", "sessions", "sessions.json");
  const bound = {
    agentId: "main",
    storePath,
    sessionKey: "agent:main:telegram:direct:123",
    sessionId: "bound-session",
  };
  const unbound = {
    agentId: "main",
    storePath,
    sessionKey: "agent:main:discord:direct:456",
    sessionId: "unbound-session",
  };
  for (const scope of [bound, unbound]) {
    replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: Date.now() });
    appendTranscriptEventSync(scope, { type: "proof", sessionId: scope.sessionId });
  }
  const cfg: OpenClawConfig = {
    bindings: [
      { agentId: "main", match: { channel: "telegram" }, session: { dmScope: "per-channel-peer" } },
    ],
  };

  const result = await runSessionsCleanup({
    cfg,
    opts: { enforce: true, fixDmScope: true },
    targets: [{ agentId: "main", storePath }],
  });

  expect(result.appliedSummaries[0]).toMatchObject({
    beforeCount: 2,
    afterCount: 1,
    dmScopeRetired: 1,
    applied: true,
  });
  expect(loadSessionEntry(bound)).toMatchObject({ sessionId: bound.sessionId });
  expect(loadTranscriptEventsSync(bound)).toEqual([{ type: "proof", sessionId: bound.sessionId }]);
  expect(loadSessionEntry(unbound)).toBeUndefined();
  expect(loadTranscriptEventsSync(unbound)).toEqual([]);

  const databasePath = resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" }).path;
  const archive = openOpenClawAgentDatabase({ agentId: "main", path: databasePath })
    .db.prepare("SELECT session_key FROM session_transcript_archives WHERE session_id = ?")
    .get(unbound.sessionId);
  expect(archive).toEqual({ session_key: unbound.sessionKey });
});
