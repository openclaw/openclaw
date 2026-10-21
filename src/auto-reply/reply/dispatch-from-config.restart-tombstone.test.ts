import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { clearAgentHarnesses } from "../../agents/harness/registry.js";
import * as diagnostics from "../../infra/diagnostic-events.js";
import { setLoggerOverride } from "../../logging/logger.js";
import { loggingState } from "../../logging/state.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import * as channels from "../../test-utils/channel-plugins.js";
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
  "My session in this room ended during restart recovery. Use Resume in WebChat, or /reset or /new to start a replacement session.";

let dispatchReplyFromConfig: typeof import("./dispatch-from-config.js").dispatchReplyFromConfig;
let resetInboundDedupe: typeof import("./inbound-dedupe.js").resetInboundDedupe;
let resetSessionControllerForTest: () => void;
beforeAll(async () => {
  ({ dispatchReplyFromConfig } = await import("./dispatch-from-config.js"));
  ({ resetInboundDedupe } = await import("./inbound-dedupe.js"));
  const { testing } = await import("../../sessions/session-controller.test-support.js");
  resetSessionControllerForTest = () => testing.resetSessionControllerForTest();
});

describe("restart tombstone channel feedback", () => {
  const warn = vi.fn();
  const deliver = vi.fn(async () => {});
  const replyResolver = vi.fn(async () => ({ text: "agent reply" }));
  let sessionKey: string;
  let messageId: number;

  beforeEach(() => {
    clearAgentHarnesses();
    resetSessionControllerForTest();
    resetInboundDedupe();
    resetPluginTtsAndThreadMocks();
    setActivePluginRegistry(
      channels.createTestRegistry([
        {
          pluginId: "buzz",
          source: "test",
          plugin: channels.createChannelTestPluginBase({ id: "buzz" }),
        },
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
    loggingState.rawConsole = null;
    setLoggerOverride(null);
  });

  async function rejectInbound(options?: {
    context?: Partial<MsgContext>;
    visibleReplies?: "automatic" | "message_tool";
    sendPolicy?: "allow" | "deny";
  }) {
    const dispatcher = createReplyDispatcher({ deliver });
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

  it("delivers one message-tool room notice and warns for every rejected inbound", async () => {
    let elapsedMs = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => elapsedMs);
    const diagnosticsWereEnabled = diagnostics.areDiagnosticsEnabledForProcess();
    diagnostics.setDiagnosticsEnabledForProcess(true);
    onTestFinished(() => {
      clock.mockRestore();
      diagnostics.setDiagnosticsEnabledForProcess(diagnosticsWereEnabled);
    });
    sessionStoreMocks.loadSessionEntry.mockImplementation(() => {
      elapsedMs += 1_500;
      return sessionStoreMocks.currentEntry;
    });
    // Slow lifecycle diagnostics must not count as duplicate rejection warnings.
    const rejectionWarnings = () =>
      warn.mock.calls.filter(([line]) => line.includes("[auto-reply/reply-turn-admission]"));
    await rejectInbound({ visibleReplies: "message_tool" });
    expect(rejectionWarnings()).toHaveLength(1);
    expect(deliver).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ text: notice }),
      expect.objectContaining({ kind: "final" }),
    );
    await rejectInbound({ visibleReplies: "message_tool" });
    expect(deliver).toHaveBeenCalledOnce();
    expect(replyResolver).not.toHaveBeenCalled();
    expect(rejectionWarnings()).toHaveLength(2);
    for (const [line] of rejectionWarnings()) {
      expect(line).toContain(sessionKey);
      expect(line).toContain("automatic recovery exhausted");
      expect(line).toContain("/reset");
    }
    expect(warn.mock.calls.map(([line]) => stripVTControlCharacters(line))).toContainEqual(
      expect.stringContaining("[sessions/lifecycle] slow session lifecycle operation"),
    );
    expect(sessionStoreMocks.currentEntry).toMatchObject({
      sessionId: "failed-session",
      mainRestartRecovery: { tombstone: { reason: "automatic recovery exhausted" } },
    });
  });

  it.each(["session", "cycle"] as const)("notifies again for a new recovery %s", async (change) => {
    await rejectInbound();
    if (change === "session") {
      sessionStoreMocks.currentEntry!.sessionId = "replacement-session";
    } else {
      sessionStoreMocks.currentEntry!.mainRestartRecovery = {
        ...sessionStoreMocks.currentEntry!.mainRestartRecovery!,
        cycleId: "replacement-cycle",
      };
    }
    await rejectInbound();
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("keeps model-locked recovery guidance actionable", async () => {
    sessionStoreMocks.currentEntry!.modelSelectionLocked = true;
    await rejectInbound();
    expect(deliver).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        text: expect.stringContaining("WebChat and use Resume."),
      }),
      expect.objectContaining({ kind: "final" }),
    );
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

  it.each([
    { label: "unauthorized inbound", context: { InboundAccessAuthorized: false } },
    { label: "explicit send-policy denial", sendPolicy: "deny" as const },
    { label: "ACP privacy after waiting for admission", acp: true },
    { label: "send policy after waiting for admission", latePolicy: true },
  ])("does not notify for $label", async ({ context, sendPolicy, acp, latePolicy }) => {
    if (acp || latePolicy) {
      sessionStoreMocks.loadSessionEntry.mockImplementation(() => {
        if (acp) {
          acpMocks.readAcpSessionEntry.mockReturnValue({
            entry: { sessionId: "failed-session", spawnedBy: "agent:main:parent" },
            acp: { backend: "acpx", mode: "persistent" },
          });
        } else {
          sessionStoreMocks.currentEntry!.sendPolicy = "deny";
        }
        return sessionStoreMocks.currentEntry;
      });
    }
    await rejectInbound({ context, sendPolicy });
    expect(deliver).not.toHaveBeenCalled();
  });
});
