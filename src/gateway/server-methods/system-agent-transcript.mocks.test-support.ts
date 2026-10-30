import { vi } from "vitest";

const transcriptStoreMocks = vi.hoisted(() => ({
  appendReset: vi.fn(),
  appendTurn: vi.fn(),
  readTranscriptTailAsync: vi
    .fn<typeof import("../../system-agent/transcript-store.js").readTranscriptTailAsync>()
    .mockResolvedValue([]),
}));

// mock-isolation: Policy and lifecycle suites keep audit persistence local; audit-worker tests own durable proof.
vi.mock("../../system-agent/transcript-store.js", () => ({
  createSystemAgentTranscriptStore: () => ({
    assertCurrent: () => undefined,
    appendTurn: transcriptStoreMocks.appendTurn,
    appendReset: transcriptStoreMocks.appendReset,
    readTail: (limit: number, afterLastReset = false) =>
      afterLastReset
        ? transcriptStoreMocks.readTranscriptTailAsync(limit, { afterLastReset })
        : transcriptStoreMocks.readTranscriptTailAsync(limit),
  }),
  readTranscriptTailAsync: transcriptStoreMocks.readTranscriptTailAsync,
}));

export { transcriptStoreMocks };
