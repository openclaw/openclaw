import assert from "node:assert/strict";
import path from "node:path";
import { expect, it } from "vitest";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { appendTranscriptMessageSync } from "./session-accessor.sqlite-transcript-write.js";
import { replaceTranscriptEventsSync } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { collectSessionMemoryEntries } from "./session-memory-entry.worker.test-support.js";

function userEvent(id: string, content: string) {
  return { type: "message", id, message: { role: "user", content } };
}

it.each([true, false])("resets a changed sliced export (rendered pages: %s)", async (pages) => {
  await withOpenClawTestState({ label: "session-memory-entry-restart" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionId: "restart",
      sessionKey: "agent:main:chat:restart",
      storePath: path.join(state.sessionsDir(), "sessions.json"),
    };
    replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    // Six 1 MB rows exceed snapshot retention and the 2 MiB slice budget.
    const rows = Array.from({ length: 6 }, (_, index) =>
      userEvent(`row-${index}`, `row${index} `.repeat(200_000)),
    );
    expect(replaceTranscriptEventsSync(scope, rows)).toBe(true);
    const updates: string[] = [];
    const observedMessages: string[] = [];
    let appended = false;
    const [exported] = await collectSessionMemoryEntries(
      [{ absPath: scope.sessionKey, options: scope, pages, messages: !pages }],
      undefined,
      (_index, update) => {
        updates.push("reset" in update ? "reset" : "page");
        if ("reset" in update) {
          observedMessages.length = 0;
        } else if (!pages) {
          expect(update.page.lines).toEqual([]);
          for (const { message } of update.page.messages ?? []) {
            assert(message && typeof message === "object" && "content" in message);
            assert(typeof message.content === "string");
            observedMessages.push(message.content.split(" ")[0]!);
          }
        }
        if (!appended) {
          appended = true;
          expect(
            appendTranscriptMessageSync(scope, {
              eventId: "concurrent",
              message: { role: "assistant", content: "Concurrent answer." },
            }),
          ).toMatchObject({ ok: true });
        }
      },
    );
    assert(exported && "entry" in exported && exported.entry, "Expected a hot export");
    // The restarted export reads the transcript current at its fresh head.
    expect(updates).toContain("reset");
    expect(updates.indexOf("reset")).toBeGreaterThan(0);
    if (pages) {
      expect(exported.entry.content.endsWith("\nAssistant: Concurrent answer.")).toBe(true);
      expect(exported.entry.content.startsWith("User: row0 row0")).toBe(true);
      expect(exported.entry.lineCount).toBe(exported.entry.content.split("\n").length);
    } else {
      expect(observedMessages).toEqual([
        "row0",
        "row1",
        "row2",
        "row3",
        "row4",
        "row5",
        "Concurrent",
      ]);
    }
  });
});

it("waits for an acknowledged entry before reading the next source", async () => {
  await withOpenClawTestState({ label: "session-memory-entry-backpressure" }, async (state) => {
    const requests = ["first", "second"].map((sessionId) => {
      const options = {
        agentId: "main",
        sessionId,
        sessionKey: "agent:main:chat:" + sessionId,
        storePath: path.join(state.sessionsDir(), "sessions.json"),
      };
      replaceSessionEntrySync(options, { sessionId, updatedAt: 1 });
      expect(replaceTranscriptEventsSync(options, [userEvent("initial", sessionId)])).toBe(true);
      return { absPath: options.sessionKey, options };
    });
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const pending = collectSessionMemoryEntries(requests, async (index) => {
      if (index === 0) {
        entered.resolve();
        await resume.promise;
      }
    });
    try {
      await Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error("Export completed before acknowledgement");
        }),
      ]);
      expect(
        appendTranscriptMessageSync(requests[1]!.options, {
          eventId: "after-ack",
          message: { role: "assistant", content: "Added while first blocked." },
        }),
      ).toMatchObject({ ok: true });
    } finally {
      resume.resolve();
    }
    const values = await pending;
    const second = values[1];
    assert(second && "entry" in second && second.entry);
    expect(second.entry.content).toContain("Added while first blocked.");
  });
});
