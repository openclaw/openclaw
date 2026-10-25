import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createSubscribedSessionHarness } from "../../agents/embedded-agent-subscribe.e2e-harness.js";
import * as questionDispatch from "../../agents/harness/gateway-question-dispatch.js";
import { claimPendingAgentQuestionAnswer } from "../../agents/harness/gateway-question.js";
import { createSecretsTool } from "../../agents/tools/secrets-tool.js";
import type { ReplyPayload } from "../types.js";
import { askUserMocks, hookMocks, mocks } from "./dispatch-from-config.shared.test-harness.js";
import {
  dispatchReplyFromConfig,
  globalBeforeAll0,
  describe0BeforeEach0,
  installThreadingTestPlugin,
  requireToolResultHandler,
  setNoAbort,
} from "./dispatch-from-config.test-support.js";
import { beforeSettlement } from "./reply-contract.test-support.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { buildTestCtx } from "./test-ctx.js";

vi.unmock("../../agents/tools/ask-user-tool.js");
const gateway = vi.hoisted(() => vi.fn());
vi.mock("../../agents/tools/gateway.js", () => ({ callGatewayTool: gateway }));

beforeAll(globalBeforeAll0);
beforeEach(async () => {
  describe0BeforeEach0();
  const actual = await vi.importActual<typeof import("../../agents/tools/ask-user-tool.js")>(
    "../../agents/tools/ask-user-tool.js",
  );
  askUserMocks.isAskUserPromptPending.mockImplementation(actual.isAskUserPromptPending);
});

const settledResult = <T>(promise: Promise<T>) =>
  promise.then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  );

it.for([false, true])(
  "settles a quiet group's credential producer (policy denied=%s)",
  async (deny, { signal }) => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockReturnValue(false);
    installThreadingTestPlugin({ id: "telegram" });
    const answer = createDeferred<unknown>();
    const transport = createDeferred();
    const received = createDeferred<ReplyPayload>();
    const callbackFinished = createDeferred();
    const sessionKey = "agent:main:telegram:group:credential-proof";
    const runId = "credential-dispatch-run";
    const args = { action: "request", name: "SERVICE_API_KEY", kind: "secret" };
    const cfg = {
      gateway: { publicOrigin: "https://console.example.test" },
      ...(deny ? { session: { sendPolicy: { default: "deny" as const } } } : {}),
    };
    let questionId = "";
    gateway
      .mockReset()
      .mockImplementation(async (method: string, _opts: unknown, params: unknown) => {
        switch (method) {
          case "question.request":
            questionId = String(asNullableRecord(params)?.id);
            return { id: questionId };
          case "question.list":
            return { questions: questionId ? [{ id: questionId, status: "pending" }] : [] };
          case "question.waitAnswer":
            return await answer.promise;
          case "question.resolve":
            answer.resolve({ status: "cancelled" });
            return { ok: true };
          default:
            throw new Error(`unexpected method ${method}`);
        }
      });
    const deliver = vi.fn(async (payload: ReplyPayload, info: { kind: string }) => {
      if (info.kind === "tool") {
        received.resolve(payload);
        await transport.promise;
      }
    });
    const dispatcher = createReplyDispatcher({ deliver });
    const progress = vi.fn();
    let toolOutcome: Promise<unknown> | undefined;
    let unsubscribe: (() => void) | undefined;
    const questionResolverSpy = vi
      .spyOn(questionDispatch, "resolveAgentQuestionGatewayCall")
      .mockReturnValue(gateway);
    const dispatch = settledResult(
      dispatchReplyFromConfig({
        ctx: buildTestCtx({
          SessionKey: sessionKey,
          Provider: "telegram",
          Surface: "telegram",
          ChatType: "group",
        }),
        cfg,
        dispatcher,
        replyOptions: {
          sourceReplyDeliveryMode: "message_tool_only",
          suppressToolProgressMessages: true,
          suppressDefaultToolProgressMessages: true,
          allowProgressCallbacksWhenSourceDeliverySuppressed: true,
          onToolResult: progress,
        },
        replyResolver: async (_ctx, opts) => {
          const onToolResult = requireToolResultHandler(opts?.onToolResult);
          const harness = createSubscribedSessionHarness({
            runId,
            sessionKey,
            messageChannel: "telegram",
            config: cfg,
            onToolResult: async (payload) => {
              try {
                await onToolResult(payload);
              } finally {
                callbackFinished.resolve();
              }
            },
          });
          unsubscribe = harness.subscription.unsubscribe;
          harness.emit({
            type: "tool_execution_start",
            toolName: "secrets",
            toolCallId: "credential-call",
            args,
          });
          toolOutcome = settledResult(
            createSecretsTool({ sessionKey, runId }).execute("credential-call", args),
          );
          await toolOutcome;
          return undefined;
        },
      }),
    );
    try {
      if (deny) {
        transport.resolve();
        await beforeSettlement(
          callbackFinished.promise,
          dispatch,
          signal,
          "dispatch settled before the producer callback",
        );
        expect(deliver).not.toHaveBeenCalled();
        expect(mocks.routeReply).not.toHaveBeenCalled();
        answer.resolve({ status: "cancelled" });
      } else {
        const payload = await beforeSettlement(
          received.promise,
          dispatch,
          signal,
          "dispatch settled before delivery",
        );
        expect(deliver).toHaveBeenCalledOnce();
        expect(payload.channelData).toEqual({ askUser: { questionId } });
        expect(payload).not.toHaveProperty("presentation");
        expect(payload).not.toHaveProperty("interactive");
        expect(payload.text).toContain(`https://console.example.test/ask/${questionId}`);
        expect(gateway.mock.calls.some(([method]) => method === "question.resolve")).toBe(false);
        await expect(
          claimPendingAgentQuestionAnswer({ sessionKey, text: "not-a-credential" }),
        ).resolves.toBe(false);
        transport.resolve();
        await callbackFinished.promise;
        answer.resolve({ status: "answered", answers: { answers: { secret_value: ["stored"] } } });
        await expect(toolOutcome).resolves.toMatchObject({
          result: { details: { status: "stored" } },
        });
      }
      expect(progress).not.toHaveBeenCalled();
      await expect(dispatch).resolves.toHaveProperty("result");
    } finally {
      try {
        transport.resolve();
        answer.resolve({ status: "cancelled" });
        await dispatch;
      } finally {
        unsubscribe?.();
        questionResolverSpy.mockRestore();
      }
    }
  },
);
