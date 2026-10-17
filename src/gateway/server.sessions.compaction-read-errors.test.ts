import { beforeEach, expect, test, vi } from "vitest";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
// Install the mocked readers before the Gateway loads its accessor graph.
import "../config/sessions/session-transcript-hydration.js";
import "../config/sessions/session-transcript-stats.js";
import * as settlementOwner from "./server-methods/session-run-settlement.js";
import { embeddedRunMock, rpcReq } from "./test-helpers.js";
import {
  sessionStoreEntry,
  setupGatewaySessionsTestHarness,
} from "./test/server-sessions.test-helpers.js";
// Load after the fixture mocks, during collection rather than the first RPC deadline.
import "./server-methods/sessions-compact.js";

vi.hoisted(() => {
  // Earlier Gateway suites may have already loaded the unmocked accessor graph.
  vi.resetModules();
});

type PrepareTranscriptHydration =
  (typeof import("../config/sessions/session-transcript-hydration.js"))["prepareSessionTranscriptHydration"];

type ReadTranscriptStats =
  (typeof import("../config/sessions/session-transcript-stats.js"))["readTranscriptStatsAsync"];

const transcriptReads = vi.hoisted(() => ({
  hydration: vi.fn<PrepareTranscriptHydration>(),
  stats: vi.fn<ReadTranscriptStats>(),
}));

vi.mock("../config/sessions/session-transcript-hydration.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../config/sessions/session-transcript-hydration.js")>();
  return {
    ...actual,
    prepareSessionTranscriptHydration: transcriptReads.hydration,
  };
});

vi.mock("../config/sessions/session-transcript-stats.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../config/sessions/session-transcript-stats.js")>();
  return {
    ...actual,
    readTranscriptStatsAsync: transcriptReads.stats,
  };
});

const { createSessionStoreDir, openClient } = setupGatewaySessionsTestHarness();

let realPrepareTranscriptHydration: PrepareTranscriptHydration;
let realTranscriptStatsReader: ReadTranscriptStats;

beforeEach(async () => {
  transcriptReads.hydration.mockReset();
  transcriptReads.stats.mockReset();
  const [hydration, stats] = await Promise.all([
    vi.importActual<typeof import("../config/sessions/session-transcript-hydration.js")>(
      "../config/sessions/session-transcript-hydration.js",
    ),
    vi.importActual<typeof import("../config/sessions/session-transcript-stats.js")>(
      "../config/sessions/session-transcript-stats.js",
    ),
  ]);
  realPrepareTranscriptHydration = hydration.prepareSessionTranscriptHydration;
  realTranscriptStatsReader = stats.readTranscriptStatsAsync;
  transcriptReads.hydration.mockImplementation(realPrepareTranscriptHydration);
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
function failTranscriptReadForSession(sessionId: string, reader: "hydration" | "stats"): void {
  if (reader === "hydration") {
    transcriptReads.hydration.mockImplementation((...params) => {
      const prepared = realPrepareTranscriptHydration(...params);
      return {
        ...prepared,
        read: async (options) => {
          if (params[0].sessionId === sessionId && options?.compaction) {
            throw transcriptReadError();
          }
          return prepared.read(options);
        },
      };
    });
  } else {
    transcriptReads.stats.mockImplementation(async (scope) => {
      if (scope.sessionId !== sessionId) {
        return realTranscriptStatsReader(scope);
      }
      throw transcriptReadError();
    });
  }
}

test.each([
  { stage: "legacy preflight", sessionId: "sess-read-failure", reader: "hydration" as const },
  {
    stage: "native preflight",
    sessionId: "sess-native-read-failure",
    reader: "stats" as const,
    nativeHarness: true,
  },
  {
    stage: "maxLines preflight",
    sessionId: "sess-max-lines-read-failure",
    reader: "stats" as const,
    maxLines: 50,
  },
])(
  "sessions.compact reports $stage transcript read failures as unavailable",
  async ({ sessionId, maxLines, nativeHarness, reader }) => {
    const { storePath } = await createSessionStoreDir();
    await seedCompactionSession({ sessionId, storePath, nativeHarness });
    failTranscriptReadForSession(sessionId, reader);

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

test.each([false, true])(
  "sessions.compact keeps an empty transcript as a successful no-op (native harness: %s)",
  async (nativeHarness) => {
    const { storePath } = await createSessionStoreDir();
    await seedCompactionSession({
      sessionId: "sess-empty-model",
      storePath,
      withTranscript: false,
      nativeHarness,
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
  },
);

test.each([undefined, 2])(
  "sessions.compact rejects a missing session with maxLines=%s",
  async (maxLines) => {
    await createSessionStoreDir();
    const { ws } = await openClient();
    try {
      const response = await rpcReq(ws, "sessions.compact", {
        key: "agent:main:missing",
        ...(maxLines === undefined ? {} : { maxLines }),
      });

      expect(response.ok).toBe(false);
      expect(response.error).toMatchObject({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("Session agent:main:missing not found"),
      });
    } finally {
      ws.close();
    }
  },
);

test.each([false, true])(
  "sessions.compact reads settled facts (native harness: %s)",
  async (nativeHarness) => {
    const { storePath } = await createSessionStoreDir();
    const scope = await seedCompactionSession({
      sessionId: "sess-compact-settled",
      storePath,
      nativeHarness,
      withTranscript: false,
    });
    const settle = settlementOwner.waitForTerminalSessionRunSettlement;
    const settlement = vi
      .spyOn(settlementOwner, "waitForTerminalSessionRunSettlement")
      .mockImplementationOnce(async (params) => {
        const settled = await settle(params);
        await upsertSessionEntryCore(scope, {
          ...loadSessionEntry({ ...scope, readConsistency: "latest" }),
          sessionId: scope.sessionId,
          updatedAt: 2,
          spawnedCwd: "/tmp/after-settlement",
        });
        await appendTranscriptMessage(scope, {
          message: { role: "user", content: "first settled message", timestamp: 1 },
        });
        await appendTranscriptMessage(scope, {
          message: { role: "user", content: "final settled message", timestamp: 2 },
        });
        return settled;
      });
    embeddedRunMock.compactEmbeddedAgentSession.mockResolvedValueOnce({
      ok: true,
      compacted: true,
    });
    const { ws } = await openClient();
    try {
      expect(await rpcReq(ws, "sessions.compact", { key: "main" })).toMatchObject({
        ok: true,
        payload: { key: "agent:main:main", compacted: true },
      });
      expect(embeddedRunMock.compactEmbeddedAgentSession).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: "/tmp/after-settlement",
          sessionEntry: expect.objectContaining({ spawnedCwd: "/tmp/after-settlement" }),
        }),
        expect.anything(),
      );
    } finally {
      settlement.mockRestore();
      ws.close();
    }
  },
);
