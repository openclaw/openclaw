import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAgentHarnesses } from "../../agents/harness/registry.js";
import { setLoggerOverride } from "../../logging/logger.js";
import { loggingState } from "../../logging/state.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { emitSessionIdentityMutation } from "../../sessions/session-lifecycle-events.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import type { MsgContext } from "../templating.js";
import {
  sessionStoreMocks,
  acpMocks,
  mocks,
  noAbortResult,
  resetPluginTtsAndThreadMocks,
} from "./dispatch-from-config.shared.test-harness.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { buildTestCtx } from "./test-ctx.js";

const notice =
  "My session in this room ended during restart recovery. Use /reset or /new to start a replacement session.";

let dispatchReplyFromConfig: typeof import("./dispatch-from-config.js").dispatchReplyFromConfig;
let resetInboundDedupe: typeof import("./inbound-dedupe.js").resetInboundDedupe;
let resetReplyRunRegistry: () => void;
beforeAll(async () => {
  ({ dispatchReplyFromConfig } = await import("./dispatch-from-config.js"));
  ({ resetInboundDedupe } = await import("./inbound-dedupe.js"));
  const { testing } = await import("./reply-run-registry.test-support.js");
  resetReplyRunRegistry = () => testing.resetReplyRunRegistry();
});

describe("restart tombstone channel feedback", () => {
  const warn = vi.fn();
  const deliver = vi.fn(async () => {});
  const replyResolver = vi.fn(async () => ({ text: "agent reply" }));
  let sessionKey: string;
  let messageId: number;

  beforeEach(() => {
    clearAgentHarnesses();
    resetReplyRunRegistry();
    resetInboundDedupe();
    resetPluginTtsAndThreadMocks();
    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "buzz", source: "test", plugin: createChannelTestPluginBase({ id: "buzz" }) },
      ]),
    );
    mocks.tryFastAbortFromMessage.mockResolvedValue(noAbortResult);
    mocks.routeReply
      .mockReset()
      .mockResolvedValue({ ok: true, delivered: true, messageId: "mock" });
    acpMocks.readAcpSessionEntry.mockReset().mockReturnValue(null);
    sessionStoreMocks.loadSessionEntry
      .mockReset()
      .mockImplementation(() => sessionStoreMocks.currentEntry);
    warn.mockClear();
    deliver.mockClear();
    replyResolver.mockClear();
    sessionKey = `agent:main:buzz:group:buzz:${randomUUID()}`;
    messageId = 0;
    sessionStoreMocks.currentEntry = {
      sessionId: "failed-session",
      updatedAt: Date.now(),
      status: "failed",
      mainRestartRecovery: {
        cycleId: "failed-cycle",
        revision: 4,
        chargedAttempts: 3,
        tombstone: { reason: "automatic recovery exhausted" },
      },
    };
    setLoggerOverride({ level: "silent", consoleLevel: "warn", consoleStyle: "compact" });
    loggingState.rawConsole = { log: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
  });

  afterEach(() => {
    emitSessionIdentityMutation({
      kind: "delete",
      agentId: "main",
      previous: { sessionId: "failed-session", sessionKeys: [sessionKey] },
    });
    loggingState.rawConsole = null;
    setLoggerOverride(null);
  });

  async function rejectInbound(options?: {
    context?: Partial<MsgContext>;
    visibleReplies?: "automatic" | "message_tool";
    sendPolicy?: "allow" | "deny";
    receiptless?: boolean;
  }) {
    const dispatcher = createReplyDispatcher({ deliver });
    if (options?.receiptless) {
      const waitForIdle = dispatcher.waitForIdle;
      dispatcher.waitForIdle = async () => {
        await waitForIdle();
      };
    }
    await expect(
      dispatchReplyFromConfig({
        ctx: buildTestCtx({
          Provider: "buzz",
          Surface: "buzz",
          OriginatingChannel: "buzz",
          OriginatingTo: "buzz:00000000-0000-4000-8000-000000000001",
          ChatType: "group",
          SessionKey: sessionKey,
          MessageSid: String(++messageId),
          Body: "Can you answer?",
          RawBody: "Can you answer?",
          CommandBody: "Can you answer?",
          InboundAccessAuthorized: true,
          InboundEventKind: "user_request",
          InputProvenance: { kind: "external_user", sourceChannel: "buzz" },
          WasMentioned: true,
          ...options?.context,
        }),
        cfg: {
          messages: { groupChat: { visibleReplies: options?.visibleReplies ?? "automatic" } },
          ...(options?.sendPolicy
            ? { session: { sendPolicy: { default: options.sendPolicy } } }
            : {}),
        },
        dispatcher,
        replyResolver,
      }),
    ).rejects.toThrow(/ended during restart recovery/i);
    dispatcher.markComplete();
    await dispatcher.waitForIdle();
  }

  it.each(["automatic", "message_tool"] as const)(
    "delivers one room notice under %s and warns for every rejected inbound",
    async (visibleReplies) => {
      await rejectInbound({ visibleReplies });
      expect(deliver).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ text: notice }),
        expect.objectContaining({ kind: "final" }),
      );
      await rejectInbound({ visibleReplies });
      expect(deliver).toHaveBeenCalledOnce();
      expect(replyResolver).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(2);
      for (const [line] of warn.mock.calls) {
        expect(line).toContain(sessionKey);
        expect(line).toContain("automatic recovery exhausted");
        expect(line).toContain("/reset");
      }
      expect(sessionStoreMocks.currentEntry).toMatchObject({
        sessionId: "failed-session",
        mainRestartRecovery: { tombstone: { reason: "automatic recovery exhausted" } },
      });
    },
  );

  it.each(["reset", "delete"] as const)("clears notice suppression on %s", async (kind) => {
    await rejectInbound();
    const previous = { sessionId: "failed-session", sessionKeys: [sessionKey] };
    emitSessionIdentityMutation(
      kind === "delete"
        ? { kind, agentId: "main", previous }
        : { kind, agentId: "main", previous, current: previous },
    );
    await rejectInbound();
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("keeps model-locked recovery guidance actionable", async () => {
    sessionStoreMocks.currentEntry!.modelSelectionLocked = true;
    await rejectInbound();
    expect(deliver).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        text: expect.stringContaining("WebChat and use Resume in new session"),
      }),
      expect.objectContaining({ kind: "final" }),
    );
  });

  it.each([
    { label: "room event", context: { InboundEventKind: "room_event" as const } },
    { label: "unauthorized inbound", context: { InboundAccessAuthorized: false } },
    { label: "system turn", context: { InputProvenance: { kind: "internal_system" as const } } },
  ])("does not notify for $label", async ({ context }) => {
    await rejectInbound({ context });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("honors explicit send-policy denial", async () => {
    await rejectInbound({ sendPolicy: "deny" });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("logs failed notice delivery without replacing the rejection or repeating the notice", async () => {
    deliver.mockRejectedValueOnce(new Error("transport failed"));
    await rejectInbound();
    await rejectInbound();
    expect(deliver).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("notice delivery was not confirmed"));
    expect(replyResolver).not.toHaveBeenCalled();
  });

  it("warns about ambiguous routed delivery without repeating the notice", async () => {
    mocks.routeReply.mockResolvedValueOnce({ ok: true, delivered: true, ambiguous: true });
    const context = { Provider: "slack", Surface: "slack" };
    await rejectInbound({ context });
    await rejectInbound({ context });
    expect(mocks.routeReply).toHaveBeenCalledOnce();
    expect(deliver).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("notice delivery was not confirmed"));
  });

  it("treats a receiptless dispatcher as unconfirmed without repeating the notice", async () => {
    await rejectInbound({ receiptless: true });
    await rejectInbound({ receiptless: true });
    expect(deliver).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("notice delivery was not confirmed"));
  });

  it("rechecks ACP privacy after waiting for admission", async () => {
    sessionStoreMocks.loadSessionEntry.mockImplementation(() => {
      acpMocks.readAcpSessionEntry.mockReturnValue({
        entry: { sessionId: "failed-session", spawnedBy: "agent:main:parent" },
        acp: { backend: "acpx", mode: "persistent" },
      });
      return sessionStoreMocks.currentEntry;
    });
    await rejectInbound();
    expect(deliver).not.toHaveBeenCalled();
  });

  it("rechecks send policy after waiting for admission", async () => {
    sessionStoreMocks.loadSessionEntry.mockImplementation(() => {
      sessionStoreMocks.currentEntry!.sendPolicy = "deny";
      return sessionStoreMocks.currentEntry;
    });
    await rejectInbound();
    expect(deliver).not.toHaveBeenCalled();
  });
});
