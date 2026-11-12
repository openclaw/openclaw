import path from "node:path";
import { expect, it } from "vitest";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { withSessionCleanupStore } from "./cleanup-service-read.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { appendTranscriptMessageSync } from "./session-accessor.sqlite-transcript-write.js";
import {
  appendTranscriptEventSync,
  replaceTranscriptEventsSync,
} from "./session-accessor.sqlite-transcript-write.test-support.js";
import { streamSessionEntriesInWorker } from "./session-transcript-read-worker-runtime.js";

const body = "synthetic detail ".repeat(262_144);

it("exports every medium transcript through the production 512 MiB worker", async () => {
  await withOpenClawTestState({ label: "memory-export-working-set" }, async (state) => {
    const requests = Array.from({ length: 72 }, (_, index) => ({
      absPath: "agent:main:chat:medium-" + index,
      options: {
        agentId: "main",
        sessionId: "medium-" + index,
        sessionKey: "agent:main:chat:medium-" + index,
        storePath: path.join(state.sessionsDir(), "sessions.json"),
      },
    }));
    for (const [index, { options }] of requests.entries()) {
      replaceSessionEntrySync(options, { sessionId: options.sessionId, updatedAt: 1 });
      expect(
        replaceTranscriptEventsSync(options, [
          {
            type: "message",
            id: "fixture",
            message: { role: "user", content: "HEAD_" + index + " " + body + " TAIL_" + index },
          },
        ]),
      ).toBe(true);
    }
    // The previous worker retained all projected sources plus all rendered results and OOMed.
    const counts = requests.map(() => ({ words: 0, first: "", last: "" }));
    const results = await streamSessionEntriesInWorker(
      requests.map((request) => ({ ...request, pages: true, messages: false })),
      async (index, update) => {
        const count = counts[index]!;
        if ("reset" in update) {
          Object.assign(count, { words: 0, first: "", last: "" });
        } else if ("page" in update) {
          for (const line of update.page.lines) {
            count.first ||= line.slice(0, 64);
            count.last = line.slice(-64);
            count.words += [...line.matchAll(/\b(?:synthetic|detail)\b/g)].length;
          }
        }
      },
    );
    expect(results).toHaveLength(requests.length);
    for (const [index, count] of counts.entries()) {
      const result = results[index]!;
      expect("cold" in result).toBe(false);
      if ("summary" in result) {
        expect(result.summary).not.toBeNull();
      }
      expect(count.first.startsWith("User: HEAD_" + index + " ")).toBe(true);
      expect(count.last.endsWith(" TAIL_" + index)).toBe(true);
      expect(count.words).toBe(262_144 * 2);
    }
  });
}, 30_000);

it("classifies a message-bearing large transcript without retaining its complete raw history", async () => {
  await withOpenClawTestState({ label: "cleanup-working-set" }, async (state) => {
    const options = {
      agentId: "main",
      sessionId: "large-cleanup",
      sessionKey: "agent:main:chat:large-cleanup",
      storePath: path.join(state.sessionsDir(), "sessions.json"),
    };
    replaceSessionEntrySync(options, { sessionId: options.sessionId, updatedAt: 1 });
    for (let index = 0; index < 72; index++) {
      appendTranscriptEventSync(options, { type: "fixture", id: "noise-" + index, body });
    }
    expect(
      appendTranscriptMessageSync(options, {
        eventId: "tail-marker",
        message: { role: "user", content: "Keep this conversation." },
      }),
    ).toMatchObject({ ok: true });
    const snapshot = await withSessionCleanupStore(
      { agentId: "main", storePath: options.storePath },
      (owner) => owner.read(true),
    );
    expect(snapshot.missing).toEqual([]);
    expect(snapshot.store[options.sessionKey]?.sessionId).toBe(options.sessionId);
  });
}, 30_000);
