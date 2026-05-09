import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { readTranscriptStateForSession } from "../agents/transcript/transcript-state.js";
import { getSessionEntry, upsertSessionEntry } from "../config/sessions.js";
import { createSqliteSessionTranscriptLocator } from "../config/sessions/paths.js";
import { replaceSqliteSessionTranscriptEvents } from "../config/sessions/transcript-store.sqlite.js";
import { DEFAULT_AGENT_ID } from "../routing/session-key.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  embeddedRunMock,
  piSdkMock,
  rpcReq,
  startConnectedServerWithClient,
} from "./test-helpers.js";
import {
  setupGatewaySessionsTestHarness,
  getSessionManagerModule,
  getGatewayConfigModule,
  sessionStoreEntry,
  createCheckpointFixture,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, openClient } = setupGatewaySessionsTestHarness();

function sqliteTranscript(sessionId: string, agentId = DEFAULT_AGENT_ID): string {
  return createSqliteSessionTranscriptLocator({ agentId, sessionId });
}

test("sessions.compaction.* lists checkpoints and branches or restores from pre-compaction snapshots", async () => {
  const { dir } = await createSessionStoreDir();
  const fixture = await createCheckpointFixture(dir);
  const checkpointCreatedAt = Date.now();
  const { SessionManager } = await getSessionManagerModule();
  upsertSessionEntry({
    agentId: "main",
    sessionKey: "agent:main:main",
    entry: sessionStoreEntry(fixture.sessionId, {
      compactionCheckpoints: [
        {
          checkpointId: "checkpoint-1",
          sessionKey: "agent:main:main",
          sessionId: fixture.sessionId,
          createdAt: checkpointCreatedAt,
          reason: "manual",
          tokensBefore: 123,
          tokensAfter: 45,
          summary: "checkpoint summary",
          firstKeptEntryId: fixture.preCompactionLeafId,
          preCompaction: {
            sessionId: fixture.preCompactionSessionId,
            leafId: fixture.preCompactionLeafId,
          },
          postCompaction: {
            sessionId: fixture.sessionId,
            leafId: fixture.postCompactionLeafId,
            entryId: fixture.postCompactionLeafId,
          },
        },
      ],
    }),
  });

  const { ws } = await openClient();

  const listedSessions = await rpcReq<{
    sessions: Array<{
      key: string;
      compactionCheckpointCount?: number;
      latestCompactionCheckpoint?: {
        checkpointId: string;
        createdAt: number;
        reason: string;
        summary?: string;
        tokensBefore?: number;
        tokensAfter?: number;
      };
    }>;
  }>(ws, "sessions.list", {});
  expect(listedSessions.ok).toBe(true);
  const main = listedSessions.payload?.sessions.find(
    (session) => session.key === "agent:main:main",
  );
  expect(main?.compactionCheckpointCount).toBe(1);
  expect(main?.latestCompactionCheckpoint).toEqual({
    checkpointId: "checkpoint-1",
    createdAt: checkpointCreatedAt,
    reason: "manual",
  });

  const listedCheckpoints = await rpcReq<{
    ok: true;
    key: string;
    checkpoints: Array<{ checkpointId: string; summary?: string; tokensBefore?: number }>;
  }>(ws, "sessions.compaction.list", { key: "main" });
  expect(listedCheckpoints.ok).toBe(true);
  expect(listedCheckpoints.payload?.key).toBe("agent:main:main");
  expect(listedCheckpoints.payload?.checkpoints).toHaveLength(1);
  expect(listedCheckpoints.payload?.checkpoints[0]).toMatchObject({
    checkpointId: "checkpoint-1",
    summary: "checkpoint summary",
    tokensBefore: 123,
  });

  const checkpoint = await rpcReq<{
    ok: true;
    key: string;
    checkpoint: {
      checkpointId: string;
      preCompaction: { sessionId: string; transcriptLocator?: string };
    };
  }>(ws, "sessions.compaction.get", {
    key: "main",
    checkpointId: "checkpoint-1",
  });
  expect(checkpoint.ok).toBe(true);
  expect(checkpoint.payload?.checkpoint.checkpointId).toBe("checkpoint-1");
  expect(checkpoint.payload?.checkpoint.preCompaction.sessionId).toBe(
    fixture.preCompactionSessionId,
  );

  const sessionManagerOpenSpy = vi.spyOn(SessionManager, "openForSession");
  const sessionManagerForkFromSpy = vi.spyOn(SessionManager, "forkFromSession");
  let branched: Awaited<
    ReturnType<
      typeof rpcReq<{
        ok: true;
        sourceKey: string;
        key: string;
        entry: { sessionId: string; transcriptLocator?: string; parentSessionKey?: string };
      }>
    >
  >;
  try {
    branched = await rpcReq<{
      ok: true;
      sourceKey: string;
      key: string;
      entry: { sessionId: string; transcriptLocator?: string; parentSessionKey?: string };
    }>(ws, "sessions.compaction.branch", {
      key: "main",
      checkpointId: "checkpoint-1",
    });
    expect(sessionManagerOpenSpy).not.toHaveBeenCalled();
    expect(sessionManagerForkFromSpy).not.toHaveBeenCalled();
  } finally {
    sessionManagerOpenSpy.mockRestore();
    sessionManagerForkFromSpy.mockRestore();
  }
  expect(branched.ok).toBe(true);
  expect(branched.payload?.sourceKey).toBe("agent:main:main");
  expect(branched.payload?.entry.parentSessionKey).toBe("agent:main:main");
  const branchedSession = await readTranscriptStateForSession({
    agentId: "main",
    sessionId: branched.payload!.entry.sessionId,
  });
  expect(branchedSession.getEntries()).toHaveLength(
    fixture.preCompactionSession.getEntries().length,
  );

  const branchedEntry = getSessionEntry({
    agentId: "main",
    sessionKey: branched.payload!.key,
  });
  expect(branchedEntry?.parentSessionKey).toBe("agent:main:main");
  expect(branchedEntry?.compactionCheckpoints).toBeUndefined();

  const restoreSessionManagerOpenSpy = vi.spyOn(SessionManager, "openForSession");
  const restoreSessionManagerForkFromSpy = vi.spyOn(SessionManager, "forkFromSession");
  let restored: Awaited<
    ReturnType<
      typeof rpcReq<{
        ok: true;
        key: string;
        sessionId: string;
        entry: { sessionId: string; transcriptLocator?: string; compactionCheckpoints?: unknown[] };
      }>
    >
  >;
  try {
    restored = await rpcReq<{
      ok: true;
      key: string;
      sessionId: string;
      entry: { sessionId: string; transcriptLocator?: string; compactionCheckpoints?: unknown[] };
    }>(ws, "sessions.compaction.restore", {
      key: "main",
      checkpointId: "checkpoint-1",
    });
    expect(restoreSessionManagerOpenSpy).not.toHaveBeenCalled();
    expect(restoreSessionManagerForkFromSpy).not.toHaveBeenCalled();
  } finally {
    restoreSessionManagerOpenSpy.mockRestore();
    restoreSessionManagerForkFromSpy.mockRestore();
  }
  expect(restored.ok).toBe(true);
  expect(restored.payload?.key).toBe("agent:main:main");
  expect(restored.payload?.sessionId).not.toBe(fixture.sessionId);
  expect(restored.payload?.entry.compactionCheckpoints).toHaveLength(1);
  const restoredSession = await readTranscriptStateForSession({
    agentId: "main",
    sessionId: restored.payload!.entry.sessionId,
  });
  expect(restoredSession.getEntries()).toHaveLength(
    fixture.preCompactionSession.getEntries().length,
  );

  const restoredEntry = getSessionEntry({ agentId: "main", sessionKey: "agent:main:main" });
  expect(restoredEntry?.sessionId).toBe(restored.payload?.sessionId);
  expect(restoredEntry?.compactionCheckpoints).toHaveLength(1);

  ws.close();
});

test("sessions.compact without maxLines runs embedded manual compaction for checkpoint-capable flows", async () => {
  const { dir } = await createSessionStoreDir();
  const transcriptLocator = sqliteTranscript("sess-main");
  replaceSqliteSessionTranscriptEvents({
    agentId: DEFAULT_AGENT_ID,
    sessionId: "sess-main",
    events: [
      {
        type: "session",
        id: "sess-main",
        timestamp: new Date().toISOString(),
        cwd: dir,
      },
      {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "hello", timestamp: Date.now() },
      },
    ],
  });
  upsertSessionEntry({
    agentId: "main",
    sessionKey: "agent:main:main",
    entry: sessionStoreEntry("sess-main", {
      thinkingLevel: "medium",
      reasoningLevel: "stream",
    }),
  });

  const { ws } = await openClient();
  const compacted = await rpcReq<{
    ok: true;
    key: string;
    compacted: boolean;
    result?: { tokensAfter?: number };
  }>(ws, "sessions.compact", {
    key: "main",
  });

  expect(compacted.ok).toBe(true);
  expect(compacted.payload?.key).toBe("agent:main:main");
  expect(compacted.payload?.compacted).toBe(true);
  expect(embeddedRunMock.compactEmbeddedPiSession).toHaveBeenCalledTimes(1);
  expect(embeddedRunMock.compactEmbeddedPiSession).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: "sess-main",
      sessionKey: "agent:main:main",
      config: expect.any(Object),
      provider: expect.any(String),
      model: expect.any(String),
      thinkLevel: "medium",
      reasoningLevel: "stream",
      trigger: "manual",
    }),
  );

  const entry = getSessionEntry({ agentId: "main", sessionKey: "agent:main:main" });
  expect(entry?.compactionCount).toBe(1);
  expect(entry?.totalTokens).toBe(80);
  expect(entry?.totalTokensFresh).toBe(true);

  ws.close();
});

test("sessions.patch preserves nested model ids under provider overrides", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-sessions-nested-"));
  await withEnvAsync({ OPENCLAW_STATE_DIR: dir }, async () => {
    upsertSessionEntry({
      agentId: "main",
      sessionKey: "agent:main:main",
      entry: sessionStoreEntry("sess-main"),
    });
  });

  await withEnvAsync({ OPENCLAW_CONFIG_PATH: undefined, OPENCLAW_STATE_DIR: dir }, async () => {
    const { clearConfigCache, clearRuntimeConfigSnapshot } = await getGatewayConfigModule();
    clearConfigCache();
    clearRuntimeConfigSnapshot();
    const cfg = {
      session: { mainKey: "main" },
      agents: {
        defaults: {
          model: { primary: "openai/gpt-test-a" },
        },
        list: [{ id: "main", default: true, workspace: dir }],
      },
    };
    const configPath = path.join(dir, "openclaw.json");
    await fs.writeFile(configPath, JSON.stringify(cfg, null, 2), "utf-8");

    await withEnvAsync({ OPENCLAW_CONFIG_PATH: configPath }, async () => {
      const started = await startConnectedServerWithClient();
      const { server, ws } = started;
      try {
        piSdkMock.enabled = true;
        piSdkMock.models = [
          { id: "moonshotai/kimi-k2.5", name: "Kimi K2.5 (NVIDIA)", provider: "nvidia" },
        ];

        const patched = await rpcReq<{
          ok: true;
          entry: {
            modelOverride?: string;
            providerOverride?: string;
            model?: string;
            modelProvider?: string;
          };
          resolved?: { model?: string; modelProvider?: string };
        }>(ws, "sessions.patch", {
          key: "agent:main:main",
          model: "nvidia/moonshotai/kimi-k2.5",
        });
        expect(patched.ok).toBe(true);
        expect(patched.payload?.entry.modelOverride).toBe("moonshotai/kimi-k2.5");
        expect(patched.payload?.entry.providerOverride).toBe("nvidia");
        expect(patched.payload?.entry.model).toBeUndefined();
        expect(patched.payload?.entry.modelProvider).toBeUndefined();
        expect(patched.payload?.resolved?.modelProvider).toBe("nvidia");
        expect(patched.payload?.resolved?.model).toBe("moonshotai/kimi-k2.5");

        const listed = await rpcReq<{
          sessions: Array<{ key: string; modelProvider?: string; model?: string }>;
        }>(ws, "sessions.list", {});
        expect(listed.ok).toBe(true);
        const mainSession = listed.payload?.sessions.find(
          (session) => session.key === "agent:main:main",
        );
        expect(mainSession?.modelProvider).toBe("nvidia");
        expect(mainSession?.model).toBe("moonshotai/kimi-k2.5");
      } finally {
        ws.close();
        await server.close();
      }
    });
  });
});
