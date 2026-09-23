import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { annotateSourceDelivery } from "./message-action-execution.js";

const actionParams = {
  action: "thread-reply",
  to: "direct:user-1",
  threadId: "thread-1",
  message: "visible reply",
};

const input = {
  cfg: {},
  action: "thread-reply" as const,
  params: { channel: "testchat", ...actionParams },
  messageActionAuthorization: {
    requesterAccountId: "default",
    toolContext: {
      currentChannelProvider: "testchat" as const,
      currentChannelId: "direct:user-1",
      currentThreadTs: "thread-1",
    },
  },
  sessionKey: "agent:main:testchat:direct:user-1",
  defaultAccountId: "default",
};

const annotationParams = {
  cfg: {},
  params: actionParams,
  channel: "testchat" as const,
  accountId: "default",
  input,
  dryRun: false,
  channelPlugin: createChannelTestPluginBase({ id: "testchat" }),
  mediaAccess: { localRoots: [] },
};

afterEach(() => resetPluginRuntimeStateForTest());

describe("annotateSourceDelivery thread replies", () => {
  it.each([true, false, "error", "stale"] as const)(
    "awaits owner proof for a receiptless thread reply without legacy fallback (%s)",
    async (outcome) => {
      const proof = createDeferred<boolean>();
      const matchesCurrentConversation = vi.fn(() => true);
      const matchesCurrentConversationAsync = vi.fn(() => proof.promise);
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "testchat",
            source: "test",
            origin: "bundled",
            plugin: {
              ...annotationParams.channelPlugin,
              actions: {
                describeMessageTool: () => ({ actions: ["thread-reply"] }),
                messageActionTargetAliases: {
                  "thread-reply": {
                    aliases: ["threadId"],
                    matchesCurrentConversation,
                    matchesCurrentConversationAsync,
                  },
                },
              },
            },
          },
        ]),
      );
      const actionResult = {
        kind: "action" as const,
        channel: "testchat" as const,
        action: "thread-reply" as const,
        handledBy: "plugin" as const,
        payload: { ok: true },
        dryRun: false,
      };
      const pending = annotateSourceDelivery(actionResult, annotationParams, false);
      expect(matchesCurrentConversationAsync).toHaveBeenCalledOnce();
      expect(matchesCurrentConversation).not.toHaveBeenCalled();
      if (outcome === "error") {
        const expected = expect(pending).rejects.toThrow("proof unavailable");
        proof.reject(new Error("proof unavailable"));
        await expected;
      } else {
        if (outcome === "stale") {
          setActivePluginRegistry(createTestRegistry([]));
        }
        proof.resolve(outcome !== false);
        const result = await pending;
        if (outcome === true) {
          expect(result.payload).toMatchObject({ sourceReplyRoute: "current-source" });
        } else {
          expect(result).toBe(actionResult);
        }
      }
      expect(matchesCurrentConversation).not.toHaveBeenCalled();
    },
  );

  it("marks a gateway-returned current-thread receipt", async () => {
    const result = await annotateSourceDelivery(
      {
        kind: "action" as const,
        channel: "testchat" as const,
        action: "thread-reply" as const,
        handledBy: "plugin" as const,
        payload: { receipt: { threadId: "thread-1" } },
        dryRun: false,
      },
      annotationParams,
      false,
    );

    expect(result.payload).toMatchObject({ sourceReplyRoute: "current-source" });
  });

  it("marks both payload and tool details after local plugin dispatch", async () => {
    const receipt = { threadId: "thread-1" };
    const result = await annotateSourceDelivery(
      {
        kind: "action" as const,
        channel: "testchat" as const,
        action: "thread-reply" as const,
        handledBy: "plugin" as const,
        payload: { receipt },
        toolResult: {
          content: [{ type: "text" as const, text: "delivered" }],
          details: { receipt },
        },
        dryRun: false,
      },
      annotationParams,
      false,
    );

    expect(result.payload).toMatchObject({ sourceReplyRoute: "current-source" });
    expect(result.toolResult.details).toMatchObject({ sourceReplyRoute: "current-source" });
  });

  it("leaves a different-thread receipt unmarked", async () => {
    const result = await annotateSourceDelivery(
      {
        kind: "action" as const,
        channel: "testchat" as const,
        action: "thread-reply" as const,
        handledBy: "plugin" as const,
        payload: { receipt: { threadId: "other-thread" } },
        dryRun: false,
      },
      annotationParams,
      false,
    );

    expect(result.payload).not.toHaveProperty("sourceReplyRoute");
  });
});
