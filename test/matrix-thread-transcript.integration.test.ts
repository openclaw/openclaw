import path from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import {
  createMatrixHandlerTestHarness,
  createMatrixTextMessageEvent,
  installMatrixMonitorTestRuntime,
} from "../extensions/matrix/test-api.js";
import { finalizeInboundContext } from "../src/auto-reply/reply/inbound-context.js";
import { initSessionState } from "../src/auto-reply/reply/session.js";
import { resolveReplyStoredModelSelection } from "../src/auto-reply/reply/stored-model-override.js";
import {
  appendTranscriptMessage,
  loadTranscriptEvents,
  loadSessionEntry,
  replaceSessionEntry,
} from "../src/config/sessions/session-accessor.js";
import { testing as bindingTesting } from "../src/infra/outbound/session-binding-service.js";
import { useSessionStoreTempDirs } from "../src/test-utils/session-state-cleanup.js";

// Keep the plugin test fixture on the caller-owned temporary filesystem.
vi.mock("openclaw/plugin-sdk/temp-path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/temp-path")>();
  const { tmpdir } = await import("node:os");
  return { ...actual, resolvePreferredOpenClawTmpDir: tmpdir };
});
const dirs = useSessionStoreTempDirs(afterAll, "matrix-thread-transcript-");
afterEach(() => {
  bindingTesting.resetSessionBindingAdaptersForTests();
  vi.restoreAllMocks();
});

it("keeps a fresh Matrix thread transcript isolated while preserving allowed root context and room model inheritance", async () => {
  const root = dirs.make();
  const storePath = path.join(root, "sessions.json");
  const roomKey = "agent:ops:matrix:channel:room";
  const parent = { agentId: "ops", storePath, sessionKey: roomKey, sessionId: "room-session" };
  await replaceSessionEntry(parent, {
    sessionId: parent.sessionId,
    updatedAt: Date.now(),
    providerOverride: "synthetic",
    modelOverride: "room-model",
    modelOverrideSource: "user",
  });
  await appendTranscriptMessage(parent, {
    message: { role: "user", content: "ROOM_ONLY_SENTINEL" },
  });
  await appendTranscriptMessage(parent, {
    message: { role: "assistant", content: "ROOM_REPLY_SENTINEL" },
  });
  expect(JSON.stringify(await loadTranscriptEvents(parent))).toContain("ROOM_ONLY_SENTINEL");
  const cfg = {
    session: { store: storePath },
    channels: { matrix: { groupPolicy: "open" as const } },
  };
  installMatrixMonitorTestRuntime({ cfg, stateDir: root });
  const initialized: Awaited<ReturnType<typeof initSessionState>>[] = [];
  const models: unknown[] = [];
  const { handler } = createMatrixHandlerTestHarness({
    cfg,
    isDirectMessage: false,
    threadReplies: "inbound",
    resolveAgentRoute: () => ({
      agentId: "ops",
      channel: "matrix",
      accountId: "ops",
      sessionKey: roomKey,
      mainSessionKey: roomKey,
      matchedBy: "binding.account",
    }),
    client: {
      getEvent: async () =>
        createMatrixTextMessageEvent({
          eventId: "$root",
          sender: "@alice:example.org",
          body: "ALLOWED_ROOT",
        }),
    },
    dispatchInboundMessage: async ({ ctx }) => {
      const result = await initSessionState({
        ctx: finalizeInboundContext(ctx),
        cfg,
        commandAuthorized: true,
      });
      initialized.push(result);
      const selection = await resolveReplyStoredModelSelection({
        sessionEntry: result.sessionEntry,
        sessionStore: result.sessionStore,
        sessionKey: result.sessionKey,
        parentSessionKey: ctx.ModelParentSessionKey ?? ctx.ParentSessionKey,
        defaultProvider: "synthetic",
        defaultModel: "default-model",
        primaryProvider: "synthetic",
        primaryModel: "default-model",
        sessionModelSelectionLocked: false,
        hasResolvedTurnModelOverride: false,
      });
      models.push(selection.modelOverride);
      return { queuedFinal: false, counts: { final: 0, block: 0, tool: 0 } };
    },
  });
  const threadEvent = (eventId: string) =>
    createMatrixTextMessageEvent({
      eventId,
      body: "@room thread request",
      mentions: { room: true },
      relatesTo: {
        rel_type: "m.thread",
        event_id: "$root",
        "m.in_reply_to": { event_id: "$root" },
      },
    });
  await handler("!room:example.org", threadEvent("$first"));
  expect(initialized).toHaveLength(1);
  const first = initialized[0]!;
  const child = {
    agentId: "ops",
    storePath,
    sessionKey: first.sessionKey,
    sessionId: first.sessionId,
  };
  // Assert persisted content, not just the adapter's ParentSessionKey field.
  expect(JSON.stringify(await loadTranscriptEvents(child))).not.toContain("ROOM_ONLY_SENTINEL");
  expect(loadSessionEntry(child)?.forkSource).toBeUndefined();
  expect(first.sessionCtx.ThreadStarterBody).toContain("ALLOWED_ROOT");
  expect(first.sessionCtx.ReplyToBody).toBe("ALLOWED_ROOT");
  expect(models).toEqual([{ provider: "synthetic", model: "room-model" }]);
});
