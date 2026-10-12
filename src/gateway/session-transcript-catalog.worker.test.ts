import type { StatementSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { replaceSessionEntry } from "../config/sessions/session-accessor.sqlite-entry.js";
import { appendTranscriptMessage } from "../config/sessions/session-accessor.sqlite-transcript-write.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { waitForSessionTranscriptProjection } from "../config/sessions/session-transcript-reconcile.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as catalog from "./session-transcript-catalog.js";

it("reads catalog titles and cursor pages in workers and observes later transcript writes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const target = {
      agentId: "main",
      sessionId: "catalog-worker",
      sessionKey: "agent:main:catalog-worker",
      storePath: state.statePath("catalog.sqlite"),
    };
    const entry = { sessionId: target.sessionId, updatedAt: 1 };
    await replaceSessionEntry(target, entry);
    await replaceTranscriptEvents(target, [
      { type: "session", version: 3, id: target.sessionId },
      {
        type: "message",
        id: "question",
        parentId: null,
        message: { role: "user", content: "Plan the migration" },
      },
      {
        type: "message",
        id: "answer",
        parentId: "question",
        message: { role: "assistant", content: "Start with the history reader" },
      },
    ]);
    await waitForSessionTranscriptProjection(target);
    const { db } = openOpenClawAgentDatabase({ agentId: target.agentId, path: target.storePath });
    const prototype: StatementSync = Object.getPrototypeOf(db.prepare("SELECT 1"));
    const reads: string[] = [];
    const observers = (["all", "get", "iterate", "run"] as const).map((method) => {
      const original = prototype[method];
      return vi.spyOn(prototype, method).mockImplementation(
        new Proxy(original, {
          apply(read, receiver: StatementSync, args) {
            if (
              /\b(?:transcript_events|session_transcript_active_events|transcript_event_identities)\b/iu.test(
                receiver.sourceSQL,
              )
            ) {
              reads.push(receiver.sourceSQL);
            }
            return Reflect.apply(read, receiver, args);
          },
        }),
      );
    });
    const params = { ...target, limit: 1, sourceDomain: "catalog-test", pluginId: "session-share" };
    try {
      const first = await catalog.readSessionTranscriptCatalogPage(params);
      expect(first.items.map((item) => item.text)).toEqual(["Start with the history reader"]);
      expect(first.nextCursor).toBeDefined();
      expect(reads).toEqual([]);
      expect(await catalog.readSessionTranscriptCatalogTitleAsync({ ...target, entry })).toBe(
        "Plan the migration",
      );
      expect(reads).toEqual([]);

      await appendTranscriptMessage(target, {
        eventId: "later-answer",
        parentId: "answer",
        message: { role: "assistant", content: "The worker now owns the read" },
      });
      await waitForSessionTranscriptProjection(target);
      reads.length = 0;
      const resumed = await catalog.readSessionTranscriptCatalogPage({
        ...params,
        cursor: first.nextCursor,
      });
      expect(resumed.items.map((item) => item.text)).toEqual(["Plan the migration"]);
      const latest = await catalog.readSessionTranscriptCatalogPage(params);
      expect(latest.items.map((item) => item.text)).toEqual(["The worker now owns the read"]);
      expect(reads).toEqual([]);
    } finally {
      observers.forEach((observer) => observer.mockRestore());
    }
  });
});
