import { describe, expect, it, type Mock } from "vitest";
import type { RunEmbeddedAgentInternalParams as AgentRunParams } from "../../agents/embedded-agent-runner/run/internal-params.js";
import { FailoverError } from "../../agents/failover-error.js";
import { GENERIC_EXTERNAL_RUN_FAILURE_TEXT } from "../../agents/failover/user-copy.js";
import type { TemplateContext } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import { setBlockReplyDelivery } from "./block-reply-delivery.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import type { FollowupRun } from "./queue.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import {
  REPLY_OPERATION_RUN_STATE,
  resolveReplyOperationAgentTurn,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";

type FailureRunParams = {
  blockStreamingEnabled?: boolean;
  opts?: InternalGetReplyOptions;
  sessionCtx?: Partial<TemplateContext>;
  runOverrides?: Partial<FollowupRun["run"]>;
};

type ImmediateFailureFixture = {
  createMinimalRun: (params?: FailureRunParams) => {
    run: () => Promise<ReplyPayload | ReplyPayload[] | undefined>;
  };
  state: {
    runEmbeddedAgentMock: Pick<Mock, "mockImplementationOnce" | "mockResolvedValueOnce">;
  };
};

export function registerImmediateFailurePolicyCases({
  createMinimalRun,
  state,
}: ImmediateFailureFixture): void {
  describe("runReplyAgent immediate failure policy", () => {
    function createFailureRun(params: FailureRunParams = {}) {
      const runState: ReplyOperationRunState = {};
      const cfg = { agents: { defaults: { silentReply: { group: "allow" as const } } } };
      const { run } = createMinimalRun({
        blockStreamingEnabled: params.blockStreamingEnabled,
        sessionCtx: {
          Provider: "discord",
          Surface: "discord",
          ChatType: "group",
          InboundEventKind: "user_request",
          WasMentioned: false,
          ...params.sessionCtx,
        },
        runOverrides: { messageProvider: "discord", config: cfg, ...params.runOverrides },
        opts: { ...params.opts, [REPLY_OPERATION_RUN_STATE]: runState },
      });
      const delivered: ReplyPayload[] = [];
      const dispatcher = createReplyDispatcher({
        silentReplyContext: { cfg, surface: "discord", conversationType: "group" },
        deliver: async (payload) => {
          delivered.push(payload);
        },
      });
      return {
        runState,
        delivered,
        run: async () => {
          const result = await run();
          for (const payload of Array.isArray(result) ? result : result ? [result] : []) {
            dispatcher.sendFinalReply(payload);
          }
          dispatcher.markComplete();
          return await dispatcher.waitForIdle();
        },
      };
    }

    it.each([
      { label: "unmentioned group", sessionCtx: {}, visible: false },
      { label: "mentioned group", sessionCtx: { WasMentioned: true }, visible: true },
      { label: "direct request", sessionCtx: { ChatType: "direct" }, visible: true },
    ])("settles a generic failure before output for an $label", async ({ sessionCtx, visible }) => {
      state.runEmbeddedAgentMock.mockImplementationOnce(async () => {
        throw new Error("opaque-private-runner-detail");
      });
      const fixture = createFailureRun({ sessionCtx });

      const receipt = await fixture.run();

      expect(resolveReplyOperationAgentTurn(fixture.runState)).toBe("failed");
      expect(receipt?.anyVisibleDelivered).toBe(visible);
      expect(fixture.delivered).toEqual(
        visible ? [expect.objectContaining({ isError: true, text: expect.any(String) })] : [],
      );
      for (const payload of fixture.delivered) {
        expect(payload.text).not.toContain("opaque-private-runner-detail");
      }
    });

    it("keeps a returned generic terminal failure silent without recording success", async () => {
      state.runEmbeddedAgentMock.mockResolvedValueOnce({
        payloads: [],
        meta: { error: { kind: "tool_result_mismatch", message: "opaque-private-runner-detail" } },
      });
      const fixture = createFailureRun();

      const receipt = await fixture.run();

      expect(fixture.delivered).toEqual([]);
      expect(receipt?.anyVisibleDelivered).toBe(false);
      expect(resolveReplyOperationAgentTurn(fixture.runState)).toBe("failed");
    });

    it.each(["auth", "rate_limit"] as const)(
      "delivers classified %s guidance for an unmentioned group failure",
      async (reason) => {
        state.runEmbeddedAgentMock.mockImplementationOnce(async () => {
          throw new FailoverError("private-provider-diagnostic", {
            reason,
            provider: "anthropic",
            model: "claude",
            status: reason === "auth" ? 401 : 429,
          });
        });
        const fixture = createFailureRun();

        const receipt = await fixture.run();

        expect(resolveReplyOperationAgentTurn(fixture.runState)).toBe("failed");
        expect(receipt?.anyVisibleDelivered).toBe(true);
        expect(fixture.delivered).toEqual([
          expect.objectContaining({ isError: true, text: expect.any(String) }),
        ]);
        expect(fixture.delivered[0]?.text).not.toBe(GENERIC_EXTERNAL_RUN_FAILURE_TEXT);
        expect(fixture.delivered[0]?.text).not.toContain("private-provider-diagnostic");
      },
    );

    it.each([
      ["delivered", true],
      ["channel-transform", false],
    ] as const)(
      "uses the %s direct-progress receipt for failure closure",
      async (outcome, visible) => {
        const progress: string[] = [];
        state.runEmbeddedAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
          await params.onBlockReply?.({ text: "Checking the request.", isCommentary: true });
          throw new Error("opaque-private-runner-detail");
        });
        const fixture = createFailureRun({
          blockStreamingEnabled: false,
          opts: {
            commentaryPayloadsEnabled: true,
            onBlockReply: async (payload) => {
              setBlockReplyDelivery(Promise.resolve({ outcome }), payload);
              if (visible && payload.text) {
                progress.push(payload.text);
              }
            },
          },
        });

        const receipt = await fixture.run();

        expect(progress).toEqual(visible ? ["Checking the request."] : []);
        expect(receipt?.anyVisibleDelivered).toBe(visible);
        expect(fixture.delivered).toEqual(
          visible ? [expect.objectContaining({ isError: true, text: expect.any(String) })] : [],
        );
        expect(resolveReplyOperationAgentTurn(fixture.runState)).toBe("failed");
      },
    );

    it.each([
      { label: "accepted", callbackResult: true, visible: true },
      { label: "legacy accepted", callbackResult: undefined, visible: true },
      { label: "rejected", callbackResult: false, visible: false },
    ])(
      "closes an optional failure only after $label partial progress",
      async ({ callbackResult, visible }) => {
        const progress: string[] = [];
        state.runEmbeddedAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
          await params.onPartialReply?.({ text: "Checking the request." });
          throw new Error("opaque-private-runner-detail");
        });
        const fixture = createFailureRun({
          opts: {
            preserveProgressCallbackStartOrder: true,
            onPartialReply: async (payload) => {
              if (callbackResult !== false && payload.text) {
                progress.push(payload.text);
              }
              return callbackResult;
            },
          },
        });

        const receipt = await fixture.run();

        expect(progress).toEqual(visible ? ["Checking the request."] : []);
        expect(receipt?.anyVisibleDelivered).toBe(visible);
        expect(fixture.delivered).toEqual(
          visible ? [expect.objectContaining({ isError: true, text: expect.any(String) })] : [],
        );
        expect(resolveReplyOperationAgentTurn(fixture.runState)).toBe("failed");
      },
    );
  });
}
