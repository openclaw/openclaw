import assert from "node:assert/strict";
import { expect, it } from "vitest";
import { prepareSessionEntryPresenceRead } from "../config/sessions/session-entry-presence-read.js";
import {
  withIncognitoSessionActor,
  withIncognitoSessionBinding,
} from "../config/sessions/session-incognito-binding.js";
import { readSessionTranscriptModelContextAsync } from "../config/sessions/session-transcript-context-read.js";
import { withSessionTranscriptDeltaReader } from "../config/sessions/session-transcript-delta-read.js";
import { prepareSessionTranscriptHydration } from "../config/sessions/session-transcript-hydration.js";
import { reconcileSessionTranscriptIndexes } from "../config/sessions/session-transcript-reconcile.js";
import { readTranscriptStatsAsync } from "../config/sessions/session-transcript-stats.js";
import { readSessionTranscriptWatermarkAsync } from "../config/sessions/session-transcript-watermark.js";
import {
  readLatestAssistantTextFromSessionTranscript,
  readRecentUserAssistantTextForSession,
} from "../config/sessions/transcript.js";
import {
  readLatestAssistantTextByIdentity,
  readSessionTranscriptEvents,
  readSessionTranscriptRawDelta,
  readSessionTranscriptVisibleMessageDelta,
} from "../plugin-sdk/session-transcript-runtime.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";
import type { HistoryWiringFixture } from "./openclaw-agent-execution-incognito.history-visibility.test-support.js";
import { captureOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution.js";

export function registerIncognitoSdkHistoryTests(fixture: HistoryWiringFixture) {
  it("keeps raw off-path, exact visible cursors, and latest assistant distinct at the SDK boundary", async () => {
    const { actor, env, authority, create, append, targetInput } = fixture;
    const session = await create("sdk-history-contracts");
    await append(session, "off-path assistant");
    const scope = { ...targetInput(session), agentId: actor.agentId, storePath: actor.path, env };
    await withIncognitoSessionActor(actor, async () => {
      const original = await readSessionTranscriptVisibleMessageDelta(scope);
      assert(original.kind === "page");
      const changed = await actor.sessions.transcript(authority, {
        type: "session.message.append",
        input: {
          ...targetInput(session),
          fence: { expectedLifecycleRevision: session.entry.lifecycleRevision },
          parentId: null,
          message: { role: "assistant", content: "current assistant", timestamp: 10_001 },
        },
      });
      assert(changed.ok);
      await reconcileSessionTranscriptIndexes({
        agentId: actor.agentId,
        path: actor.path,
        env,
      });
      const appended = await actor.sessions.transcript(authority, {
        type: "session.message.append",
        input: {
          ...targetInput(session),
          fence: { expectedLifecycleRevision: session.entry.lifecycleRevision },
          message: { role: "user", content: "newest user", timestamp: 10_002 },
        },
      });
      assert(appended.ok);
      expect(await readLatestAssistantTextByIdentity(scope)).toMatchObject({
        text: "current assistant",
      });
      expect(await readLatestAssistantTextFromSessionTranscript(scope)).toMatchObject({
        text: "current assistant",
      });
      expect(
        (await prepareSessionTranscriptHydration(scope).readLatestActiveMessage())?.event,
      ).toMatchObject({ message: { role: "user" } });
      expect(await readRecentUserAssistantTextForSession({ ...scope, limit: 2 })).toMatchObject([
        { role: "assistant", text: "current assistant", timestamp: 10_001 },
        { role: "user", text: "newest user", timestamp: 10_002 },
      ]);
      const raw = await readSessionTranscriptRawDelta(scope);
      assert(raw.kind === "page");
      expect(JSON.stringify(raw.events)).toContain("off-path assistant");
      const reset = await readSessionTranscriptVisibleMessageDelta({
        ...scope,
        cursor: original.cursor,
      });
      expect(reset).toMatchObject({ kind: "reset" });
      assert(reset.kind === "reset");
      const bounded = await readSessionTranscriptVisibleMessageDelta({
        ...scope,
        cursor: reset.cursor,
        maxBytes: 1,
        maxMessages: 1,
      });
      assert(bounded.kind === "page");
      expect(bounded.entries).toEqual([]);
      expect(bounded.requiredBytes).toBeGreaterThan(1);
      const first = await readSessionTranscriptVisibleMessageDelta({
        ...scope,
        cursor: bounded.cursor,
        maxBytes: bounded.requiredBytes,
        maxMessages: 1,
      });
      assert(first.kind === "page");
      expect(first.entries).toMatchObject([{ message: { content: "current assistant" } }]);
      expect(first.hasMore).toBe(true);
      const last = await readSessionTranscriptVisibleMessageDelta({
        ...scope,
        cursor: first.cursor,
        maxMessages: 1,
      });
      assert(last.kind === "page");
      expect(last.entries).toMatchObject([{ message: { content: "newest user" } }]);
      expect(last.hasMore).toBe(false);
      expect(await prepareSessionEntryPresenceRead(scope).read()).toBe(true);
    });
  });

  it("returns canonical empty reads only for explicitly selected private absence and fences its consumer", async () => {
    const { env, authority } = fixture;
    const scope = {
      agentId: "absent-history",
      sessionId: "absent",
      sessionKey: "agent:absent-history:dashboard:incognito-absent",
      storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "absent-history", env }),
      env,
    };
    const missing = { kind: "absent" as const, agentId: scope.agentId, env, authority };
    await withIncognitoSessionBinding(missing, async () => {
      expect(await readSessionTranscriptEvents(scope)).toEqual([]);
      expect(await readSessionTranscriptRawDelta(scope)).toEqual({ kind: "missing" });
      expect(await readSessionTranscriptVisibleMessageDelta(scope)).toEqual({ kind: "missing" });
      expect(await readLatestAssistantTextByIdentity(scope)).toBeUndefined();
      expect(await readRecentUserAssistantTextForSession(scope)).toEqual([]);
      expect(await prepareSessionEntryPresenceRead(scope).read()).toBe(false);
      expect(await readTranscriptStatsAsync(scope)).toEqual({
        eventCount: 0,
        maxSeq: 0,
        sizeBytes: 0,
      });
      expect(await readSessionTranscriptWatermarkAsync(scope)).toEqual({
        generation: null,
        maxSeq: null,
      });
      expect(
        await readSessionTranscriptModelContextAsync(scope, (context) => context.events),
      ).toEqual([]);
    });
    expect(
      captureOpenClawAgentDatabaseExecution
        .listIncognito(env)
        .some((owner) => owner.agentId === scope.agentId),
    ).toBe(false);
    let current = true;
    await expect(
      withIncognitoSessionBinding(
        {
          ...missing,
          authority: {
            assertCurrent() {
              if (!current) {
                throw new Error("absence revoked");
              }
            },
          },
        },
        () =>
          withSessionTranscriptDeltaReader(scope, async (reader) => {
            expect(await reader.raw({})).toEqual({ kind: "missing" });
            current = false;
          }),
      ),
    ).rejects.toThrow("absence revoked");
  });
}
