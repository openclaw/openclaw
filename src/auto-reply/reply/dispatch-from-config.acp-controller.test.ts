// ACP dispatch turns are session-controller turns on their ACP target session.
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
const cfg = {
  acp: { enabled: true, dispatch: { enabled: true } },
  session: { sendPolicy: { default: "allow" } },
} as OpenClawConfig;

/** Runtime turns block until the test releases them by prompt text. */
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
      ? {
          sessionKey,
          storeSessionKey: sessionKey,
          cfg: {},
          storePath: "/tmp/mock-sessions.json",
          entry,
          acp: {
            backend: "acpx",
            agent: "codex",
            runtimeSessionName: "runtime:controller",
            mode: "persistent",
            state: "idle",
            lastActivityAt: Date.now(),
          },
        }
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
  // Ingress reserves the mailbox input on arrival; dispatch reuses the reservation.
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
    hookMocks.runner.hasHooks.mockReset();
    hookMocks.runner.hasHooks.mockImplementation(
      (hookName?: string) => hookName === "reply_dispatch",
    );
    hookMocks.runner.runBeforeDispatch.mockReset().mockResolvedValue(undefined);
    hookMocks.runner.runReplyDispatch.mockReset();
    hookMocks.runner.runReplyDispatch.mockImplementation(async (event: unknown, ctx: unknown) => {
      replyDispatchEntries.push(String((event as { sessionKey?: string }).sessionKey));
      return (await tryDispatchAcpReplyHook(event as never, ctx as never)) ?? undefined;
    });
    hookMocks.runner.runInboundClaim.mockReset().mockResolvedValue(undefined);
    hookMocks.runner.runInboundClaimForPlugin.mockReset().mockResolvedValue(undefined);
    hookMocks.runner.runInboundClaimForPluginOutcome
      .mockReset()
      .mockResolvedValue({ status: "no_handler" });
    hookMocks.runner.runMessageReceived.mockReset();
    internalHookMocks.createInternalHookEvent.mockReset();
    internalHookMocks.createInternalHookEvent.mockImplementation(createInternalHookEventPayload);
    internalHookMocks.triggerInternalHook.mockReset();
    sessionStoreMocks.currentEntry = undefined;
    sessionStoreMocks.entriesBySessionKey.clear();
    const readSessionEntry = (scope: unknown) => {
      if (
        !scope ||
        typeof scope !== "object" ||
        !("sessionKey" in scope) ||
        typeof scope.sessionKey !== "string"
      ) {
        throw new Error("Expected session lookup scope");
      }
      return sessionStoreMocks.entriesBySessionKey.get(scope.sessionKey);
    };
    sessionStoreMocks.loadSessionEntry.mockReset().mockImplementation(readSessionEntry);
    sessionStoreMocks.loadSessionStoreEntry.mockReset().mockImplementation(readSessionEntry);
    sessionStoreMocks.resolveSessionStorePathCore
      .mockReset()
      .mockReturnValue("/tmp/mock-sessions.json");
    acpMocks.listAcpSessionEntries.mockReset().mockResolvedValue([]);
    acpMocks.readAcpSessionEntry.mockReset().mockReturnValue(null);
    acpMocks.upsertAcpSessionMeta.mockReset().mockResolvedValue(null);
    acpMocks.requireAcpRuntimeBackend.mockReset();
    sessionBindingMocks.listBySession.mockReset().mockReturnValue([]);
    sessionBindingMocks.resolveByConversation.mockReset().mockReturnValue(null);
  });

  it("queues a channel ACP prompt behind a running ACP turn in the session mailbox", async () => {
    mockAcpSession(acpKey);
    const gated = createGatedRuntime();
    acpMocks.requireAcpRuntimeBackend.mockReturnValue({ id: "acpx", runtime: gated.runtime });
    // An agent RPC turn holds the session without a channel dispatch admission ticket.
    const agentTurn = manager.runTurn({
      admittedRunContext: createTestAdmittedRunContext("agent-run"),
      cfg,
      sessionKey: acpKey,
      provenance: "system",
      text: "agent",
      mode: "prompt",
      requestId: "agent-run",
    });
    let prompt: ReturnType<typeof dispatchTo> | undefined;
    try {
      await gated.entered("agent", agentTurn);
      let input: SessionControllerInput | undefined;
      prompt = dispatchTo(acpKey, "prompt", {
        onSourceReserved: (reserved) => {
          input = reserved;
        },
      });
      // The prompt waits for its mailbox claim; it never enters a turn beside the agent turn.
      await vi.waitFor(() => expect(input?.phase).toBe("waiting"), { timeout: 10_000 });
      expect(replyDispatchEntries).toEqual([]);
      gated.release("agent");
      await agentTurn;
      await gated.entered("prompt", prompt);
      gated.release("prompt");
      await prompt;
      expect(gated.started).toEqual(["agent", "prompt"]);
    } finally {
      gated.release("agent");
      gated.release("prompt");
      await Promise.allSettled([agentTurn, prompt]);
    }
  });

  it("serializes a bound conversation's ACP turn on the target session controller", async () => {
    const sourceKey = "agent:main:discord:channel:C1";
    mockAcpSession(acpKey);
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "binding-controller",
      targetSessionKey: acpKey,
      targetKind: "session",
      status: "active",
      boundAt: Date.now(),
      conversation: { channel: "discord", accountId: "default", conversationId: "C1" },
    });
    const gated = createGatedRuntime();
    acpMocks.requireAcpRuntimeBackend.mockReturnValue({ id: "acpx", runtime: gated.runtime });
    const bound = dispatchTo(sourceKey, "bound");
    let direct: ReturnType<typeof dispatchTo> | undefined;
    try {
      await gated.entered("bound", bound);
      sessionBindingMocks.resolveByConversation.mockReturnValue(null);
      direct = dispatchTo(acpKey, "direct");
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      // The source-keyed dispatch holds the target's controller turn, not only its runtime actor.
      expect(replyDispatchEntries).toEqual([acpKey]);
      gated.release("bound");
      await bound;
      await gated.entered("direct", direct);
      gated.release("direct");
      await direct;
      expect(gated.started).toEqual(["bound", "direct"]);
    } finally {
      gated.release("bound");
      gated.release("direct");
      await Promise.allSettled([bound, direct]);
    }
  });
});
