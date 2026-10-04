import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { markCommandReplyForDelivery } from "../auto-reply/reply-payload.js";
import { maybeHandleResetCommand } from "../auto-reply/reply/commands-reset.js";
import type { HandleCommandsParams } from "../auto-reply/reply/commands-types.js";
import { parseInlineSessionDirectives } from "../auto-reply/reply/directive-handling.parse.js";
import { dispatchReplyFromConfig } from "../auto-reply/reply/dispatch-from-config.js";
import { createReplyDispatcher } from "../auto-reply/reply/reply-dispatcher.js";
import {
  createReplyOperation,
  replyRunRegistry,
  retainReplyOperationUntilComplete,
} from "../auto-reply/reply/reply-run-registry.js";
import { buildTestCtx } from "../auto-reply/reply/test-ctx.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { beginSessionWorkAdmission } from "../sessions/session-lifecycle-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { performGatewaySessionReset } from "./session-reset-service.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  getGatewayConfigModule,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

beforeAll(async () => {
  const runs = await vi.importActual<typeof import("../agents/embedded-agent-runner/runs.js")>(
    "../agents/embedded-agent-runner/runs.js",
  );
  vi.doMock("../agents/embedded-agent-runner/runs.js", () => runs);
  vi.doMock("/src/agents/embedded-agent-runner/runs.js", () => runs);
});
const { sessionKey } = vi.hoisted(() => ({
  sessionKey: "agent:main:acp:binding:discord:default:feedface",
}));
vi.mock("../auto-reply/reply/commands-acp/targets.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../auto-reply/reply/commands-acp/targets.js")>();
  return {
    ...actual,
    resolveBoundAcpThreadSessionKey: async () => sessionKey,
  };
});

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();
afterEach(() => closeOpenClawStateDatabaseForTest());

test.each(["/new", "/reset"])(
  "bound ACP %s delivers its acknowledgement after committing reset",
  async (body) => {
    const { storePath } = await createSessionStoreDir();
    await writeSessionStore({
      entries: {
        [sessionKey]: sessionStoreEntry("reset-initiator", {
          lifecycleRevision: "before",
          totalTokens: 42,
        }),
      },
    });
    const { getRuntimeConfig } = await getGatewayConfigModule();
    const cfg = getRuntimeConfig();
    const delivered: string[] = [];
    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload.text ?? "");
      },
    });
    const ctx = buildTestCtx({
      Body: body,
      BodyForAgent: body,
      BodyForCommands: body,
      CommandBody: body,
      SessionKey: sessionKey,
      Provider: "discord",
      Surface: "discord",
      CommandAuthorized: true,
    });
    let initiator: ReturnType<typeof replyRunRegistry.get>;
    try {
      const result = await dispatchReplyFromConfig({
        ctx,
        cfg,
        dispatcher,
        replyResolver: async (commandCtx, opts) => {
          initiator = replyRunRegistry.get(sessionKey);
          expect(initiator).toBeDefined();
          let competitorInterrupted = false;
          const competitor = await beginSessionWorkAdmission({
            scope: storePath,
            identities: [sessionKey, "reset-initiator"],
            assertAllowed: () => {},
            onInterrupt: () => {
              competitorInterrupted = true;
              competitor.release();
            },
          });
          const params: HandleCommandsParams = {
            ctx: commandCtx,
            cfg,
            opts,
            command: {
              rawBodyNormalized: body,
              commandBodyNormalized: body,
              isAuthorizedSender: true,
              senderIsOwner: true,
              senderId: "synthetic",
              channel: "discord",
              channelId: "discord",
              surface: "discord",
              ownerList: [],
              from: "synthetic",
              to: "synthetic",
              resetHookTriggered: false,
            },
            directives: parseInlineSessionDirectives(""),
            elevated: { enabled: true, allowed: true, failures: [] },
            sessionKey,
            agentId: "main",
            workspaceDir: "/tmp/synthetic-reset",
            defaultGroupActivation: () => "mention",
            resolvedVerboseLevel: "off",
            resolvedReasoningLevel: "off",
            resolveDefaultThinkingLevel: async () => undefined,
            provider: "synthetic",
            model: "synthetic",
            contextTokens: 0,
            isGroup: false,
          };
          const reset = await maybeHandleResetCommand(params);
          expect(competitorInterrupted).toBe(true);
          expect(competitor.isActive()).toBe(false);
          expect(initiator?.abortSignal.aborted).toBe(false);
          return markCommandReplyForDelivery(reset?.reply);
        },
      });
      await dispatcher.waitForIdle();
      expect(result.queuedFinal).toBe(true);
      expect(delivered).toEqual(["✅ ACP session reset in place."]);
      const entry = loadSessionEntry({ storePath, sessionKey });
      expect(entry?.lifecycleRevision).not.toBe("before");
      expect(entry?.totalTokens).toBe(0);
      expect(replyRunRegistry.get(sessionKey)).toBeUndefined();
      const next = createReplyDispatcher({
        deliver: async (payload) => {
          delivered.push(payload.text ?? "");
        },
      });
      const nextResult = await dispatchReplyFromConfig({
        ctx: buildTestCtx({
          Body: "next",
          SessionKey: sessionKey,
          Provider: "discord",
          Surface: "discord",
        }),
        cfg,
        dispatcher: next,
        replyResolver: async () => ({ text: "next turn" }),
      });
      await next.waitForIdle();
      expect(nextResult.queuedFinal).toBe(true);
      expect(delivered.at(-1)).toBe("next turn");
    } finally {
      initiator?.complete();
    }
  },
);

test.each(["settled", "timeout"])(
  "external reset cancels another reply and fails closed until %s",
  async (outcome) => {
    const { storePath } = await createSessionStoreDir();
    await writeSessionStore({
      entries: {
        [sessionKey]: sessionStoreEntry("external-reset", {
          lifecycleRevision: "before",
          totalTokens: 42,
        }),
      },
    });
    const operation = createReplyOperation({
      sessionKey,
      sessionId: "external-reset",
      resetTriggered: false,
    });
    retainReplyOperationUntilComplete(operation);
    const aborted = createDeferredCore();
    operation.abortSignal.addEventListener("abort", () => aborted.resolve(), { once: true });
    try {
      if (outcome === "timeout") {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      }
      const reset = performGatewaySessionReset({
        key: sessionKey,
        reason: "reset",
        commandSource: "synthetic-external",
        operatorRoleActor: { kind: "system" },
        workerPlacementContext: {},
      });
      await aborted.promise;
      expect(operation.abortSignal.aborted).toBe(true);
      expect(loadSessionEntry({ storePath, sessionKey })?.lifecycleRevision).toBe("before");
      if (outcome === "timeout") {
        await vi.advanceTimersByTimeAsync(15_001);
        expect(await reset).toMatchObject({
          ok: false,
          error: { message: expect.stringContaining("still active") },
        });
        expect(loadSessionEntry({ storePath, sessionKey })?.lifecycleRevision).toBe("before");
      } else {
        operation.complete();
        expect(await reset).toMatchObject({ ok: true });
        expect(loadSessionEntry({ storePath, sessionKey })?.lifecycleRevision).not.toBe("before");
      }
    } finally {
      operation.complete();
      vi.useRealTimers();
    }
  },
);
