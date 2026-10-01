import path from "node:path";
import { expect, onTestFinished } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";

let fallbackStorePath: string | undefined;

function getFallbackStorePath(): string {
  if (!fallbackStorePath) {
    // Recorders in one test share an identity; release it after the teardown hooks drain.
    const dirs = useAutoCleanupTempDirTracker((cleanup) =>
      onTestFinished(() => {
        fallbackStorePath = undefined;
        cleanup();
      }),
    );
    fallbackStorePath = path.join(dirs.make("openclaw-agent-user-turn-"), "sessions.json");
  }
  return fallbackStorePath;
}

export function createAgentTestUserTurnRecorder(
  createRecorder: typeof createUserTurnTranscriptRecorder,
  params: Parameters<typeof createUserTurnTranscriptRecorder>[0],
  storePath?: string,
) {
  const target = params.target;
  return createRecorder({
    ...params,
    // Assert the fixture's physical locator before the real runtime target reader uses it.
    target: storePath
      ? async () => {
          const resolved = typeof target === "function" ? await target() : target;
          if (resolved) {
            expect(resolved.storePath).toBe(storePath);
          }
          return resolved;
        }
      : {
          sessionId: "test-session-id",
          expectedSessionId: "test-session-id",
          sessionKey: "agent:main:main",
          sessionEntry: { sessionId: "test-session-id", updatedAt: Date.now() },
          storePath: getFallbackStorePath(),
          agentId: "main",
        },
  });
}
