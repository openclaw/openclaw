// Registered in the existing dispatch suite to retain its shared mocks and lifecycle.
import { expect, it, vi } from "vitest";
import type { MsgContext } from "../templating.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import {
  askUserMocks,
  createDispatcher,
  emptyConfig,
  hookMocks,
  mocks,
} from "./dispatch-from-config.shared.test-harness.js";
import {
  dispatchReplyFromConfig,
  installThreadingTestPlugin,
  requireToolResultHandler,
  setNoAbort,
} from "./dispatch-from-config.test-support.js";
import { isReplyDispatchDeliveryError } from "./reply-dispatch-outcome.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { buildTestCtx } from "./test-ctx.js";

export function registerQuestionPromptRoutingTests(): void {
  it("delivers ask_user prompts when verbose tool progress is disabled", async () => {
    setNoAbort();
    const payload = {
      text: "Question for you: Where should this deploy?",
      channelData: { askUser: { questionId: "question-owned-by-agent-runtime" } },
    } satisfies ReplyPayload;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ Provider: "telegram", ChatType: "direct" });
    const replyResolver = async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      await requireToolResultHandler(opts?.onToolResult)(payload);
      return undefined;
    };

    await dispatchReplyFromConfig({ ctx, cfg: emptyConfig, dispatcher, replyResolver });
    expect(dispatcher.sendToolResult).toHaveBeenCalledWith(payload);
    const toolDeliveryOrder =
      vi.mocked(dispatcher.sendToolResult).mock.invocationCallOrder[0] ?? Number.NEGATIVE_INFINITY;
    expect(
      vi
        .mocked(dispatcher.waitForIdle)
        .mock.invocationCallOrder.some((order) => order > toolDeliveryOrder),
    ).toBe(true);
  });

  it.each([
    ["cancelled", "cancelled", true, undefined],
    ["failed before transport", "failed-before-deliver", true, undefined],
    ["delivered", "delivered", false, undefined],
    ["failed during transport", "failed-deliver", true, "failed-deliver"],
  ] as const)(
    "settles ask_user delivery when the prompt is %s",
    async (_name, outcome, rejects, expectedOutcome) => {
      hookMocks.runner.hasHooks.mockReturnValue(false);
      const deliver = vi.fn(async (_payload: ReplyPayload, info: { kind: string }) => {
        if (outcome === "failed-deliver" && info.kind === "tool") {
          throw new Error("transport failure");
        }
      });
      const dispatcher = createReplyDispatcher({
        deliver,
        beforeDeliver: async (candidate, info) => {
          if (info.kind !== "tool") {
            return candidate;
          }
          if (outcome === "cancelled") {
            return null;
          }
          if (outcome === "failed-before-deliver") {
            throw new Error("before-delivery failure");
          }
          return candidate;
        },
      });
      const payload = {
        text: "Question for you: Where should this deploy?",
        channelData: { askUser: { questionId: "question-not-delivered" } },
      } satisfies ReplyPayload;

      const dispatch = dispatchReplyFromConfig({
        ctx: buildTestCtx({ Provider: "telegram", ChatType: "direct" }),
        cfg: emptyConfig,
        dispatcher,
        replyResolver: async (_ctx, opts) => {
          await requireToolResultHandler(opts?.onToolResult)(payload);
          return { text: "done" };
        },
      });

      if (expectedOutcome) {
        const error = await dispatch.catch((caught: unknown) => caught);
        expect(isReplyDispatchDeliveryError(error)).toBe(true);
        if (isReplyDispatchDeliveryError(error)) {
          expect(error.outcome).toBe(expectedOutcome);
        }
      } else if (rejects) {
        await expect(dispatch).rejects.toThrow();
      } else {
        await expect(dispatch).resolves.toMatchObject({ queuedFinal: true });
      }
    },
  );

  it.each([
    [
      {
        error: "not delivered",
        cause: Object.assign(new Error("socket closed"), { code: "ECONNRESET" }),
      },
      "not delivered",
      { message: "socket closed", code: "ECONNRESET" },
    ],
    [{ error: "not delivered" }, "not delivered", undefined],
    [{ reason: "channel_transform" as const }, "channel_transform", undefined],
  ])(
    "rejects ask_user prompts not delivered to the originating channel (%s)",
    async (failure, diagnostic, cause) => {
      setNoAbort();
      installThreadingTestPlugin({ id: "telegram" });
      mocks.routeReply.mockResolvedValue({
        ok: false,
        delivered: false,
        ...failure,
      });
      const payload = {
        text: "Question for you: Where should this deploy?",
        channelData: { askUser: { questionId: "question-not-routed" } },
      } satisfies ReplyPayload;
      const dispatcher = createDispatcher();
      const ctx = buildTestCtx({
        Provider: "webchat",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        OriginatingTo: "telegram:999",
      });
      const replyResolver = async (_ctx: MsgContext, opts?: GetReplyOptions) => {
        await requireToolResultHandler(opts?.onToolResult)(payload);
        return undefined;
      };

      await expect(
        dispatchReplyFromConfig({ ctx, cfg: emptyConfig, dispatcher, replyResolver }),
      ).rejects.toMatchObject({
        message: `ask_user prompt delivery failed: ${diagnostic}`,
        cause,
      });
    },
  );

  it("rejects ask_user prompts declined by the dispatcher", async () => {
    setNoAbort();
    const payload = {
      text: "Question for you: Where should this deploy?",
      channelData: { askUser: { questionId: "question-not-admitted" } },
    } satisfies ReplyPayload;
    const dispatcher = createDispatcher();
    vi.mocked(dispatcher.sendToolResult).mockReturnValue(false);
    const ctx = buildTestCtx({ Provider: "telegram", ChatType: "direct" });
    const replyResolver = async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      await requireToolResultHandler(opts?.onToolResult)(payload);
      return undefined;
    };

    await expect(
      dispatchReplyFromConfig({ ctx, cfg: emptyConfig, dispatcher, replyResolver }),
    ).rejects.toThrow();
  });

  it("drops ask_user prompts that terminalize before dispatcher delivery", async () => {
    setNoAbort();
    askUserMocks.isAskUserPromptPending.mockResolvedValue(false);
    const payload = {
      text: "Question for you: Where should this deploy?",
      channelData: { askUser: { questionId: "question-terminal-before-delivery" } },
    } satisfies ReplyPayload;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ Provider: "telegram", ChatType: "direct" });
    const replyResolver = async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      await requireToolResultHandler(opts?.onToolResult)(payload);
      return undefined;
    };

    await dispatchReplyFromConfig({ ctx, cfg: emptyConfig, dispatcher, replyResolver });

    expect(askUserMocks.isAskUserPromptPending).toHaveBeenCalledWith(
      "question-terminal-before-delivery",
    );
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
  });
}
