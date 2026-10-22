import { expectDefined } from "@openclaw/normalization-core/expect";
import { beforeEach, expect, test, vi } from "vitest";
import {
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
  transcriptReads.hydration.mockImplementation(actual.prepareSessionTranscriptHydration);
  return { ...actual, prepareSessionTranscriptHydration: transcriptReads.hydration };
});

vi.mock("../config/sessions/session-transcript-stats.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../config/sessions/session-transcript-stats.js")>();
  transcriptReads.stats.mockImplementation(actual.readTranscriptStatsAsync);
  return { ...actual, readTranscriptStatsAsync: transcriptReads.stats };
});

const { createSessionStoreDir, openClient } = setupGatewaySessionsTestHarness();

async function compact(key = "main", maxLines?: number) {
  const { ws } = await openClient();
  try {
    return await rpcReq(ws, "sessions.compact", {
      key,
      ...(maxLines === undefined ? {} : { maxLines }),
    });
  } finally {
    ws.close();
  }
}

const realHydration = expectDefined(transcriptReads.hydration.getMockImplementation(), "hydration");
const realStats = expectDefined(transcriptReads.stats.getMockImplementation(), "transcript stats");
beforeEach(() => {
  transcriptReads.hydration.mockReset().mockImplementation(realHydration);
  transcriptReads.stats.mockReset().mockImplementation(realStats);
});

async function seedCompactionSession(
  sessionId: string,
  nativeHarness = false,
  withTranscript = true,
) {
  const { storePath } = await createSessionStoreDir();
  const scope = { agentId: "main", sessionId, sessionKey: "agent:main:main", storePath };
  await upsertSessionEntryCore(
    scope,
    sessionStoreEntry(
      sessionId,
      nativeHarness
        ? {
            agentHarnessId: "codex",
            cliSessionBindings: { "codex-cli": { sessionId: "thread-1" } },
            cliSessionIds: { "codex-cli": "thread-1" },
            modelSelectionLocked: true,
          }
        : {},
    ),
  );
  if (!withTranscript) {
    return scope;
  }
  await appendTranscriptMessage(scope, {
    message: { role: "user", content: "compact me", timestamp: 1 },
  });
  return scope;
}

const transcriptReadError = () =>
  new Error("SQLITE_IOERR: failed to read session transcript storage");

// Background reads must not consume the failure intended for the compaction RPC.
function failTranscriptReadForSession(sessionId: string, reader: "hydration" | "stats"): void {
  if (reader === "hydration") {
    transcriptReads.hydration.mockImplementation((...params) => {
      const prepared = realHydration(...params);
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
        return realStats(scope);
      }
      throw transcriptReadError();
    });
  }
}

test.each(["legacy", "native", "maxLines"])(
  "sessions.compact reports %s preflight transcript read failures as unavailable",
  async (stage) => {
    const sessionId = `sess-${stage}-read-failure`;
    const maxLines = stage === "maxLines" ? 50 : undefined;
    await seedCompactionSession(sessionId, stage === "native");
    failTranscriptReadForSession(sessionId, stage === "legacy" ? "hydration" : "stats");
    expect(await compact("main", maxLines)).toMatchObject({
      ok: false,
      error: {
        code: "UNAVAILABLE",
        message: expect.stringContaining("failed to read session transcript storage"),
      },
    });
  },
);

test.each([false, true])(
  "sessions.compact keeps an empty transcript as a successful no-op (native harness: %s)",
  async (nativeHarness) => {
    await seedCompactionSession("sess-empty-model", nativeHarness, false);

    expect(await compact()).toMatchObject({
      ok: true,
      payload: { ok: true, compacted: false, reason: "no transcript" },
    });
  },
);

test.each([undefined, 2])(
  "sessions.compact rejects a missing session with maxLines=%s",
  async (maxLines) => {
    await createSessionStoreDir();
    expect(await compact("agent:main:missing", maxLines)).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: expect.stringContaining("Session agent:main:missing not found"),
      },
    });
  },
);

test.each([false, true])(
  "sessions.compact reads settled facts (native harness: %s)",
  async (nativeHarness) => {
    const scope = await seedCompactionSession("sess-compact-settled", nativeHarness, false);
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
    try {
      embeddedRunMock.compactEmbeddedAgentSession.mockResolvedValueOnce({
        ok: true,
        compacted: true,
      });
      expect(await compact()).toMatchObject({
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
    }
  },
);
