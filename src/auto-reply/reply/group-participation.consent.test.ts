import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { MISSING_REPLY_NOTICE_TEXT } from "../../agents/reply-completion.js";
import { createTypingCallbacks } from "../../channels/typing.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { getSessionControllerOperation } from "../../sessions/session-controller.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { dispatchInboundMessageWithBufferedDispatcher } from "../dispatch.js";
import {
  readGroupParticipationInputs,
  recordGroupParticipationInput,
} from "./group-participation-inputs.js";
import { judgment } from "./group-participation.decision.test-support.js";
import { fixture, models } from "./group-participation.runner.test-support.js";
import type { QueuedFollowupReplyBatch } from "./queue/types.js";
import {
  REPLY_OPERATION_RUN_STATE,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";
import type { TypingController } from "./typing.js";

it.each([
  ["opt-out", "assessment", "none", false],
  ["model-removal", "assessment", "none", false],
  ["opt-out", "assessment", "none", true],
  ["model-removal", "assessment", "none", true],
  ["opt-out", "execution", "none", false],
  ["opt-out", "execution", "engagement", false],
] as const)(
  "restores ordinary policy after %s during %s (%s, re-enable: %s)",
  async (change, stage, attention, reEnabled) => {
    const withdraw = () => {
      const next = structuredClone(fixture.config);
      if (change === "opt-out") {
        next.agents!.defaults!.experimental = { decisionAssistance: false };
      } else {
        next.agents!.defaults!.decisionModel = "";
      }
      setRuntimeConfigSnapshot(next, fixture.config);
    };
    models.decision.mockImplementationOnce(async (batch, options) => {
      if (stage === "assessment") {
        expect(options.isAdmissible?.()).toBe(true);
        withdraw();
        if (!reEnabled) {
          expect(options.isAdmissible?.()).toBe(false);
        }
        if (reEnabled) {
          setRuntimeConfigSnapshot(fixture.config);
        }
      }
      return judgment(batch, { attention });
    });
    models.decision.mockImplementation(async (batch) =>
      judgment(batch, { attention: "engagement" }),
    );
    models.embedded.mockResolvedValue({
      payloads: [{ text: "Ordinary reply." }],
      meta: { durationMs: 1 },
    });
    const reply = await fixture.reply("Bob, which port?", "config-source", "-10106", {
      onRunVerbosityResolved: stage === "execution" ? withdraw : undefined,
    });
    expect([reply].flat()).toContainEqual(expect.objectContaining({ text: "Ordinary reply." }));
    expect(models.decision).toHaveBeenCalledTimes(reEnabled ? 2 : 1);
    expect(models.embedded).toHaveBeenCalledOnce();
    expect(models.embedded.mock.calls[0]?.[0].terminalReplyExpectation).toBe("required");
  },
);

it.each([
  ["none", "chatter", "execution"],
  ["engagement", "chatter", "queued"],
  ["opportunity", "chatter", "execution"],
  ["none", "media", "execution"],
  ["none", "mention", "execution"],
  ["none", "mention", "assessment"],
] as const)("handles %s with accepted %s during %s", async (attention, input, stage) => {
  fixture.config.agents!.defaults!.typingMode = "instant";
  const groupId = `-10113-${attention}-${input}-${stage}`;
  const accept = () => {
    const operation = getSessionControllerOperation("agent:main:telegram:group:" + groupId);
    const source = operation && readGroupParticipationInputs(operation).sources[0];
    if (!operation || !source) {
      throw new Error("The admitted group source is missing");
    }
    const recorder =
      input === "media"
        ? createUserTurnTranscriptRecorder({ input: {}, target: () => undefined })
        : source.recorder;
    if (input === "media") {
      vi.spyOn(recorder, "resolveMessage").mockResolvedValue({
        role: "user",
        content: [{ type: "image", data: "image-data", mimeType: "image/png" }],
        timestamp: 1,
      });
    }
    recordGroupParticipationInput(
      operation,
      {
        userTurnTranscriptRecorder: recorder,
        messageId: "accepted-later-source",
        ...(input !== "mention" && stage !== "queued" ? { groupParticipation: {} } : {}),
        run: { messageProvider: "telegram" },
      },
      stage === "queued" ? "queued" : "steer",
    );
  };
  models.decision.mockImplementationOnce(async (batch) => {
    if (stage === "assessment") {
      accept();
    }
    return judgment(batch, { attention });
  });
  models.decision.mockImplementation(async (batch) => judgment(batch, { attention: "none" }));
  models.embedded.mockResolvedValue({
    payloads: [{ text: "Ordinary reply." }],
    meta: { durationMs: 1 },
  });
  const reply = await fixture.reply("Chatter", "observed-source", groupId, {
    onRunVerbosityResolved: stage !== "assessment" ? accept : undefined,
  });
  const ordinary = input !== "chatter" || attention !== "none";
  expect([reply].flat().flatMap((payload) => (payload?.text ? [payload.text] : []))).toEqual(
    ordinary ? ["Ordinary reply."] : [],
  );
  expect(models.decision).toHaveBeenCalledTimes(ordinary ? 1 : 2);
  expect(models.embedded).toHaveBeenCalledTimes(ordinary ? 1 : 0);
  if (ordinary) {
    expect(models.embedded.mock.calls[0]?.[0].terminalReplyExpectation).toBe("required");
  } else {
    expect(fixture.typing()).toBe(0);
  }
});

it.each(["engagement", "none", "reassessed"] as const)(
  "retains buffered typing custody through queued %s settlement",
  async (attention) => {
    fixture.config.agents!.defaults!.typingMode = "instant";
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    const queuedStarted = createDeferred();
    const releaseQueued = createDeferred();
    const start = vi.fn(async () => {});
    const stop = vi.fn(async () => {});
    const batches: QueuedFollowupReplyBatch[] = [];
    const runState: ReplyOperationRunState = {};
    let typing: TypingController | undefined;
    models.decision.mockImplementation(async (batch) => {
      expect(start).not.toHaveBeenCalled();
      return judgment(batch, {
        attention:
          attention === "reassessed"
            ? models.decision.mock.calls.length === 1
              ? "none"
              : "engagement"
            : attention,
      });
    });
    models.embedded.mockImplementationOnce(async () => {
      firstStarted.resolve();
      await releaseFirst.promise;
      return { payloads: [{ text: "First reply." }], meta: { durationMs: 1 } };
    });
    models.embedded.mockImplementationOnce(async () => {
      queuedStarted.resolve();
      await releaseQueued.promise;
      return {
        payloads: [],
        meta: { durationMs: 1, terminalReply: { disposition: "silent" as const } },
      };
    });
    const groupId = `-10115-${attention}`;
    const first = fixture.reply("First question", "first", groupId, undefined, true);
    try {
      await awaitGateBeforeSettlement(firstStarted.promise, first, "First turn did not start");
      const queued = await dispatchInboundMessageWithBufferedDispatcher({
        cfg: fixture.config,
        ctx: fixture.context("Bob, which port?", "queued", groupId),
        dispatcherOptions: {
          deliver: async () => {},
          typingCallbacks: createTypingCallbacks({ start, stop, onStartError: () => {} }),
        },
        replyOptions: {
          turnAdoptionLifecycle: { onAdopted() {} },
          onRunVerbosityResolved: () => {
            if (attention !== "reassessed") {
              return;
            }
            const operation = getSessionControllerOperation("agent:main:telegram:group:" + groupId);
            const recorder =
              operation && readGroupParticipationInputs(operation).sources[0]?.recorder;
            if (!operation || !recorder) {
              throw new Error("The queued group source is missing");
            }
            recordGroupParticipationInput(
              operation,
              {
                userTurnTranscriptRecorder: recorder,
                groupParticipation: {},
                messageId: "accepted-later",
                run: { messageProvider: "telegram" },
              },
              "steer",
            );
          },
          [REPLY_OPERATION_RUN_STATE]: runState,
          onTypingController: (controller) => {
            typing = controller;
          },
          onQueuedFollowupReplyBatch: async (batch) => {
            batches.push(batch);
          },
        },
      });
      expect(queued.deferredToActiveRun).toBe("followup");
      expect(start).not.toHaveBeenCalled();
      expect(stop).not.toHaveBeenCalled();
      const settlement = runState.followupSourceSettlement;
      if (!settlement) {
        throw new Error("The queued source did not retain its settlement receipt");
      }
      releaseFirst.resolve();
      await first;
      if (attention !== "none") {
        await awaitGateBeforeSettlement(
          queuedStarted.promise,
          settlement,
          "Queued model did not start",
        );
        expect(start).toHaveBeenCalled();
        expect(stop).not.toHaveBeenCalled();
        expect(typing?.isActive()).toBe(true);
      }
      releaseQueued.resolve();
      await settlement;
      expect(models.embedded).toHaveBeenCalledTimes(attention !== "none" ? 2 : 1);
      expect(start.mock.calls.length > 0).toBe(attention !== "none");
      expect(typing?.isActive()).toBe(false);
      expect(stop).toHaveBeenCalledOnce();
      expect(batches).toMatchObject([
        {
          payloads: attention !== "none" ? [{ text: MISSING_REPLY_NOTICE_TEXT }] : [],
          completion: { kind: attention !== "none" ? "failed" : "completed" },
        },
      ]);
    } finally {
      releaseFirst.resolve();
      releaseQueued.resolve();
      await first;
      await runState.followupSourceSettlement;
    }
  },
);
