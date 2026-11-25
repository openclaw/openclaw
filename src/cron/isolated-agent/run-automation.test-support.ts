import { vi } from "vitest";

const readCronScratchSnapshotMock = vi.fn();
export const readSessionMessagesAsyncMock = vi.fn();
// mock-isolation: Use the bounded conversation fixture instead of reading live transcripts.
vi.mock("../../gateway/session-transcript-readers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../gateway/session-transcript-readers.js")>()),
  readSessionMessagesAsync: readSessionMessagesAsyncMock,
}));
// mock-isolation: Use fixture scratch snapshots instead of opening the shared-state database worker.
vi.mock("../scratch-read.js", () => ({ readCronScratchSnapshot: readCronScratchSnapshotMock }));
// mock-isolation: Use synthetic target generations instead of capturing live sessions or admitting follow-up turns.
vi.mock("../../auto-reply/reply/session-event-target.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../auto-reply/reply/session-event-target.js")>()),
  captureSessionEventTargetForHost: vi.fn(async (agentId: string, sessionKey: string) => ({
    agentId,
    sessionKey,
    sessionId: "test-session-id",
    storePath: "/tmp/store.json",
    generation: "test",
  })),
  assertSessionEventTargetCurrent: vi.fn(),
  prepareSessionEventTargetForHost: vi.fn(async () => ({
    assertCurrent: vi.fn(),
    release: vi.fn(),
  })),
}));

export function resetCronAutomationMocks() {
  readCronScratchSnapshotMock.mockReset().mockResolvedValue(undefined);
  readSessionMessagesAsyncMock.mockReset().mockResolvedValue([]);
}
