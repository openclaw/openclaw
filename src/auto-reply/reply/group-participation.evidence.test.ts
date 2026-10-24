import { expect, it, vi } from "vitest";
import { getSessionControllerOperation } from "../../sessions/session-controller.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { readGroupParticipationEvidence } from "./group-participation-context.js";
import {
  readGroupParticipationInputs,
  recordGroupParticipationInput,
} from "./group-participation-inputs.js";
import { judgment } from "./group-participation.decision.test-support.js";
import { fixture, models } from "./group-participation.runner.test-support.js";

it("does not classify a textless source as a negative attention judgment", async () => {
  const recorder = createUserTurnTranscriptRecorder({ input: {}, target: () => undefined });
  vi.spyOn(recorder, "resolveMessage").mockResolvedValue({
    role: "user",
    content: [{ type: "image", data: "image-data", mimeType: "image/png" }],
    timestamp: 1,
  });
  expect(
    await readGroupParticipationEvidence({
      agentId: "main",
      target: {
        agentId: "main",
        sessionId: "media-only",
        sessionKey: "agent:main:telegram:group:-10115",
        storePath: fixture.storePath,
      },
      recorder,
      signal: new AbortController().signal,
      timeoutMs: 30_000,
    }),
  ).toBeUndefined();
});

it("uses ordinary generation when newly adopted media cannot be assessed", async () => {
  fixture.config.agents!.defaults!.model = { primary: "test-provider/test-model" };
  models.decision.mockImplementation(async (batch) => judgment(batch, { attention: "none" }));
  models.embedded.mockResolvedValue({
    payloads: [{ text: "Ordinary media reply." }],
    meta: { durationMs: 1 },
  });
  const groupId = "-10114";
  const recorder = createUserTurnTranscriptRecorder({ input: {}, target: () => undefined });
  vi.spyOn(recorder, "resolveMessage").mockResolvedValue({
    role: "user",
    content: [{ type: "image", data: "image-data", mimeType: "image/png" }],
    timestamp: 1,
  });
  const reply = await fixture.reply("Chatter", "before-media", groupId, {
    onRunVerbosityResolved: () => {
      const operation = getSessionControllerOperation("agent:main:telegram:group:" + groupId);
      if (!operation) {
        throw new Error("The admitted reply owner is missing");
      }
      recordGroupParticipationInput(
        operation,
        {
          userTurnTranscriptRecorder: recorder,
          messageId: "adopted-media",
          groupParticipation: {},
          run: { messageProvider: "telegram" },
        },
        "steer",
      );
    },
  });
  expect(Array.isArray(reply) ? reply : [reply]).toEqual(
    expect.arrayContaining([expect.objectContaining({ text: "Ordinary media reply." })]),
  );
  expect(models.decision).toHaveBeenCalledTimes(1);
  expect(models.embedded).toHaveBeenCalledTimes(1);
  expect(models.embedded.mock.calls[0]?.[0].terminalReplyExpectation).toBe("required");
});

it("restores an ordinary required reply for an adopted participation-bypass source", async () => {
  fixture.config.agents!.defaults!.model = { primary: "test-provider/test-model" };
  const groupId = "-10116";
  models.decision.mockImplementation(async (batch) => {
    const operation = getSessionControllerOperation("agent:main:telegram:group:" + groupId);
    if (!operation) {
      throw new Error("The reply owner is missing");
    }
    const source = readGroupParticipationInputs(operation).sources[0];
    if (!source) {
      throw new Error("The source is missing");
    }
    recordGroupParticipationInput(
      operation,
      {
        userTurnTranscriptRecorder: source.recorder,
        messageId: "mentioned-followup",
        run: { messageProvider: "telegram" },
      },
      "steer",
    );
    return judgment(batch, { attention: "none" });
  });
  models.embedded.mockResolvedValue({
    payloads: [{ text: "Required followup reply." }],
    meta: { durationMs: 1 },
  });
  const reply = await fixture.reply("Chatter", "before-mention", groupId);
  expect(Array.isArray(reply) ? reply : [reply]).toEqual(
    expect.arrayContaining([expect.objectContaining({ text: "Required followup reply." })]),
  );
  expect(models.decision).toHaveBeenCalledTimes(1);
  expect(models.embedded).toHaveBeenCalledTimes(1);
  expect(models.embedded.mock.calls[0]?.[0].terminalReplyExpectation).toBe("required");
});

it.each(["deadline", "cancel"] as const)(
  "bounds pending evidence acquisition on %s",
  async (kind) => {
    const recorder = createUserTurnTranscriptRecorder({ input: {}, target: () => undefined });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(recorder, "resolveMessage").mockImplementation(async () => {
      await blocked;
      return undefined;
    });
    const controller = new AbortController();
    vi.useFakeTimers();
    try {
      const pending = readGroupParticipationEvidence({
        agentId: "main",
        target: {
          agentId: "main",
          sessionId: "blocked-source",
          sessionKey: "agent:main:telegram:group:-10117",
          storePath: fixture.storePath,
        },
        recorder,
        signal: controller.signal,
        timeoutMs: 30_000,
      });
      if (kind === "cancel") {
        const failure = new Error("Turn cancelled");
        const assertion = expect(pending).rejects.toBe(failure);
        controller.abort(failure);
        await assertion;
      } else {
        await vi.advanceTimersByTimeAsync(30_000);
        expect(await pending).toBeUndefined();
        expect(controller.signal.aborted).toBe(false);
      }
    } finally {
      release();
      await blocked;
      vi.useRealTimers();
    }
  },
);
