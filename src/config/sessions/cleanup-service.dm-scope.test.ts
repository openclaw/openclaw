import path from "node:path";
import { expect, it } from "vitest";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { runSessionsCleanup } from "./cleanup-service.js";
import { appendUserMessage } from "./cleanup-service.test-support.js";
import {
  loadSessionEntry,
  loadTranscriptEventsSync,
  replaceSessionEntry,
} from "./session-accessor.js";

it("preserves binding-routed DM sessions and history across cleanup and reopening", async () => {
  await withOpenClawTestState({}, async (state) => {
    const cfg: OpenClawConfig = {
      agents: { entries: { main: {}, other: {} } },
      session: {
        dmScope: "main",
        identityLinks: { Alice: ["discord:123"] },
        maintenance: { mode: "enforce", maxDiskBytes: false, archiveDashboardAfter: false },
      },
      bindings: [
        { agentId: "main", match: { channel: "signal" }, session: { dmScope: "per-peer" } },
        {
          agentId: "main",
          match: { channel: "discord", peer: { kind: "direct", id: "123" } },
          session: { dmScope: "per-channel-peer" },
        },
        {
          agentId: "main",
          match: { channel: "slack", accountId: "work", teamId: "T1" },
          session: { dmScope: "per-account-channel-peer" },
        },
        {
          agentId: "main",
          match: { channel: "matrix", peer: { kind: "direct", id: "retired" } },
        },
        { agentId: "main", match: { channel: "matrix" }, session: { dmScope: "per-channel-peer" } },
        { agentId: "main", match: { channel: "irc" } },
        {
          agentId: "main",
          match: { channel: "irc", accountId: "*" },
          session: { dmScope: "per-channel-peer" },
        },
        {
          agentId: "other",
          match: { channel: "imessage" },
          session: { dmScope: "per-channel-peer" },
        },
      ],
    };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    const storePath = path.join(state.sessionsDir(), "sessions.json");
    const sessionId = (key: string) => key.replaceAll(":", "-");
    const scope = (key: string) => ({
      agentId: "main",
      storePath,
      sessionKey: `agent:main:${key}`,
    });
    const retained = [
      "direct:bob",
      "discord:direct:alice",
      "slack:work:direct:u1",
      "matrix:direct:current",
      "irc:direct:guest",
    ];
    const retired = [
      "discord:direct:unbound",
      "slack:personal:direct:u1",
      "matrix:direct:retired",
      "imessage:direct:bob",
    ];
    for (const key of [...retained, ...retired]) {
      await replaceSessionEntry(scope(key), { sessionId: sessionId(key), updatedAt: Date.now() });
      appendUserMessage(
        { ...scope(key), sessionId: sessionId(key) },
        `message-${key}`,
        `Keep ${key}`,
      );
    }
    const history = new Map(
      retained.map((key) => [
        key,
        loadTranscriptEventsSync({ ...scope(key), sessionId: sessionId(key) }),
      ]),
    );
    for (const key of retained) {
      expect(JSON.stringify(history.get(key))).toContain(`Keep ${key}`);
    }
    const cleanup = (dryRun: boolean) =>
      runSessionsCleanup({
        cfg,
        opts: { fixDmScope: true, enforce: true, dryRun },
        targets: [{ agentId: "main", storePath }],
      });
    const preview = await cleanup(true);
    expect([...preview.previewResults[0]!.dmScopeRetiredKeys].toSorted()).toEqual(
      retired.map((key) => scope(key).sessionKey).toSorted(),
    );
    for (const key of [...retained, ...retired]) {
      expect(loadSessionEntry(scope(key))?.sessionId).toBe(sessionId(key));
    }
    const applied = await cleanup(false);
    expect(applied.appliedSummaries[0]).toMatchObject({
      beforeCount: retained.length + retired.length,
      afterCount: retained.length,
      dmScopeRetired: retired.length,
    });
    await closeOpenClawAgentDatabasesAsync(state.root);
    for (const key of retained) {
      expect(loadSessionEntry(scope(key))?.sessionId).toBe(sessionId(key));
      expect(loadTranscriptEventsSync({ ...scope(key), sessionId: sessionId(key) })).toEqual(
        history.get(key),
      );
    }
    for (const key of retired) {
      expect(loadSessionEntry(scope(key))).toBeUndefined();
    }
  });
});
