import type { vi } from "vitest";

type ViLike = Pick<typeof vi, "fn">;

export function createExportCommandSessionMocks(viInstance: ViLike) {
  return {
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
