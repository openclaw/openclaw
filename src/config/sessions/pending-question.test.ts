// Tests the durable pending-question breadcrumb and the restart expiry sweep:
// registering persists a breadcrumb, resolving/clearing removes it, and a
// gateway restart sweep emits question.expired for orphaned breadcrumbs so no
// surface silently hangs. Also covers back-compat (entries without the slot).
import { describe, expect, it, vi } from "vitest";
import {
  clearPendingQuestion,
  collectPendingQuestionBreadcrumbs,
  recordPendingQuestion,
  sweepPendingQuestions,
} from "./pending-question.js";
import { getSessionEntry, upsertSessionEntry } from "./store.js";
import { useTempSessionsFixture } from "./test-helpers.js";
import type { SessionEntry } from "./types.js";

describe("pending-question breadcrumb + restart sweep", () => {
  const fixture = useTempSessionsFixture("openclaw-pending-question-");
  const sessionKey = "agent:main:telegram:direct:123";

  async function seedSession(): Promise<void> {
    await upsertSessionEntry({
      storePath: fixture.storePath(),
      sessionKey,
      entry: { sessionId: "sess-1", updatedAt: 1, totalTokens: 0, totalTokensFresh: true },
    });
  }

  it("records and clears the breadcrumb on the session entry", async () => {
    await seedSession();
    await recordPendingQuestion(
      { sessionKey, storePath: fixture.storePath() },
      { id: "qrec-1", createdAt: 100, turnSourceChannel: "telegram" },
    );
    expect(
      getSessionEntry({ storePath: fixture.storePath(), sessionKey })?.pendingQuestion,
    ).toEqual({ schemaVersion: 1, id: "qrec-1", createdAt: 100, turnSourceChannel: "telegram" });

    await clearPendingQuestion({ sessionKey, storePath: fixture.storePath() }, "qrec-1");
    expect(
      getSessionEntry({ storePath: fixture.storePath(), sessionKey })?.pendingQuestion,
    ).toBeUndefined();
  });

  it("does not clear a newer breadcrumb when an older id is cleared", async () => {
    await seedSession();
    await recordPendingQuestion(
      { sessionKey, storePath: fixture.storePath() },
      { id: "new-id", createdAt: 200 },
    );
    await clearPendingQuestion({ sessionKey, storePath: fixture.storePath() }, "old-id");
    expect(
      getSessionEntry({ storePath: fixture.storePath(), sessionKey })?.pendingQuestion?.id,
    ).toBe("new-id");
  });

  it("collectPendingQuestionBreadcrumbs returns only entries carrying the slot", () => {
    const entries: Array<[string, SessionEntry]> = [
      ["s1", { pendingQuestion: { schemaVersion: 1, id: "a", createdAt: 1 } } as SessionEntry],
      ["s2", {} as SessionEntry],
    ];
    expect(collectPendingQuestionBreadcrumbs(entries)).toEqual([
      { sessionKey: "s1", pendingQuestion: { schemaVersion: 1, id: "a", createdAt: 1 } },
    ]);
  });

  it("RESTART SWEEP emits question.expired for an orphaned breadcrumb and clears it", async () => {
    await seedSession();
    await recordPendingQuestion(
      { sessionKey, storePath: fixture.storePath() },
      { id: "qrec-9", createdAt: 300, turnSourceChannel: "slack" },
    );

    const emitExpired = vi.fn();
    const swept = await sweepPendingQuestions({
      storePath: fixture.storePath(),
      emitExpired,
    });

    expect(swept).toBe(1);
    expect(emitExpired).toHaveBeenCalledWith({
      sessionKey,
      pendingQuestion: {
        schemaVersion: 1,
        id: "qrec-9",
        createdAt: 300,
        turnSourceChannel: "slack",
      },
    });
    // Breadcrumb cleared so a second restart does not re-expire it.
    expect(
      getSessionEntry({ storePath: fixture.storePath(), sessionKey })?.pendingQuestion,
    ).toBeUndefined();
  });

  it("sweep is a no-op for a session that never asked a question (back-compat)", async () => {
    await seedSession();
    const emitExpired = vi.fn();
    const swept = await sweepPendingQuestions({ storePath: fixture.storePath(), emitExpired });
    expect(swept).toBe(0);
    expect(emitExpired).not.toHaveBeenCalled();
  });
});
