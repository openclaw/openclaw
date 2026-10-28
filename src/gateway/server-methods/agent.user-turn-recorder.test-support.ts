import path from "node:path";
import { afterAll, expect, onTestFinished } from "vitest";
import type { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-agent-handler-");
let fallbackStorePath: string | undefined;

export function getAgentTestStorePath(): string {
  if (!fallbackStorePath) {
    // Cases share one locator until teardown; the suite retires database workers before removal.
    fallbackStorePath = path.join(sessionDirs.make(), "sessions.json");
    onTestFinished(() => {
      fallbackStorePath = undefined;
    });
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
          storePath: getAgentTestStorePath(),
          agentId: "main",
        },
  });
}
