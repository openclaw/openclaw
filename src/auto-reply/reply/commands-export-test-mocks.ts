import type { vi } from "vitest";

type ViLike = Pick<typeof vi, "fn">;

export function createExportCommandSessionMocks(viInstance: ViLike) {
  return {
    createSqliteSessionTranscriptLocatorMock: viInstance.fn(
      ({ agentId, sessionId }: { agentId?: string; sessionId: string }) =>
        `sqlite-transcript://${agentId ?? "main"}/${sessionId}.jsonl`,
    ),
    resolveSessionFilePathMock: viInstance.fn(() => "/tmp/target-store/session.jsonl"),
    resolveSessionFilePathOptionsMock: viInstance.fn(
      (params: { agentId: string; storePath: string }) => params,
    ),
    sessionRowsMock: viInstance.fn(
      (): Record<string, { sessionId: string; updatedAt: number }> => ({
        "agent:target:session": {
          sessionId: "session-1",
          updatedAt: 1,
        },
      }),
    ),
  };
}
