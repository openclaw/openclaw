// Loaded with the dispatch suite so released visibility contracts share its mocked module graph.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import type { ReplyPayload } from "../types.js";
import { createDispatcher, hookMocks } from "./dispatch-from-config.shared.test-harness.js";
import {
  automaticGroupReplyConfig,
  dispatchReplyFromConfig,
  setNoAbort,
  globalBeforeAll0,
  describe0BeforeEach0,
} from "./dispatch-from-config.test-support.js";
import { createDispatchVerboseSession } from "./dispatch-from-config.verbose-session.test-support.js";
import { buildTestCtx } from "./test-ctx.js";

beforeAll(globalBeforeAll0);

describe("reply dispatch live visibility contracts", () => {
  beforeEach(describe0BeforeEach0);

  it.each(["sync", "async"] as const)(
    "reports live %s verbose progress visibility to the channel",
    async (mode) => {
      setNoAbort();
      const cfg = automaticGroupReplyConfig;
      const dispatcher = createDispatcher();
      const sessionKey = "agent:main:whatsapp:group:123@g.us";
      const ctx = buildTestCtx({
        ChatType: "group",
        From: "whatsapp:group:123@g.us",
        SessionKey: sessionKey,
      });

      await using session = await createDispatchVerboseSession(sessionKey, "on");
      let isActive: (() => boolean | Promise<boolean>) | undefined;
      let activeDuringRun: boolean | undefined;
      let activeAfterLevelChange: boolean | undefined;
      const replyResolver = async () => {
        activeDuringRun = await isActive?.();
        session.writeLevel("off");
        activeAfterLevelChange = await isActive?.();
        return { text: "done" } satisfies ReplyPayload;
      };

      await dispatchReplyFromConfig({
        ctx,
        cfg,
        dispatcher,
        replyResolver,
        replyOptions:
          mode === "async"
            ? {
                onVerboseProgressVisibilityAsync: (getter: () => Promise<boolean>) => {
                  isActive = getter;
                },
              }
            : {
                onVerboseProgressVisibility: (getter: () => boolean) => {
                  isActive = getter;
                },
              },
      });

      expect(activeDuringRun).toBe(true);
      expect(activeAfterLevelChange).toBe(false);

      let isActiveOff: (() => boolean | Promise<boolean>) | undefined;
      let activeDuringOffRun: boolean | undefined;
      await dispatchReplyFromConfig({
        ctx,
        cfg,
        dispatcher: createDispatcher(),
        replyResolver: async () => {
          activeDuringOffRun = await isActiveOff?.();
          return { text: "done" } satisfies ReplyPayload;
        },
        replyOptions:
          mode === "async"
            ? {
                onVerboseProgressVisibilityAsync: (getter: () => Promise<boolean>) => {
                  isActiveOff = getter;
                },
              }
            : {
                onVerboseProgressVisibility: (getter: () => boolean) => {
                  isActiveOff = getter;
                },
              },
      });

      expect(activeDuringOffRun).toBe(false);
    },
  );

  it.each(["sync", "async"] as const)(
    "exposes live %s group tool-summary state to reply_dispatch hooks",
    async (mode) => {
      // Group policy needs the loaded fixture's conversation grammar.
      setActivePluginRegistry(createSessionConversationTestRegistry());
      setNoAbort();
      const dispatcher = createDispatcher();
      const sessionKey = "agent:main:matrix:group:!room:test";
      const ctx = buildTestCtx({
        Provider: "matrix",
        Surface: "matrix",
        ChatType: "group",
        From: "matrix:!room:test",
        SessionKey: sessionKey,
      });
      await using session = await createDispatchVerboseSession(sessionKey, "off");
      let initialHookState: boolean | undefined;
      let updatedHookState: boolean | undefined;
      hookMocks.runner.runReplyDispatch.mockImplementationOnce(async (event: unknown) => {
        const replyDispatchEvent = event as {
          shouldSendToolSummaries: boolean;
          shouldSendToolSummariesAsync: () => Promise<boolean>;
        };
        initialHookState =
          mode === "async"
            ? await replyDispatchEvent.shouldSendToolSummariesAsync()
            : replyDispatchEvent.shouldSendToolSummaries;
        session.writeLevel("on");
        updatedHookState =
          mode === "async"
            ? await replyDispatchEvent.shouldSendToolSummariesAsync()
            : replyDispatchEvent.shouldSendToolSummaries;
        return undefined;
      });

      await dispatchReplyFromConfig({
        ctx,
        cfg: automaticGroupReplyConfig,
        dispatcher,
        replyResolver: async () => ({ text: "hi" }) satisfies ReplyPayload,
        replyOptions: { suppressDefaultToolProgressMessages: true },
      });

      expect(initialHookState).toBe(false);
      expect(updatedHookState).toBe(true);
      expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
    },
  );
});
