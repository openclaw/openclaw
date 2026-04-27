import path from "node:path";

type RawEntry = Record<string, unknown>;

type TranscriptFixtureFile = {
  filePath: string;
  entries: RawEntry[];
};

type CompactionCheckpointFixture = {
  sessionId: string;
  preCompaction: {
    sessionFile: string;
  };
};

export type Repro68765CompactionChainFixture = {
  sessionId: string;
  store: Record<string, unknown>;
  liveSessionFile: string;
  transcripts: TranscriptFixtureFile[];
  expectedTexts: string[];
  expectedMessageIds: string[];
  expectedLiveSegmentTexts: string[];
  expectedLiveSegmentMessageIds: string[];
};

// Production-derived fixture for PR #68765.
// Source shape: main-session checkpoint chain from a real compaction lineage.
// Redaction: user text, assistant text, timestamps, cwd, provider/model ids,
// and opaque ids are pseudonymized. The file/chain topology is preserved:
// two predecessor `preCompaction.sessionFile` segments plus the live segment.
export function createRepro68765CompactionChainFromProduction(
  rootDir: string,
): Repro68765CompactionChainFixture {
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const checkpoint1SessionId = "22222222-2222-4222-8222-222222222222";
  const checkpoint2SessionId = "33333333-3333-4333-8333-333333333333";
  const checkpoint1File = path.join(rootDir, `${sessionId}.checkpoint.01.redacted.jsonl`);
  const checkpoint2File = path.join(rootDir, `${sessionId}.checkpoint.02.redacted.jsonl`);
  const liveSessionFile = path.join(rootDir, `${sessionId}.jsonl`);

  const checkpointChain: CompactionCheckpointFixture[] = [
    {
      sessionId: checkpoint1SessionId,
      preCompaction: {
        sessionFile: checkpoint1File,
      },
    },
    {
      sessionId: checkpoint2SessionId,
      preCompaction: {
        sessionFile: checkpoint2File,
      },
    },
  ];

  const transcripts: TranscriptFixtureFile[] = [
    {
      filePath: checkpoint1File,
      entries: [
        {
          type: "session",
          version: 3,
          id: "session-root-1",
          timestamp: "2026-04-18T02:00:00.000Z",
          cwd: "REDACTED_WORKDIR",
        },
        {
          type: "message",
          id: "msg-segment-1-user",
          parentId: "session-root-1",
          timestamp: "2026-04-18T02:00:30.000Z",
          message: {
            role: "user",
            content: [{ type: "text", text: "[redacted chain segment 1 user]" }],
          },
        },
        {
          type: "message",
          id: "msg-segment-1-assistant",
          parentId: "msg-segment-1-user",
          timestamp: "2026-04-18T02:00:45.000Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "[redacted chain segment 1 assistant]" }],
          },
        },
      ],
    },
    {
      filePath: checkpoint2File,
      entries: [
        {
          type: "session",
          version: 3,
          id: "session-root-2",
          timestamp: "2026-04-18T03:10:00.000Z",
          cwd: "REDACTED_WORKDIR",
        },
        {
          type: "message",
          id: "msg-segment-2-user",
          parentId: "session-root-2",
          timestamp: "2026-04-18T03:10:30.000Z",
          message: {
            role: "user",
            content: [{ type: "text", text: "[redacted chain segment 2 user]" }],
          },
        },
        {
          type: "message",
          id: "msg-segment-2-assistant",
          parentId: "msg-segment-2-user",
          timestamp: "2026-04-18T03:10:45.000Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "[redacted chain segment 2 assistant]" }],
          },
        },
      ],
    },
    {
      filePath: liveSessionFile,
      entries: [
        {
          type: "session",
          version: 3,
          id: "session-root-live",
          timestamp: "2026-04-18T04:20:00.000Z",
          cwd: "REDACTED_WORKDIR",
        },
        {
          type: "message",
          id: "msg-live-user",
          parentId: "session-root-live",
          timestamp: "2026-04-18T04:20:30.000Z",
          message: {
            role: "user",
            content: [{ type: "text", text: "[redacted live segment user]" }],
          },
        },
        {
          type: "message",
          id: "msg-live-assistant",
          parentId: "msg-live-user",
          timestamp: "2026-04-18T04:20:45.000Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "[redacted live segment assistant]" }],
          },
        },
      ],
    },
  ];

  const expectedLiveSegmentTexts = [
    "[redacted live segment user]",
    "[redacted live segment assistant]",
  ];
  const expectedLiveSegmentMessageIds = ["msg-live-user", "msg-live-assistant"];

  return {
    sessionId,
    liveSessionFile,
    transcripts,
    store: {
      "agent:main:main": {
        sessionId,
        sessionFile: liveSessionFile,
        compactionCheckpoints: checkpointChain,
      },
    },
    expectedTexts: [
      "[redacted chain segment 1 user]",
      "[redacted chain segment 1 assistant]",
      "[redacted chain segment 2 user]",
      "[redacted chain segment 2 assistant]",
      ...expectedLiveSegmentTexts,
    ],
    expectedMessageIds: [
      "msg-segment-1-user",
      "msg-segment-1-assistant",
      "msg-segment-2-user",
      "msg-segment-2-assistant",
      ...expectedLiveSegmentMessageIds,
    ],
    expectedLiveSegmentTexts,
    expectedLiveSegmentMessageIds,
  };
}
