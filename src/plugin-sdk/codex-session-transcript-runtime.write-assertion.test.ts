import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  SessionTranscriptWriterClaimReboundError,
  withSessionTranscriptWriteAssertion,
} from "../config/sessions/transcript-write-context.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { withCodexSessionTranscriptMirrorWrite } from "./codex-session-transcript-runtime.js";
import { upsertSessionEntry } from "./session-store-runtime.js";
import { readSessionTranscriptEvents } from "./session-transcript-runtime.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-sdk-mirror-assertion-");

// Mirrors the Codex settled-turn finalizer: the locator names the session by key and
// leaves agentId for the transcript owner to resolve.
async function createUnresolvedTarget(sessionId = "session-1") {
  const storePath = path.join(sessionDirs.make(), "sessions.json");
  const sessionKey = `agent:main:${sessionId}`;
  await upsertSessionEntry({ sessionKey, storePath, entry: { sessionId, updatedAt: 1 } });
  return { sessionId, sessionKey, storePath };
}

function appendAssistant(text: string) {
  return {
    message: {
      role: "assistant" as const,
      content: [{ type: "text" as const, text }],
      timestamp: 1,
    },
    idempotencyLookup: "scan" as const,
  };
}

async function readTexts(target: Awaited<ReturnType<typeof createUnresolvedTarget>>) {
  const events = await readSessionTranscriptEvents({ ...target, agentId: "main" });
  return JSON.stringify(events).match(/"text":"[^"]*"/g) ?? [];
}

describe("Codex mirror write assertion", () => {
  it("binds the assertion to the resolved target so an omitted agentId still persists", async () => {
    const target = await createUnresolvedTarget();
    await withCodexSessionTranscriptMirrorWrite(
      { ...target, assertCurrent: () => {} },
      (transcript) => transcript.appendMessageWithMessageSequence(appendAssistant("settled")),
    );
    expect(await readTexts(target)).toEqual(['"text":"settled"']);
  });

  it("rejects authority revoked during awaited callback work before the row commits", async () => {
    const target = await createUnresolvedTarget();
    let revoked = false;
    await expect(
      withCodexSessionTranscriptMirrorWrite(
        {
          ...target,
          assertCurrent: () => {
            if (revoked) {
              throw new Error("mirror authority revoked");
            }
          },
        },
        async (transcript) => {
          await transcript.readMessageFacts({ idempotencyKeys: [] });
          revoked = true;
          return await transcript.appendMessageWithMessageSequence(appendAssistant("stale"));
        },
      ),
    ).rejects.toThrow("mirror authority revoked");
    expect(await readTexts(target)).toEqual([]);
  });

  it("rejects a foreign ambient transcript owner before reserving the writer", async () => {
    const target = await createUnresolvedTarget();
    const foreign = await createUnresolvedTarget("session-foreign");
    await expect(
      withSessionTranscriptWriteAssertion(
        { ...foreign, agentId: "main" },
        () => {},
        () =>
          withCodexSessionTranscriptMirrorWrite(
            { ...target, assertCurrent: () => {} },
            (transcript) => transcript.appendMessageWithMessageSequence(appendAssistant("foreign")),
          ),
      ),
    ).rejects.toBeInstanceOf(SessionTranscriptWriterClaimReboundError);
    expect(await readTexts(target)).toEqual([]);
  });
});
