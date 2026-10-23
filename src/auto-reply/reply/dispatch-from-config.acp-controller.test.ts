import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { createTestAdmittedRunContext } from "../../agents/admitted-run-context.test-support.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { AcpRuntimeEvent } from "../../plugin-sdk/acp-runtime.js";
import type { SessionControllerInput } from "../../sessions/session-controller.mailbox.js";
import { createInternalHookEventPayload } from "../../test-utils/internal-hook-event-payload.js";
import { completeAcpSessionFixture } from "./dispatch-from-config.acp-fixture.test-support.js";
import {
  acpManagerRuntimeMocks,
  acpMocks,
  createDispatcher,
  hookMocks,
  internalHookMocks,
  mocks,
  noAbortResult,
  resetPluginTtsAndThreadMocks,
  sessionBindingMocks,
  sessionStoreMocks,
  setDiscordTestRegistry,
} from "./dispatch-from-config.shared.test-harness.js";
import { createAcpRuntime } from "./dispatch-from-config.test-support.js";
import { prepareReplySourceInput } from "./reply-source-binding.js";
import { buildTestCtx } from "./test-ctx.js";

let dispatchReplyFromConfig: typeof import("./dispatch-from-config.js").dispatchReplyFromConfig;
let tryDispatchAcpReplyHook: typeof import("../../plugin-sdk/acpx.js").tryDispatchAcpReplyHook;
let resetInboundDedupe: typeof import("./inbound-dedupe.js").resetInboundDedupe;
let controllerTesting: typeof import("../../sessions/session-controller.test-support.js").testing;
// Loaded after the harness mocks so the real manager reads the mocked ACP metadata.
let AcpSessionManager: typeof import("../../acp/control-plane/manager.core.js").AcpSessionManager;
let acpManagerDeps: typeof import("../../acp/control-plane/manager.types.js").DEFAULT_DEPS;

const acpKey = "agent:codex:acp:controller-turns";
const hooks = hookMocks.runner;
const store = sessionStoreMocks;
const cfg = {
  acp: { enabled: true, dispatch: { enabled: true } },
  session: { sendPolicy: { default: "allow" } },
} as OpenClawConfig;

function createGatedRuntime() {
  const started: string[] = [];
  const entered = new Map<string, ReturnType<typeof createDeferred<void>>>();
  const released = new Map<string, ReturnType<typeof createDeferred<void>>>();
  const gate = (map: typeof entered, text: string) => {
    const deferred = map.get(text) ?? createDeferred();
    map.set(text, deferred);
    return deferred;
  };
  const runtime = createAcpRuntime([]);
  runtime.runTurn.mockImplementation(async function* (input) {
    started.push(input.text);
    gate(entered, input.text).resolve();
    await gate(released, input.text).promise;
    yield { type: "done" } as AcpRuntimeEvent;
  });
  return {
    runtime,
    started,
    entered: (text: string, work: Promise<unknown>) =>
      awaitGateBeforeSettlement(
        gate(entered, text).promise,
        work,
        `ACP work settled before runtime entry: ${text}`,
      ),
    release: (text: string) => gate(released, text).resolve(),
  };
}

function mockAcpSession(sessionKey: string) {
  const entry = { sessionId: "acp-session-id", updatedAt: Date.now() };
  sessionStoreMocks.entriesBySessionKey.set(sessionKey, entry);
  acpMocks.readAcpSessionEntry.mockImplementation((params: { sessionKey: string }) =>
    params.sessionKey === sessionKey
      ? completeAcpSessionFixture(
          {
            entry,
            acp: {
              agent: "codex",
              runtimeSessionName: "runtime:controller",
              lastActivityAt: Date.now(),
            },
          },
          { sessionKey, storePath: "/tmp/mock-sessions.json" },
        )
      : null,
  );
}

function dispatchTo(
  sessionKey: string,
  body: string,
  options: { onSourceReserved?: (input: SessionControllerInput) => void } = {},
) {
  const ctx = buildTestCtx({
    Provider: "discord",
    Surface: "discord",
    OriginatingChannel: "discord",
    AccountId: "default",
    To: "C1",
    SessionKey: sessionKey,
    BodyForAgent: body,
  });
  const source = prepareReplySourceInput(ctx, cfg, {});
  if (source.input) {
    options.onSourceReserved?.(source.input);
  }
  return dispatchReplyFromConfig({
    ctx,
    cfg,
    dispatcher: createDispatcher(),
    replyOptions: source.options,
  });
}

describe("dispatchReplyFromConfig ACP controller turns", () => {
  beforeAll(async () => {
    ({ dispatchReplyFromConfig } = await import("./dispatch-from-config.js"));
    ({ tryDispatchAcpReplyHook } = await import("../../plugin-sdk/acpx.js"));
    ({ resetInboundDedupe } = await import("./inbound-dedupe.js"));
    ({ testing: controllerTesting } =
      await import("../../sessions/session-controller.test-support.js"));
    ({ AcpSessionManager } = await import("../../acp/control-plane/manager.core.js"));
    ({ DEFAULT_DEPS: acpManagerDeps } = await import("../../acp/control-plane/manager.types.js"));
  });

  let replyDispatchEntries: string[];
  let manager: InstanceType<typeof AcpSessionManager>;

  beforeEach(() => {
    setDiscordTestRegistry();
    controllerTesting.resetSessionControllerForTest();
    resetInboundDedupe();
    resetPluginTtsAndThreadMocks();
    mocks.tryFastAbortFromMessage.mockResolvedValue(noAbortResult);
    acpManagerRuntimeMocks.getAcpSessionManager.mockReset();
    manager = new AcpSessionManager({
      ...acpManagerDeps,
      prepareSessionControlRead: async (params) => {
        const readCurrent = async () => {
          params.assertCurrent?.();
          const session = completeAcpSessionFixture(acpMocks.readAcpSessionEntry(params), {
            ...params,
            storePath: sessionStoreMocks.resolveSessionStorePathCore(),
          });
          if (!session) {
            throw new Error(`Expected ACP session fixture: ${params.sessionKey}`);
          }
          return { session, entry: session.entry };
        };
        return {
          initialRead: await readCurrent(),
          readCurrent,
          assertCurrent: () => params.assertCurrent?.(),
          release: () => {},
        };
      },
    });
    acpManagerRuntimeMocks.getAcpSessionManager.mockReturnValue(manager);
    replyDispatchEntries = [];
    hooks.hasHooks.mockReset().mockImplementation((name?: string) => name === "reply_dispatch");
    hooks.runBeforeDispatch.mockReset().mockResolvedValue(undefined);
    hooks.runReplyDispatch.mockReset().mockImplementation(async (event: unknown, ctx: unknown) => {
      replyDispatchEntries.push(String((event as { sessionKey?: string }).sessionKey));
      return (await tryDispatchAcpReplyHook(event as never, ctx as never)) ?? undefined;
    });
    for (const hook of [hooks.runInboundClaim, hooks.runInboundClaimForPlugin]) {
      hook.mockReset().mockResolvedValue(undefined);
    }
    hooks.runInboundClaimForPluginOutcome.mockReset().mockResolvedValue({ status: "no_handler" });
    hooks.runMessageReceived.mockReset();
    internalHookMocks.createInternalHookEvent
      .mockReset()
      .mockImplementation(createInternalHookEventPayload);
    internalHookMocks.triggerInternalHook.mockReset();
    store.currentEntry = undefined;
    store.entriesBySessionKey.clear();
    const readSessionEntry = (scope: unknown) => {
      if (
        !scope ||
        typeof scope !== "object" ||
        !("sessionKey" in scope) ||
        typeof scope.sessionKey !== "string"
      ) {
        throw new Error("Expected session lookup scope");
      }
      return store.entriesBySessionKey.get(scope.sessionKey);
    };
    for (const load of [store.loadSessionEntry, store.loadSessionStoreEntry]) {
      load.mockReset().mockImplementation(readSessionEntry);
    }
    store.resolveSessionStorePathCore.mockReset().mockReturnValue("/tmp/mock-sessions.json");
    acpMocks.listAcpSessionEntries.mockReset().mockResolvedValue([]);
    acpMocks.readAcpSessionEntry.mockReset().mockReturnValue(null);
    acpMocks.upsertAcpSessionMeta.mockReset().mockResolvedValue(null);
    acpMocks.requireAcpRuntimeBackend.mockReset();
    sessionBindingMocks.listBySession.mockReset().mockReturnValue([]);
    sessionBindingMocks.resolveByConversation.mockReset().mockReturnValue(null);
  });

  it.each(["agent", "bound"] as const)(
    "serializes channel dispatch behind a %s ACP turn",
    async (first) => {
      mockAcpSession(acpKey);
      const gated = createGatedRuntime();
      acpMocks.requireAcpRuntimeBackend.mockReturnValue({ id: "acpx", runtime: gated.runtime });
      if (first === "bound") {
        sessionBindingMocks.resolveByConversation.mockReturnValue({
          bindingId: "binding-controller",
          targetSessionKey: acpKey,
          targetKind: "session",
          status: "active",
          boundAt: Date.now(),
          conversation: { channel: "discord", accountId: "default", conversationId: "C1" },
        });
      }
      const firstTurn =
        first === "bound"
          ? dispatchTo("agent:main:discord:channel:C1", first)
          : manager.runTurn({
              admittedRunContext: createTestAdmittedRunContext("agent-run"),
              cfg,
              sessionKey: acpKey,
              provenance: "system",
              text: "agent",
              mode: "prompt",
              requestId: "agent-run",
            });
      const second = first === "agent" ? "prompt" : "direct";
      let pending: ReturnType<typeof dispatchTo> | undefined;
      try {
        await gated.entered(first, firstTurn);
        sessionBindingMocks.resolveByConversation.mockReturnValue(null);
        let input: SessionControllerInput | undefined;
        pending = dispatchTo(acpKey, second, {
          onSourceReserved: (reserved) => {
            input = reserved;
          },
        });
        if (first === "agent") {
          await vi.waitFor(() => expect(input?.phase).toBe("waiting"), { timeout: 10_000 });
        } else {
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
        }
        expect(replyDispatchEntries).toEqual(first === "agent" ? [] : [acpKey]);
        gated.release(first);
        await firstTurn;
        await gated.entered(second, pending);
        gated.release(second);
        await pending;
        expect(gated.started).toEqual([first, second]);
      } finally {
        gated.release(first);
        gated.release(second);
        await Promise.allSettled([firstTurn, pending]);
      }
    },
  );
});
