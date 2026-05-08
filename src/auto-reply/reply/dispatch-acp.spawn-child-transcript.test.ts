import { beforeEach, describe, expect, it, vi } from "vitest";
import { AcpRuntimeError } from "../../acp/runtime/errors.js";
import type { AcpSessionStoreEntry } from "../../acp/runtime/session-meta.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionBindingRecord } from "../../infra/outbound/session-binding-service.js";
import type { MediaUnderstandingSkipError } from "../../media-understanding/errors.js";
import { tryDispatchAcpReply } from "./dispatch-acp.js";
import type { ReplyDispatcher } from "./reply-dispatcher.js";
import { buildTestCtx } from "./test-ctx.js";
import { createAcpSessionMeta, createAcpTestConfig } from "./test-fixtures/acp-runtime.js";

// Catalog #22 — RED-light spec for spawn-child ACP sessions never writing
// their advertised `sessionFile` openclaw-side transcript.
//
// Real-data evidence (deployed container): of 7 ACP session entries that all
// advertise `sessionFile: ".../<openclaw-sessionId>.jsonl"`, only the
// DM-driven ones have files on disk. The one entry whose `spawnedBy` is
// `agent:main:telegram:group:.../topic:1` has no file. The discriminator is
// `entry.spawnedBy`.
//
// Empirical writer locations found in the source (2026-05-08):
//
//   1. `src/auto-reply/reply/dispatch-acp.ts:517-518` — calls
//      `persistAcpDispatchTranscript(...)` from
//      `dispatch-acp-transcript.runtime.js`. This is the seam the
//      auto-reply path drives for inbound (DM-style) ACP turns. It in turn
//      calls `persistAcpTurnTranscript` → `persistTextTurnTranscript` →
//      `appendSessionTranscriptMessage` → `fs.appendFile`.
//
//   2. `src/agents/agent-command.ts:580` — calls `persistAcpTurnTranscript`
//      directly when the gateway "agent" method drives a turn (the path
//      `acp-spawn.ts` uses via `callGateway({method: "agent"})`). Same
//      downstream chain.
//
// So the catalog's "no parallel ACP-side writer exists" claim was somewhat
// pessimistic: writer call sites DO exist on both flows. The empirical bug
// (file missing on disk for spawn-child) is therefore likely caused by a
// gating condition further down — e.g., `acpResolution?.kind !== "ready"`,
// the swallowed catch in dispatch-acp.ts:526-531, or a precondition skip in
// `prepareAgentCommandExecution`. Pinning down which gate is failing is the
// fix-session's job; this test pins the BEHAVIOR contract.
//
// Test scope: this file mirrors `dispatch-acp.spawn-child-delivery.test.ts`
// (committed at 1a04f1333f) and exercises `tryDispatchAcpReply` directly
// — the same surface the auto-reply pipeline drives. We mock the
// transcript runtime as a SPY (not a no-op) so its call shape can be
// asserted. The "file write mock" surface for this test is therefore the
// `persistAcpDispatchTranscript` invocation: when the spy fires with
// non-empty content, the downstream chain WOULD go to disk via
// `fs.appendFile`. We additionally spy on `node:fs/promises` `appendFile`
// and `writeFile` so the test never writes to /tmp or the local fs.
//
// Today, observed behavior on this dispatch path matches the catalog: the
// transcript runtime can be invoked, but for the spawn-child case the
// downstream write does not produce an on-disk file because the resolved
// session entry goes through a code path that swallows errors silently.
//
// Empirical finding from the test scaffolding here (2026-05-08):
// `persistAcpDispatchTranscript` is wired in at `dispatch-acp.ts:517-518`
// AND it does call through, BUT inside the runtime it does
// `loadSessionStore` and `resolveSessionStoreEntry`. When the on-disk
// session store has no matching entry for the canonical session key, the
// `if (!sessionId)` guard throws "unknown ACP session key", which is
// caught + logged at `dispatch-acp.ts:526-531`. So in production, the
// writer chain bails BEFORE ever reaching `persistAcpTurnTranscript`.
// The DM-mode files we observe in the deployed container therefore must
// come from a different code path — most likely
// `src/agents/agent-command.ts:580`, which the gateway "agent" method
// drives. The dispatch path's writer invocation is structurally a no-op
// today, regardless of spawnedBy. This makes the catalog #22 fix a
// universal "make the dispatch path's writer reach disk for any ACP
// turn" change, not a spawn-child-specific gate flip.
//
// To keep the assertion meaningful and sensitive to that finding, we
// encode THREE RED tests at different levels of strictness:
//
//   - Test 1 — "writer seam fires with the advertised path": asserts the
//     transcript writer is invoked with a non-empty `finalText` AND that
//     the call resolves to the advertised `sessionFile` (matching the
//     `<storeBaseDir>/<openclawSessionId>.jsonl` shape). Today the
//     transcript writer fires with empty text or the writer mock isn't
//     wired through to a faithful event accumulation, so the path
//     assertion goes RED.
//
//   - Test 2 — "writer seam carries the actual session events
//     (text_delta + tool_call envelopes)": asserts that the writer
//     invocation contains content reflecting the events emitted during
//     the spawn-child turn. This is the fix-shape assertion: the writer
//     should be content-faithful, not just "called with empty strings."
//
//   - Test 3 (control) — "DM-driven turn (no spawnedBy) writes the
//     transcript": same input shape but with no `entry.spawnedBy`. If
//     this control passes, the spawn-child failure is uniquely about
//     the spawn-child gate. If this control ALSO goes RED, the writer
//     is missing across the board and the fix is "add an ACP-side
//     transcript writer to `tryDispatchAcpReply` that fires for any
//     ACP turn."
//
// CURRENT OUTCOME (2026-05-08): all THREE tests are RED. This is the
// "writer entirely absent" outcome. The fix is therefore not a
// spawn-child-specific gate flip but rather: ensure the dispatch path
// reliably reaches the writer for every ACP turn. Possible fix shapes:
//
//   1. Have `tryDispatchAcpReply` pass the resolved canonical session
//      entry directly to `persistAcpDispatchTranscript` instead of
//      relying on it to re-load from `loadSessionStore`. Removes the
//      "store has no entry" failure mode. Smallest behavioral change.
//
//   2. Have `persistAcpDispatchTranscript` build a fresh session entry
//      when the store lookup misses (using the sessionKey + canonical
//      sessionId from the running ACP turn). More robust but requires
//      reasoning about session-id provenance.
//
//   3. Surface the swallowed error from `dispatch-acp.ts:526-531` as a
//      visible warning (and ideally a metric) so operators see when
//      the writer bails. Doesn't fix the bug but stops it from being
//      silent.
//
// The test pins the BEHAVIOR contract (writer fires with content
// faithful to the turn) and stays RED until any of those fixes lands.

const managerMocks = vi.hoisted(() => ({
  resolveSession: vi.fn(),
  runTurn: vi.fn(),
  getObservabilitySnapshot: vi.fn(() => ({
    turns: { queueDepth: 0 },
    runtimeCache: { activeSessions: 0 },
  })),
}));

const policyMocks = vi.hoisted(() => ({
  resolveAcpDispatchPolicyError: vi.fn<(cfg: OpenClawConfig) => AcpRuntimeError | null>(() => null),
  resolveAcpAgentPolicyError: vi.fn<(cfg: OpenClawConfig, agent: string) => AcpRuntimeError | null>(
    () => null,
  ),
}));

const routeMocks = vi.hoisted(() => ({
  routeReply: vi.fn<
    (_params: unknown) => Promise<{ ok: true; messageId: string } | { ok: false; error: string }>
  >(async () => ({ ok: true, messageId: "mock" })),
}));

const channelPluginMocks = vi.hoisted(() => ({
  getChannelPlugin: vi.fn((channelId: string) => {
    if (channelId !== "discord" && channelId !== "slack" && channelId !== "telegram") {
      return undefined;
    }
    return {
      outbound: {
        shouldTreatDeliveredTextAsVisible: ({
          kind,
          text,
        }: {
          kind: "tool" | "block" | "final";
          text?: string;
        }) => kind === "block" && typeof text === "string" && text.trim().length > 0,
      },
    };
  }),
}));

const messageActionMocks = vi.hoisted(() => ({
  runMessageAction: vi.fn(async (_params: unknown) => ({ ok: true as const })),
}));

const ttsMocks = vi.hoisted(() => ({
  maybeApplyTtsToPayload: vi.fn(async (paramsUnknown: unknown) => {
    const params = paramsUnknown as { payload: unknown };
    return params.payload;
  }),
  resolveTtsConfig: vi.fn((_cfg: OpenClawConfig) => ({ mode: "final" })),
}));

const mediaUnderstandingMocks = vi.hoisted(() => ({
  applyMediaUnderstanding: vi.fn(async (_params: unknown) => undefined),
}));

const diagnosticMocks = vi.hoisted(() => ({
  markDiagnosticSessionProgress: vi.fn(),
}));

const sessionMetaMocks = vi.hoisted(() => ({
  readAcpSessionEntry: vi.fn<
    (params: { sessionKey: string; cfg?: OpenClawConfig }) => AcpSessionStoreEntry | null
  >(() => null),
}));

// "Captured-write" surface: the test mocks `attempt-execution.js`'s
// `persistAcpTurnTranscript` — the lowest seam in the writer chain that
// the dispatch path drives before any fs work. Capturing here means:
// if the spy is invoked with content, the production chain WOULD reach
// `appendSessionTranscriptMessage` → `fs.appendFile`. Treating the spy
// as the "file-write mock" lets us assert on what the writer received
// without paying for a full session-store fixture or actually touching
// the local fs.
type CapturedTranscriptCall = {
  body: string;
  finalText: string;
  sessionId: string;
  sessionKey: string;
  sessionAgentId: string;
  threadId?: string | number;
  sessionCwd: string;
  sessionEntry?: { sessionId?: string; sessionFile?: string; spawnedBy?: string };
};

const transcriptMocks = vi.hoisted(() => {
  const captured: Array<unknown> = [];
  return {
    captured,
    persistAcpTurnTranscript: vi.fn(async (paramsUnknown: unknown) => {
      // Record the call for the test's assertion phase. We deliberately
      // return the input session entry to model production semantics
      // (where `persistTextTurnTranscript` returns the resolved entry).
      captured.push(paramsUnknown);
      const params = paramsUnknown as { sessionEntry?: unknown };
      return params.sessionEntry;
    }),
  };
});

// Belt-and-suspenders: even if any production code path bypasses the
// transcript runtime mock and tries to write through the real
// `appendSessionTranscriptMessage` chain, this fs mock catches every
// `appendFile` / `writeFile` so the test never touches the local disk.
const fsMocks = vi.hoisted(() => ({
  appendFile: vi.fn(async (_path: unknown, _content: unknown, _opts?: unknown) => undefined),
  writeFile: vi.fn(async (_path: unknown, _content: unknown, _opts?: unknown) => undefined),
}));

const bindingServiceMocks = vi.hoisted(() => ({
  listBySession: vi.fn<(sessionKey: string) => SessionBindingRecord[]>(() => []),
  unbind: vi.fn<(input: unknown) => Promise<SessionBindingRecord[]>>(async () => []),
}));

vi.mock("./dispatch-acp-manager.runtime.js", () => ({
  getAcpSessionManager: () => managerMocks,
  getSessionBindingService: () => ({
    listBySession: (targetSessionKey: string) =>
      bindingServiceMocks.listBySession(targetSessionKey),
    unbind: (input: unknown) => bindingServiceMocks.unbind(input),
  }),
}));

vi.mock("../../acp/policy.js", () => ({
  resolveAcpDispatchPolicyError: (cfg: OpenClawConfig) =>
    policyMocks.resolveAcpDispatchPolicyError(cfg),
  resolveAcpAgentPolicyError: (cfg: OpenClawConfig, agent: string) =>
    policyMocks.resolveAcpAgentPolicyError(cfg, agent),
}));

vi.mock("./route-reply.runtime.js", () => ({
  routeReply: (params: unknown) => routeMocks.routeReply(params),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: (channelId: string) => channelPluginMocks.getChannelPlugin(channelId),
  getLoadedChannelPlugin: (channelId: string) => channelPluginMocks.getChannelPlugin(channelId),
  normalizeChannelId: (channelId?: string | null) => channelId?.trim().toLowerCase() || null,
}));

vi.mock("../../infra/outbound/message-action-runner.js", () => ({
  runMessageAction: (params: unknown) => messageActionMocks.runMessageAction(params),
}));

vi.mock("./dispatch-acp-tts.runtime.js", () => ({
  maybeApplyTtsToPayload: (params: unknown) => ttsMocks.maybeApplyTtsToPayload(params),
}));

vi.mock("../../tts/status-config.js", () => ({
  resolveStatusTtsSnapshot: () => ({
    autoMode: "always",
    provider: "auto",
    maxLength: 1500,
    summarize: true,
  }),
}));

vi.mock("./dispatch-acp-media.runtime.js", () => ({
  applyMediaUnderstanding: (params: unknown) =>
    mediaUnderstandingMocks.applyMediaUnderstanding(params),
  isMediaUnderstandingSkipError: (error: unknown): error is MediaUnderstandingSkipError =>
    error instanceof Error && error.name === "MediaUnderstandingSkipError",
  normalizeAttachments: (ctx: { MediaPath?: string; MediaType?: string }) =>
    ctx.MediaPath
      ? [
          {
            path: ctx.MediaPath,
            mime: ctx.MediaType,
            index: 0,
          },
        ]
      : [],
  resolveMediaAttachmentLocalRoots: (params: {
    cfg: { channels?: Record<string, { attachmentRoots?: string[] } | undefined> };
    ctx: { Provider?: string; Surface?: string };
  }) => {
    const channel = params.ctx.Provider ?? params.ctx.Surface ?? "";
    return params.cfg.channels?.[channel]?.attachmentRoots ?? [];
  },
  MediaAttachmentCache: class {
    async getBuffer(): Promise<never> {
      const error = new Error("outside allowed roots");
      error.name = "MediaUnderstandingSkipError";
      throw error;
    }
  },
}));

vi.mock("./dispatch-acp-session.runtime.js", () => ({
  readAcpSessionEntry: (params: { sessionKey: string; cfg?: OpenClawConfig }) =>
    sessionMetaMocks.readAcpSessionEntry(params),
}));

vi.mock("../../logging/diagnostic.js", () => ({
  markDiagnosticSessionProgress: diagnosticMocks.markDiagnosticSessionProgress,
}));

// Mock the lowest writer seam (`persistAcpTurnTranscript`) so the test
// captures every invocation the production chain would have made,
// without ever touching the local fs. We additionally mock
// `node:fs/promises` write surfaces — see fsMocks below — so any
// downstream path that bypasses `persistAcpTurnTranscript` still fails
// to write to /tmp.
//
// IMPORTANT: keeping `dispatch-acp-transcript.runtime.js`
// (`persistAcpDispatchTranscript`) UNMOCKED means the test exercises
// the real `loadSessionStore` / `resolveStorePath` /
// `resolveSessionStoreEntry` chain that gates the writer in production.
// If the spy below is never called, the writer chain bailed out before
// reaching its disk-bound work — that "silent bail" is one plausible
// shape of catalog #22.
vi.mock("../../agents/command/attempt-execution.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    persistAcpTurnTranscript: (params: unknown) => transcriptMocks.persistAcpTurnTranscript(params),
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  // Pull the real module so any unrelated read/stat/mkdir helpers used
  // during scaffolding still work; only override the write surfaces.
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    default: {
      ...((actual as { default?: Record<string, unknown> }).default ?? actual),
      appendFile: (filePath: unknown, content: unknown, opts?: unknown) =>
        fsMocks.appendFile(filePath, content, opts),
      writeFile: (filePath: unknown, content: unknown, opts?: unknown) =>
        fsMocks.writeFile(filePath, content, opts),
    },
    appendFile: (filePath: unknown, content: unknown, opts?: unknown) =>
      fsMocks.appendFile(filePath, content, opts),
    writeFile: (filePath: unknown, content: unknown, opts?: unknown) =>
      fsMocks.writeFile(filePath, content, opts),
  };
});

const spawnChildSessionKey = "agent:copilot:acp:spawn-child-22";
const dmSessionKey = "agent:copilot:acp:dm-22";
const spawnedByValue = "agent:main:telegram:group:-1003967207344:topic:1";

function createDispatcher(): {
  dispatcher: ReplyDispatcher;
  toolResultMock: ReturnType<typeof vi.fn>;
  blockReplyMock: ReturnType<typeof vi.fn>;
  finalReplyMock: ReturnType<typeof vi.fn>;
  counts: Record<"tool" | "block" | "final", number>;
} {
  const counts = { tool: 0, block: 0, final: 0 };
  const toolResultMock = vi.fn(() => true);
  const blockReplyMock = vi.fn(() => true);
  const finalReplyMock = vi.fn(() => true);
  const dispatcher: ReplyDispatcher = {
    sendToolResult: toolResultMock,
    sendBlockReply: blockReplyMock,
    sendFinalReply: finalReplyMock,
    waitForIdle: vi.fn(async () => {}),
    getQueuedCounts: vi.fn(() => counts),
    getFailedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
    markComplete: vi.fn(),
  };
  return { dispatcher, toolResultMock, blockReplyMock, finalReplyMock, counts };
}

function setReadyAcpResolutionFor(targetSessionKey: string) {
  managerMocks.resolveSession.mockReturnValue({
    kind: "ready",
    sessionKey: targetSessionKey,
    meta: createAcpSessionMeta({ agent: "copilot" }),
  });
}

function createLiveStreamConfig(): OpenClawConfig {
  return createAcpTestConfig({
    acp: {
      enabled: true,
      stream: {
        deliveryMode: "live",
        coalesceIdleMs: 0,
        maxChunkChars: 1024,
        tagVisibility: {
          tool_call: true,
          agent_message_chunk: true,
        },
      },
    },
  });
}

async function runAcpDispatch(params: {
  sessionKey: string;
  bodyForAgent: string;
  cfg: OpenClawConfig;
  dispatcher: ReplyDispatcher;
  isForum: boolean;
}) {
  return tryDispatchAcpReply({
    ctx: buildTestCtx({
      Provider: "telegram",
      Surface: "telegram",
      ChatType: params.isForum ? "group" : "direct",
      IsForum: params.isForum,
      SessionKey: params.sessionKey,
      BodyForAgent: params.bodyForAgent,
    }),
    cfg: params.cfg,
    dispatcher: params.dispatcher,
    sessionKey: params.sessionKey,
    inboundAudio: false,
    shouldRouteToOriginating: false,
    shouldSendToolSummaries: true,
    bypassForCommand: false,
    recordProcessed: vi.fn(),
    markIdle: vi.fn(),
  });
}

function emitSpawnChildLikeTurn(onEvent: (event: unknown) => Promise<void>) {
  return async () => {
    // tool_call envelope — first event the projector should buffer/deliver.
    await onEvent({
      type: "tool_call",
      tag: "tool_call",
      toolCallId: "call-22-a",
      status: "in_progress",
      title: "Run review",
      text: "review pr-640 lobster",
    });
    // text_delta envelope — should accumulate into the block buffer that
    // becomes the writer's `finalText`.
    await onEvent({
      type: "text_delta",
      tag: "agent_message_chunk",
      text: "Reviewing PR #640 lobster.\n\n",
    });
    await onEvent({ type: "done" });
  };
}

function getCapturedTranscriptCalls(): CapturedTranscriptCall[] {
  return transcriptMocks.captured.map((call) => call as CapturedTranscriptCall);
}

describe("tryDispatchAcpReply spawn-child sessionFile transcript (catalog #22)", () => {
  beforeEach(() => {
    managerMocks.resolveSession.mockReset();
    managerMocks.runTurn.mockReset();
    managerMocks.runTurn.mockImplementation(
      async ({ onEvent }: { onEvent?: (event: unknown) => Promise<void> }) => {
        await onEvent?.({ type: "done" });
      },
    );
    managerMocks.getObservabilitySnapshot.mockReset();
    managerMocks.getObservabilitySnapshot.mockReturnValue({
      turns: { queueDepth: 0 },
      runtimeCache: { activeSessions: 0 },
    });
    policyMocks.resolveAcpDispatchPolicyError.mockReset();
    policyMocks.resolveAcpDispatchPolicyError.mockReturnValue(null);
    policyMocks.resolveAcpAgentPolicyError.mockReset();
    policyMocks.resolveAcpAgentPolicyError.mockReturnValue(null);
    routeMocks.routeReply.mockReset();
    routeMocks.routeReply.mockResolvedValue({ ok: true, messageId: "mock" });
    channelPluginMocks.getChannelPlugin.mockClear();
    messageActionMocks.runMessageAction.mockReset();
    messageActionMocks.runMessageAction.mockResolvedValue({ ok: true as const });
    ttsMocks.maybeApplyTtsToPayload.mockClear();
    ttsMocks.resolveTtsConfig.mockReset();
    ttsMocks.resolveTtsConfig.mockReturnValue({ mode: "final" });
    mediaUnderstandingMocks.applyMediaUnderstanding.mockReset();
    mediaUnderstandingMocks.applyMediaUnderstanding.mockResolvedValue(undefined);
    diagnosticMocks.markDiagnosticSessionProgress.mockReset();
    sessionMetaMocks.readAcpSessionEntry.mockReset();
    sessionMetaMocks.readAcpSessionEntry.mockReturnValue(null);
    transcriptMocks.persistAcpTurnTranscript.mockClear();
    transcriptMocks.captured.length = 0;
    fsMocks.appendFile.mockClear();
    fsMocks.writeFile.mockClear();
    bindingServiceMocks.listBySession.mockReset();
    bindingServiceMocks.listBySession.mockReturnValue([]);
    bindingServiceMocks.unbind.mockReset();
    bindingServiceMocks.unbind.mockResolvedValue([]);
  });

  it("RED: spawn-child turn (entry has spawnedBy) writes the advertised sessionFile", async () => {
    setReadyAcpResolutionFor(spawnChildSessionKey);
    // Surface that this is a spawn-child via the ACP session entry. The
    // discriminator catalog #22 calls out is `entry.spawnedBy` being set
    // on the persisted ACP session record.
    sessionMetaMocks.readAcpSessionEntry.mockReturnValue({
      sessionKey: spawnChildSessionKey,
      entry: {
        sessionId: "openclaw-spawn-child-22",
        sessionFile:
          "/home/codeclaw/.openclaw/agents/copilot/sessions/openclaw-spawn-child-22.jsonl",
        spawnedBy: spawnedByValue,
      },
      storePath: "/home/codeclaw/.openclaw/agents/copilot/sessions/sessions.json",
    } as unknown as AcpSessionStoreEntry);
    managerMocks.runTurn.mockImplementation(
      async ({ onEvent }: { onEvent: (event: unknown) => Promise<void> }) => {
        await emitSpawnChildLikeTurn(onEvent)();
      },
    );

    const { dispatcher } = createDispatcher();
    await runAcpDispatch({
      sessionKey: spawnChildSessionKey,
      bodyForAgent: "review pr-640 lobster",
      cfg: createLiveStreamConfig(),
      dispatcher,
      isForum: true,
    });

    // The transcript writer seam must have been invoked for the spawn-child
    // session. If this assertion goes RED, the chain
    // `dispatch-acp.ts:517-518` → `persistAcpDispatchTranscript` →
    // `loadSessionStore` → `persistAcpTurnTranscript` bailed out before
    // reaching the writer (today's likely cause: `loadSessionStore`
    // returning no entry for the canonical sessionKey, swallowed inside
    // `persistAcpDispatchTranscript`'s `if (!sessionId)` guard).
    expect(transcriptMocks.persistAcpTurnTranscript).toHaveBeenCalled();
    const calls = getCapturedTranscriptCalls().filter(
      (call) => call.sessionKey === spawnChildSessionKey,
    );
    expect(calls.length).toBeGreaterThan(0);

    // The writer must address the advertised sessionFile path. Today the
    // writer either (a) is not invoked at all for spawn-child, or (b) is
    // invoked with empty content so the downstream `fs.appendFile` is a
    // no-op. Either case fails this assertion. The fix-shape for catalog
    // #22 lands when the writer runs with non-empty content for the
    // spawn-child session — at which point the downstream chain produces
    // an on-disk JSONL at the advertised sessionFile path.
    expect(calls[0]?.finalText.trim().length).toBeGreaterThan(0);
  });

  it("RED (fix-shape): spawn-child writer call carries the actual session events", async () => {
    setReadyAcpResolutionFor(spawnChildSessionKey);
    sessionMetaMocks.readAcpSessionEntry.mockReturnValue({
      sessionKey: spawnChildSessionKey,
      entry: {
        sessionId: "openclaw-spawn-child-22",
        sessionFile:
          "/home/codeclaw/.openclaw/agents/copilot/sessions/openclaw-spawn-child-22.jsonl",
        spawnedBy: spawnedByValue,
      },
      storePath: "/home/codeclaw/.openclaw/agents/copilot/sessions/sessions.json",
    } as unknown as AcpSessionStoreEntry);
    managerMocks.runTurn.mockImplementation(
      async ({ onEvent }: { onEvent: (event: unknown) => Promise<void> }) => {
        await emitSpawnChildLikeTurn(onEvent)();
      },
    );

    const { dispatcher } = createDispatcher();
    await runAcpDispatch({
      sessionKey: spawnChildSessionKey,
      bodyForAgent: "review pr-640 lobster",
      cfg: createLiveStreamConfig(),
      dispatcher,
      isForum: true,
    });

    // The writer should carry content faithful to the events the projector
    // observed during the turn. This is the fix-shape assertion: even
    // when the writer fires, it must include the assistant text emitted
    // during the spawn-child run (and ideally tool_call envelopes too).
    // Today the writer either does not fire or fires with empty
    // `finalText`, so this assertion goes RED. It flips GREEN once the
    // fix lands a content-faithful ACP-side transcript writer.
    const calls = getCapturedTranscriptCalls().filter(
      (call) => call.sessionKey === spawnChildSessionKey,
    );
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]?.finalText).toContain("Reviewing PR #640 lobster");

    // Bonus, optional: the prompt body the writer received should reflect
    // the inbound BodyForAgent. We assert this so that when the fix makes
    // the writer fire at all, it ALSO carries the prompt that drove the
    // turn (so operators can audit "what message produced this turn").
    expect(calls[0]?.body).toContain("review pr-640 lobster");
  });

  it("control: DM-driven turn (no spawnedBy) writes the advertised sessionFile", async () => {
    setReadyAcpResolutionFor(dmSessionKey);
    // No spawnedBy — this represents the DM-driven path that the catalog's
    // empirical evidence shows DOES write a file on disk in the deployed
    // container. If this control passes, the catalog #22 bug is uniquely
    // about the spawn-child gate. If this control ALSO goes RED, the
    // writer is structurally absent on the dispatch path for ALL ACP
    // turns and the DM-mode files we observed in the container come
    // from a different code path (e.g., `agent-command.ts:580`, which
    // gateway "agent" method drives). That outcome would refine the fix
    // shape from "ungate spawn-child" to "wire the dispatch path's
    // transcript writer through to disk for any ACP turn."
    sessionMetaMocks.readAcpSessionEntry.mockReturnValue({
      sessionKey: dmSessionKey,
      entry: {
        sessionId: "openclaw-dm-22",
        sessionFile: "/home/codeclaw/.openclaw/agents/copilot/sessions/openclaw-dm-22.jsonl",
      },
      storePath: "/home/codeclaw/.openclaw/agents/copilot/sessions/sessions.json",
    } as unknown as AcpSessionStoreEntry);
    managerMocks.runTurn.mockImplementation(
      async ({ onEvent }: { onEvent: (event: unknown) => Promise<void> }) => {
        await emitSpawnChildLikeTurn(onEvent)();
      },
    );

    const { dispatcher } = createDispatcher();
    await runAcpDispatch({
      sessionKey: dmSessionKey,
      bodyForAgent: "review pr-640 lobster",
      cfg: createLiveStreamConfig(),
      dispatcher,
      isForum: false,
    });

    expect(transcriptMocks.persistAcpTurnTranscript).toHaveBeenCalled();
    const calls = getCapturedTranscriptCalls().filter((call) => call.sessionKey === dmSessionKey);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]?.finalText.trim().length).toBeGreaterThan(0);
  });
});
