import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  testing as sessionBindingTesting,
  type SessionBindingRecord,
} from "../../infra/outbound/session-binding-service.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { finalizeInboundContext } from "./inbound-context.js";
import { initSessionState, resolveReplySessionPreprocessingState } from "./session.js";
import { readSessionStore } from "./test/session.test-support.js";

vi.mock("../../plugins/hook-runner-global.js", () => ({ getGlobalHookRunner: () => null }));
vi.mock("../../infra/channel-summary.js", () => ({ buildChannelSummary: vi.fn(async () => []) }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => sessionBindingTesting.resetSessionBindingAdaptersForTests());
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
});

describe("reply session binding activity settlement", () => {
  it.each(["complete", "fail", "rebind-time", "rebind-kind"] as const)(
    "keeps preprocessing read-only and settles binding activity before initialization: %s",
    async (outcome) => {
      const mutation = createDeferred();
      const started = createDeferred();
      const replacementMutation = createDeferred();
      const replacementStarted = createDeferred();
      const inspection = createDeferred<SessionBindingRecord | null>();
      const inspectionStarted = createDeferred();
      const resolution = createDeferred<SessionBindingRecord | null>();
      const resolutionStarted = createDeferred();
      const touchAsync = vi
        .fn(async () => {})
        .mockImplementationOnce(() => {
          started.resolve();
          return mutation.promise;
        })
        .mockImplementationOnce(() => {
          replacementStarted.resolve();
          return replacementMutation.promise;
        });
      const storePath = path.join(tempDirs.make("openclaw-binding-activity-"), "sessions.json");
      const sessionKey = "agent:main:webchat:bound";
      const binding: SessionBindingRecord = {
        bindingId: "webchat:activity",
        targetSessionKey: sessionKey,
        targetKind: "session",
        conversation: { channel: "webchat", accountId: "default", conversationId: "activity" },
        status: "active",
        boundAt: 1,
      };
      let currentBinding = binding;
      registerSessionBindingAdapter({
        channel: "webchat",
        accountId: "default",
        resolveByConversation: () => {
          throw new Error("reply session must await binding reads");
        },
        inspectByConversationAsync: () => {
          inspectionStarted.resolve();
          return inspection.promise;
        },
        resolveByConversationAsync: vi
          .fn(async (): Promise<SessionBindingRecord | null> => currentBinding)
          .mockImplementationOnce(() => {
            resolutionStarted.resolve();
            return resolution.promise;
          }),
        listBySession: () => [binding],
        touchAsync,
      });
      const params = {
        ctx: finalizeInboundContext({
          Body: "hello",
          SessionKey: "agent:main:webchat:source",
          Provider: "webchat",
          Surface: "webchat",
          From: "activity",
          To: "activity",
          ChatType: "direct",
        }),
        cfg: { session: { store: storePath } },
        commandAuthorized: true,
      };
      const preprocessing = resolveReplySessionPreprocessingState(params);
      await inspectionStarted.promise;
      expect(touchAsync).not.toHaveBeenCalled();
      inspection.resolve(binding);
      expect((await preprocessing).sessionKey).toBe(sessionKey);
      expect(touchAsync).not.toHaveBeenCalled();
      const result = initSessionState(params);
      await Promise.race([resolutionStarted.promise, result]);
      expect(touchAsync).not.toHaveBeenCalled();
      expect(readSessionStore(storePath)[sessionKey]).toBeUndefined();
      resolution.resolve(binding);
      await started.promise;
      expect(readSessionStore(storePath)[sessionKey]).toBeUndefined();
      if (outcome === "fail") {
        const failure = expect(result).rejects.toThrow("activity failed");
        mutation.reject(new Error("activity failed"));
        await failure;
        expect(readSessionStore(storePath)[sessionKey]).toBeUndefined();
      } else {
        if (outcome === "rebind-time") {
          currentBinding = { ...binding, boundAt: 2 };
        } else if (outcome === "rebind-kind") {
          currentBinding = { ...binding, targetKind: "subagent" };
        }
        mutation.resolve();
        if (currentBinding !== binding) {
          await Promise.race([replacementStarted.promise, result]);
          expect(touchAsync).toHaveBeenCalledTimes(2);
          expect(readSessionStore(storePath)[sessionKey]).toBeUndefined();
          replacementMutation.resolve();
        }
        expect((await result).sessionKey).toBe(sessionKey);
        expect(readSessionStore(storePath)[sessionKey]?.sessionId).toBeTruthy();
      }
    },
  );

  it("rejects preprocessing when its binding owner disappears during inspection", async () => {
    const inspection = createDeferred<SessionBindingRecord | null>();
    const started = createDeferred();
    const adapter = {
      channel: "webchat",
      accountId: "default",
      resolveByConversation: () => {
        throw new Error("preprocessing must use read-only inspection");
      },
      inspectByConversationAsync: () => {
        started.resolve();
        return inspection.promise;
      },
      listBySession: () => [],
    };
    registerSessionBindingAdapter(adapter);
    const result = resolveReplySessionPreprocessingState({
      cfg: {
        session: { store: path.join(tempDirs.make("openclaw-binding-read-"), "sessions.json") },
      },
      ctx: finalizeInboundContext({
        Body: "hello",
        SessionKey: "agent:main:webchat:source",
        Provider: "webchat",
        Surface: "webchat",
        From: "activity",
        To: "activity",
        ChatType: "direct",
      }),
    });
    const failure = expect(result).rejects.toThrow("binding owner is temporarily unavailable");
    await started.promise;
    unregisterSessionBindingAdapter({ channel: "webchat", accountId: "default", adapter });
    inspection.resolve(null);
    await failure;
  });
});
