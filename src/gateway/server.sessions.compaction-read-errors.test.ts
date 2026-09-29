import { beforeEach, expect, test, vi } from "vitest";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
// Install the mocked reader before the Gateway loads its accessor graph.
import "../config/sessions/session-accessor.sqlite-read.js";
import { rpcReq } from "./test-helpers.js";
import {
  sessionStoreEntry,
  setupGatewaySessionsTestHarness,
} from "./test/server-sessions.test-helpers.js";

vi.hoisted(() => {
  // Earlier Gateway suites may have already loaded the unmocked accessor graph.
  vi.resetModules();
});

type ReadTranscriptStatsSync =
  (typeof import("../config/sessions/session-accessor.sqlite-read.js"))["readTranscriptStatsSync"];

const transcriptReads = vi.hoisted(() => ({
  stats: vi.fn<ReadTranscriptStatsSync>(),
}));

vi.mock("../config/sessions/session-accessor.sqlite-read.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../config/sessions/session-accessor.sqlite-read.js")>();
  return {
    ...actual,
    readTranscriptStatsSync: transcriptReads.stats,
  };
});

const { createSessionStoreDir, openClient } = setupGatewaySessionsTestHarness();

let realTranscriptStatsReader: ReadTranscriptStatsSync;

beforeEach(async () => {
  transcriptReads.stats.mockReset();
  const actual = await vi.importActual<
    typeof import("../config/sessions/session-accessor.sqlite-read.js")
  >("../config/sessions/session-accessor.sqlite-read.js");
  realTranscriptStatsReader = actual.readTranscriptStatsSync;
  transcriptReads.stats.mockImplementation(realTranscriptStatsReader);
});

async function seedCompactionSession(params: {
  sessionId: string;
  storePath: string;
  nativeHarness?: boolean;
  withTranscript?: boolean;
}) {
  const scope = {
    agentId: "main",
    sessionId: params.sessionId,
    sessionKey: "agent:main:main",
    storePath: params.storePath,
  };
  await upsertSessionEntryCore(
    scope,
    sessionStoreEntry(
      params.sessionId,
      params.nativeHarness
        ? {
            agentHarnessId: "codex",
            cliSessionBindings: { "codex-cli": { sessionId: "thread-1" } },
            cliSessionIds: { "codex-cli": "thread-1" },
            modelSelectionLocked: true,
          }
        : {},
    ),
  );
  if (params.withTranscript === false) {
    return scope;
  }
  await appendTranscriptEvent(scope, {
    type: "session",
    version: 3,
    id: params.sessionId,
    timestamp: "2026-08-18T12:00:00.000Z",
    cwd: "/tmp",
  });
  await appendTranscriptMessage(scope, {
    message: { role: "user", content: "compact me", timestamp: 1 },
    now: Date.parse("2026-08-18T12:00:01.000Z"),
  });
  return scope;
}

const transcriptReadError = () =>
  new Error("SQLITE_IOERR: failed to read session transcript storage");

// Background reads must not consume the failure intended for the compaction RPC.
function failTranscriptStatsForSession(
  sessionId: string,
  options?: { succeedFirstWith: ReturnType<ReadTranscriptStatsSync> },
): void {
  let sessionReads = 0;
  transcriptReads.stats.mockImplementation((scope) => {
    if (scope.sessionId !== sessionId) {
      return realTranscriptStatsReader(scope);
    }
    sessionReads += 1;
    if (options && sessionReads === 1) {
      return options.succeedFirstWith;
    }
    throw transcriptReadError();
  });
}

test.each([
  { stage: "initial", sessionId: "sess-read-failure" },
  {
    stage: "model compaction re-read",
    sessionId: "sess-model-read-failure",
    nativeHarness: true,
  },
  { stage: "maxLines preflight", sessionId: "sess-max-lines-read-failure", maxLines: 50 },
])(
  "sessions.compact reports $stage transcript read failures as unavailable",
  async ({ sessionId, nativeHarness, maxLines }) => {
    const { storePath } = await createSessionStoreDir();
    const scope = await seedCompactionSession({ sessionId, storePath, nativeHarness });
    failTranscriptStatsForSession(
      sessionId,
      nativeHarness ? { succeedFirstWith: realTranscriptStatsReader(scope) } : undefined,
    );

    const { ws } = await openClient();
    try {
      const response = await rpcReq(ws, "sessions.compact", {
        key: "main",
        ...(maxLines === undefined ? {} : { maxLines }),
      });

      expect(response.ok).toBe(false);
      expect(response.error).toMatchObject({
        code: "UNAVAILABLE",
        message: expect.stringContaining("failed to read session transcript storage"),
      });
    } finally {
      ws.close();
    }
  },
);

test("sessions.compact keeps an empty transcript as a successful no-op", async () => {
  const { storePath } = await createSessionStoreDir();
  await seedCompactionSession({
    sessionId: "sess-empty-model",
    storePath,
    withTranscript: false,
  });

  const { ws } = await openClient();
  try {
    const response = await rpcReq<{ compacted: boolean; ok: true; reason: string }>(
      ws,
      "sessions.compact",
      { key: "main" },
    );

    expect(response.ok).toBe(true);
    expect(response.payload).toMatchObject({
      ok: true,
      compacted: false,
      reason: "no transcript",
    });
  } finally {
    ws.close();
  }
});
