import { expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { getSessionControllerOperation } from "../../sessions/session-controller.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import {
  readGroupParticipationInputs,
  recordGroupParticipationInput,
} from "./group-participation-inputs.js";
import { judgment } from "./group-participation.decision.test-support.js";
import { fixture, models } from "./group-participation.runner.test-support.js";

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
] as const)("refreshes %s for accepted %s during %s", async (attention, input, stage) => {
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
  const ordinary = input !== "chatter";
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
