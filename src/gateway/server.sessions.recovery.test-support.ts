import { writeSessionStore } from "./test-helpers.js";
import { seedSessionTranscript, sessionStoreEntry } from "./test/server-sessions.test-helpers.js";

export async function seedExhaustedRecovery(
  target: { sessionKey: string; sessionId: string; storePath: string },
  createdActor?: ReturnType<typeof sessionStoreEntry>["createdActor"],
) {
  const { sessionKey, sessionId } = target;
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry(sessionId, {
        status: "failed",
        abortedLastRun: true,
        mainRestartRecovery: {
          cycleId: `cycle-${sessionId}`,
          revision: 1,
          chargedAttempts: 3,
          tombstone: { reason: "automatic recovery exhausted" },
        },
        ...(createdActor ? { createdActor } : {}),
      }),
    },
  });
  await seedSessionTranscript({
    agentId: "main",
    ...target,
    messages: [{ role: "user", content: "finish the interrupted work" }],
  });
}
