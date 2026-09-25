// Exec-steering settlement tests: a steered completion is acknowledged only once
// the reply that folded it in is delivered, and released otherwise.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAgentHarnesses } from "../../agents/harness/registry.js";
import { withReplyDispatcher } from "../dispatch-dispatcher.js";
import { setReplyPayloadMetadata } from "../reply-payload.js";
import { isExecSteeringReplySettled } from "./dispatch-from-config.exec-steering.js";
import { buildNoVisibleReplyFallbackText } from "./dispatch-from-config.payloads.js";
import {
  createHookCtx,
  emptyConfig,
  hookMocks,
  mocks,
  resetPluginTtsAndThreadMocks,
  sessionStoreMocks,
  setDiscordTestRegistry,
} from "./dispatch-from-config.shared.test-harness.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";

let dispatchReplyFromConfig: typeof import("./dispatch-from-config.js").dispatchReplyFromConfig;
let resetInboundDedupe: typeof import("./inbound-dedupe.js").resetInboundDedupe;
let resetReplyRunRegistry: typeof import("./reply-run-registry.test-support.js").testing.resetReplyRunRegistry;

beforeAll(async () => {
  ({ dispatchReplyFromConfig } = await import("./dispatch-from-config.js"));
  ({ resetInboundDedupe } = await import("./inbound-dedupe.js"));
  ({
    testing: { resetReplyRunRegistry },
  } = await import("./reply-run-registry.test-support.js"));
});

beforeEach(() => {
  clearAgentHarnesses();
  resetReplyRunRegistry();
  resetInboundDedupe();
  setDiscordTestRegistry();
  resetPluginTtsAndThreadMocks();
  hookMocks.runner.hasHooks.mockReset().mockReturnValue(false);
  mocks.routeReply.mockReset().mockResolvedValue({ ok: true, delivered: true, messageId: "mock" });
  sessionStoreMocks.currentEntry = undefined;
  sessionStoreMocks.loadSessionStoreEntry
    .mockReset()
    .mockImplementation(() => sessionStoreMocks.currentEntry);
  sessionStoreMocks.loadSessionStore.mockReset().mockReturnValue({});
  sessionStoreMocks.readSessionEntry
    .mockReset()
    .mockImplementation(() => sessionStoreMocks.currentEntry);
  sessionStoreMocks.resolveSessionStorePathCore
    .mockReset()
    .mockReturnValue("/tmp/mock-sessions.json");
  sessionStoreMocks.resolveSessionStoreEntry.mockReset().mockReturnValue({ existing: undefined });
  sessionStoreMocks.updateSessionEntry.mockClear();
});

afterEach(() => {
  resetReplyRunRegistry();
  resetInboundDedupe();
  clearAgentHarnesses();
});

describe("exec-steering delivery settlement", () => {
  it("acknowledges a steered completion after its final reply is delivered", async () => {
    const order: string[] = [];
    const settle = vi.fn((delivered: boolean) => {
      order.push(`settle:${delivered}`);
    });
    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        order.push(`deliver:${payload.text}`);
      },
    });

    await withReplyDispatcher({
      dispatcher,
      run: () =>
        dispatchReplyFromConfig({
          ctx: createHookCtx(),
          cfg: emptyConfig,
          dispatcher,
          replyResolver: async (_ctx, opts) => {
            opts?.onPendingExecSteering?.({ settle });
            return { text: "The build finished." };
          },
        }),
    });

    expect(order).toEqual(["deliver:The build finished.", "settle:true"]);
  });

  it("releases a steered completion when the final send fails", async () => {
    const settle = vi.fn();
    const dispatcher = createReplyDispatcher({
      deliver: async () => {
        throw Object.assign(new Error("offline"), { code: "ECONNREFUSED" });
      },
    });

    await withReplyDispatcher({
      dispatcher,
      run: () =>
        dispatchReplyFromConfig({
          ctx: createHookCtx(),
          cfg: emptyConfig,
          dispatcher,
          replyResolver: async (_ctx, opts) => {
            opts?.onPendingExecSteering?.({ settle });
            return { text: "The build finished." };
          },
        }),
    });

    expect(settle).toHaveBeenCalledExactlyOnceWith(false);
  });

  it.each([true, false])(
    "settles a routed reply from its delivered receipt (%s)",
    async (delivered) => {
      const settle = vi.fn();
      const deliver = vi.fn();
      const dispatcher = createReplyDispatcher({ deliver });
      const ctx = createHookCtx();
      Object.assign(ctx, { OriginatingChannel: "discord", OriginatingTo: "user:1" });
      mocks.routeReply.mockResolvedValue({ ok: true, delivered, messageId: "routed" });

      await withReplyDispatcher({
        dispatcher,
        run: () =>
          dispatchReplyFromConfig({
            ctx,
            cfg: emptyConfig,
            dispatcher,
            replyResolver: async (_ctx, opts) => {
              opts?.onPendingExecSteering?.({ settle });
              return { text: "The build finished." };
            },
          }),
      });

      expect(deliver).not.toHaveBeenCalled();
      expect(settle).toHaveBeenCalledExactlyOnceWith(delivered);
    },
  );

  it("releases a steered completion when session-writer delivery is revoked", async () => {
    const reply = setReplyPayloadMetadata(
      { text: "The build finished." },
      {
        sessionWriterDeliveryAuthority: {
          agentId: "main",
          expectedLifecycleRevision: "revision-before-replacement",
          expectedSessionId: "session-1",
          expectedWriterRunId: "run-before-replacement",
          sessionKey: "agent:test:session",
          storePath: "/tmp/mock-sessions.json",
        },
      },
    );
    sessionStoreMocks.currentEntry = {
      sessionId: "session-1",
      lifecycleRevision: "revision-after-replacement",
      activeWriterRunId: "run-after-replacement",
    };
    const settle = vi.fn();
    const deliver = vi.fn();
    const dispatcher = createReplyDispatcher({ deliver });

    await withReplyDispatcher({
      dispatcher,
      run: () =>
        dispatchReplyFromConfig({
          ctx: createHookCtx(),
          cfg: emptyConfig,
          dispatcher,
          replyResolver: async (_ctx, opts) => {
            opts?.onPendingExecSteering?.({ settle });
            return reply;
          },
        }),
    });

    expect(deliver).not.toHaveBeenCalled();
    expect(settle).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("releases a steered completion when the resolver fails before finalization", async () => {
    const settle = vi.fn();
    const dispatcher = createReplyDispatcher({ deliver: vi.fn() });
    const failure = new Error("run failed after dispatch");

    await expect(
      withReplyDispatcher({
        dispatcher,
        run: () =>
          dispatchReplyFromConfig({
            ctx: createHookCtx(),
            cfg: emptyConfig,
            dispatcher,
            replyResolver: async (_ctx, opts) => {
              opts?.onPendingExecSteering?.({ settle });
              throw failure;
            },
          }),
      }),
    ).rejects.toThrow(failure);

    expect(settle).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("keeps a steered completion when only the no-visible-reply notice is delivered", async () => {
    const settle = vi.fn();
    const delivered: string[] = [];
    const dispatcher = createReplyDispatcher({
      beforeDeliver: (payload) => (payload.text === "The build finished." ? null : payload),
      deliver: async (payload) => {
        delivered.push(payload.text ?? "");
      },
    });
    const ctx = createHookCtx();
    Object.assign(ctx, {
      Provider: "discord",
      Surface: "discord",
      SessionKey: "agent:main:discord:direct:owner",
      CommandSource: "native",
    });

    const result = await withReplyDispatcher({
      dispatcher,
      run: () =>
        dispatchReplyFromConfig({
          ctx,
          cfg: emptyConfig,
          dispatcher,
          replyResolver: async (_ctx, opts) => {
            opts?.onPendingExecSteering?.({ settle });
            return { text: "The build finished." };
          },
        }),
    });

    // The turn-wide ledger now holds a delivered terminal notice; the
    // completion-bearing final itself was cancelled, so the receipt releases.
    expect(result.noVisibleReplyFallbackDelivered).toBe(true);
    expect(delivered.some((text) => text.includes(buildNoVisibleReplyFallbackText()))).toBe(true);
    expect(delivered).not.toContain("The build finished.");
    expect(settle).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("keeps a steered completion when a message-tool-only turn confirmed no send", async () => {
    const settle = vi.fn();
    const deliver = vi.fn();
    const dispatcher = createReplyDispatcher({ deliver });

    await withReplyDispatcher({
      dispatcher,
      run: () =>
        dispatchReplyFromConfig({
          ctx: createHookCtx(),
          cfg: emptyConfig,
          dispatcher,
          replyOptions: { sourceReplyDeliveryMode: "message_tool_only" },
          replyResolver: async (_ctx, opts) => {
            opts?.onPendingExecSteering?.({ settle });
            return { text: "The build finished." };
          },
        }),
    });

    expect(deliver).not.toHaveBeenCalled();
    expect(settle).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("settles every receipt a multi-attempt turn handed over", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const dispatcher = createReplyDispatcher({ deliver: vi.fn() });

    await withReplyDispatcher({
      dispatcher,
      run: () =>
        dispatchReplyFromConfig({
          ctx: createHookCtx(),
          cfg: emptyConfig,
          dispatcher,
          replyResolver: async (_ctx, opts) => {
            opts?.onPendingExecSteering?.({ settle: first });
            opts?.onPendingExecSteering?.({ settle: second });
            return { text: "The build finished." };
          },
        }),
    });

    expect(first).toHaveBeenCalledExactlyOnceWith(true);
    expect(second).toHaveBeenCalledExactlyOnceWith(true);
  });
});

describe("isExecSteeringReplySettled", () => {
  it.each([
    { name: "delivered final", replies: [{ text: "done" }], finals: [true], expected: true },
    { name: "failed final", replies: [{ text: "done" }], finals: [false], expected: false },
    {
      name: "one of two finals delivered",
      replies: [{ text: "a" }, { text: "b" }],
      finals: [false, true],
      expected: true,
    },
    { name: "final never sent", replies: [{ text: "done" }], finals: [], expected: false },
    { name: "deliberate silent reply", replies: [], finals: [], expected: true },
    { name: "whitespace-only reply", replies: [{ text: "  " }], finals: [], expected: true },
    { name: "finalization never reached", replies: undefined, finals: [true], expected: false },
  ] as const)("$name -> $expected", ({ replies, finals, expected }) => {
    expect(
      isExecSteeringReplySettled({
        replies: replies ? [...replies] : undefined,
        finalDelivered: [...finals],
        sourceReplyDelivered: false,
        messageToolOnly: false,
      }),
    ).toBe(expected);
  });

  it.each([
    { name: "confirmed current-source send", sourceReplyDelivered: true, expected: true },
    { name: "no confirmed send", sourceReplyDelivered: false, expected: false },
  ])("message-tool-only turn with $name -> $expected", ({ sourceReplyDelivered, expected }) => {
    for (const replies of [[], [{ text: "done" }]]) {
      expect(
        isExecSteeringReplySettled({
          replies,
          finalDelivered: [],
          sourceReplyDelivered,
          messageToolOnly: true,
        }),
      ).toBe(expected);
    }
  });

  it("accepts the run's settled source delivery for a directly delivered reply", () => {
    expect(
      isExecSteeringReplySettled({
        replies: [{ text: "done" }],
        finalDelivered: [],
        sourceReplyDelivered: true,
        messageToolOnly: false,
      }),
    ).toBe(true);
  });
});
