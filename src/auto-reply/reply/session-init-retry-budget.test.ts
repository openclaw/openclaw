import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  commitReplySessionInitialization,
  loadReplySessionInitializationSnapshot,
  upsertSessionEntry,
} from "../../config/sessions/session-accessor.js";

async function initSessionWithBudget(params: {
  sessionKey: string;
  storePath: string;
  maxAttempts: number;
  onSnapshot?: (attempt: number) => Promise<void> | void;
}): Promise<{ attempts: number }> {
  const { sessionKey, storePath, maxAttempts, onSnapshot } = params;
  for (let attempt = 0; ; attempt += 1) {
    const snapshot = loadReplySessionInitializationSnapshot({ sessionKey, storePath });
    if (onSnapshot) {
      await onSnapshot(attempt);
    }
    const committed = await commitReplySessionInitialization({
      activeSessionKey: sessionKey,
      agentId: "main",
      expectedRevision: snapshot.revision,
      sessionEntry: {
        sessionId: `turn-${attempt}`,
        updatedAt: Date.now(),
      },
      sessionKey,
      storePath,
    });
    if (committed.ok) {
      return { attempts: attempt + 1 };
    }
    if (attempt + 1 >= maxAttempts) {
      throw new Error(`reply session initialization conflicted for ${sessionKey}`);
    }
  }
}

describe("reply session init retry budget under a revision-conflict burst", () => {
  let tempDir: string;
  let storePath: string;
  const sessionKey = "agent:main:main";

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-retry-budget-"));
    storePath = path.join(tempDir, "sessions.json");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("old budget (2 attempts) throws under a 3-writer burst", async () => {
    await upsertSessionEntry({ sessionKey, storePath }, { sessionId: "seed", updatedAt: 1 });
    let externalWriterCalls = 0;

    await expect(
      initSessionWithBudget({
        sessionKey,
        storePath,
        maxAttempts: 2,
        onSnapshot: async (attempt) => {
          if (attempt < 3) {
            externalWriterCalls += 1;
            await upsertSessionEntry(
              { sessionKey, storePath },
              { sessionId: `external-writer-${attempt}`, updatedAt: 100 + attempt },
            );
          }
        },
      }),
    ).rejects.toThrow(`reply session initialization conflicted for ${sessionKey}`);

    expect(externalWriterCalls).toBe(2);
  });

  it("new budget (4 attempts) succeeds under the identical 3-writer burst", async () => {
    await upsertSessionEntry({ sessionKey, storePath }, { sessionId: "seed", updatedAt: 1 });
    let externalWriterCalls = 0;

    const result = await initSessionWithBudget({
      sessionKey,
      storePath,
      maxAttempts: 4,
      onSnapshot: async (attempt) => {
        if (attempt < 3) {
          externalWriterCalls += 1;
          await upsertSessionEntry(
            { sessionKey, storePath },
            { sessionId: `external-writer-${attempt}`, updatedAt: 100 + attempt },
          );
        }
      },
    });

    expect(externalWriterCalls).toBe(3);
    expect(result.attempts).toBe(4);
  });
});
