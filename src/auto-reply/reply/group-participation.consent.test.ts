import { expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { getSessionControllerOperation } from "../../sessions/session-controller.js";
import {
  readGroupParticipationInputs,
  recordGroupParticipationInput,
} from "./group-participation-inputs.js";
import { judgment } from "./group-participation.decision.test-support.js";
import { fixture, models } from "./group-participation.runner.test-support.js";

it.each([undefined, false])(
  "keeps ordinary replies when Decision assistance is %s despite a selected model",
  async (decisionAssistance) => {
    fixture.config.agents!.defaults!.experimental = { decisionAssistance };
    fixture.config.agents!.defaults!.model = { primary: "test-provider/test-model" };
    models.decision.mockImplementation(async (batch) => judgment(batch, { attention: "none" }));
    models.embedded.mockResolvedValue({
      payloads: [{ text: "Ordinary reply with assistance off." }],
      meta: { durationMs: 1 },
    });
    const reply = await fixture.reply(
      "Bob, do you know the port?",
      "assistance-off-source",
      decisionAssistance === false ? "-10104" : "-10105",
    );
    expect(Array.isArray(reply) ? reply : [reply]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: "Ordinary reply with assistance off." }),
      ]),
    );
    expect(models.decision).not.toHaveBeenCalled();
    expect(models.embedded).toHaveBeenCalledTimes(1);
    expect(models.cli).not.toHaveBeenCalled();
  },
);

it.each(["opt-out", "model-removal"])(
  "discards an awaited participation decision after %s takes effect",
  async (change) => {
    fixture.config.agents!.defaults!.model = { primary: "test-provider/test-model" };
    setRuntimeConfigSnapshot(fixture.config);
    models.decision.mockImplementation(async (batch, options) => {
      expect(options.admit?.()).toBe(true);
      const next = structuredClone(fixture.config);
      if (change === "opt-out") {
        next.agents!.defaults!.experimental = { decisionAssistance: false };
      } else {
        next.agents!.defaults!.decisionModel = "";
      }
      setRuntimeConfigSnapshot(next, fixture.config);
      expect(options.admit?.()).toBe(false);
      return judgment(batch, { attention: "none" });
    });
    models.embedded.mockResolvedValue({
      payloads: [{ text: "Ordinary reply after config refresh." }],
      meta: { durationMs: 1 },
    });
    try {
      const reply = await fixture.reply(
        "Bob, do you know the port?",
        "config-refresh-source",
        change === "opt-out" ? "-10106" : "-10107",
      );
      expect(Array.isArray(reply) ? reply : [reply]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: "Ordinary reply after config refresh." }),
        ]),
      );
      expect(models.decision).toHaveBeenCalledTimes(1);
      expect(models.embedded).toHaveBeenCalledTimes(1);
    } finally {
      setRuntimeConfigSnapshot(fixture.config);
    }
  },
);

it.each(["opt-out", "model-removal"])(
  "requires a fresh judgment after %s is reversed while a decision is pending",
  async (change) => {
    fixture.config.agents!.defaults!.model = { primary: "test-provider/test-model" };
    setRuntimeConfigSnapshot(fixture.config);
    models.decision.mockImplementationOnce(async (batch) => {
      const next = structuredClone(fixture.config);
      if (change === "opt-out") {
        next.agents!.defaults!.experimental = { decisionAssistance: false };
      } else {
        next.agents!.defaults!.decisionModel = "";
      }
      setRuntimeConfigSnapshot(next, fixture.config);
      setRuntimeConfigSnapshot(fixture.config);
      return judgment(batch, { attention: "none" });
    });
    models.decision.mockImplementation(async (batch) =>
      judgment(batch, { attention: "engagement" }),
    );
    models.embedded.mockResolvedValue({
      payloads: [{ text: "Reply from the fresh invitation judgment." }],
      meta: { durationMs: 1 },
    });
    try {
      const reply = await fixture.reply(
        "Can you explain the port?",
        "config-reversal-source",
        change === "opt-out" ? "-10108" : "-10109",
      );
      expect(Array.isArray(reply) ? reply : [reply]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: "Reply from the fresh invitation judgment." }),
        ]),
      );
      expect(models.decision).toHaveBeenCalledTimes(2);
      expect(models.embedded).toHaveBeenCalledTimes(1);
    } finally {
      setRuntimeConfigSnapshot(fixture.config);
    }
  },
);

it.each(["none", "engagement", "opportunity"] as const)(
  "restores a required reply when consent is withdrawn after %s assessment",
  async (attention) => {
    fixture.config.agents!.defaults!.model = { primary: "test-provider/test-model" };
    setRuntimeConfigSnapshot(fixture.config);
    models.decision.mockImplementation(async (batch) => judgment(batch, { attention }));
    models.embedded.mockResolvedValue({
      payloads: [{ text: "Ordinary reply after late opt-out." }],
      meta: { durationMs: 1 },
    });
    try {
      const reply = await fixture.reply(
        "Bob, which port?",
        `late-opt-out-${attention}`,
        `-10112-${attention}`,
        {
          onRunVerbosityResolved: () => {
            const next = structuredClone(fixture.config);
            next.agents!.defaults!.experimental = { decisionAssistance: false };
            setRuntimeConfigSnapshot(next, fixture.config);
          },
        },
      );
      expect(Array.isArray(reply) ? reply : [reply]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: "Ordinary reply after late opt-out." }),
        ]),
      );
      expect(models.decision).toHaveBeenCalledTimes(1);
      expect(models.embedded).toHaveBeenCalledTimes(1);
      expect(models.embedded.mock.calls[0]?.[0].terminalReplyExpectation).toBe("required");
    } finally {
      setRuntimeConfigSnapshot(fixture.config);
    }
  },
);

it.each(["none", "engagement", "opportunity"] as const)(
  "reassesses %s when accepted group input changes before execution",
  async (attention) => {
    fixture.config.agents!.defaults!.model = { primary: "test-provider/test-model" };
    models.decision.mockImplementationOnce(async (batch) => judgment(batch, { attention }));
    models.decision.mockImplementation(async (batch) => judgment(batch, { attention: "none" }));
    models.embedded.mockResolvedValue({
      payloads: [{ text: "Must not bypass assessment." }],
      meta: { durationMs: 1 },
    });
    const groupId = `-10113-${attention}`;
    const reply = await fixture.reply("Chatter", "observed-source", groupId, {
      onRunVerbosityResolved: () => {
        const operation = getSessionControllerOperation("agent:main:telegram:group:" + groupId);
        if (!operation) {
          throw new Error("The admitted reply owner is missing");
        }
        const source = readGroupParticipationInputs(operation).sources[0];
        if (!source) {
          throw new Error("The admitted group source is missing");
        }
        // Use the accepted-input owner seam before persistence, without another concurrent reply writer.
        recordGroupParticipationInput(operation, {
          userTurnTranscriptRecorder: source.recorder,
          messageId: "accepted-later-source",
          run: { messageProvider: "telegram" },
        });
      },
    });
    expect(
      (Array.isArray(reply) ? reply : [reply]).flatMap((payload) =>
        payload?.text ? [payload.text] : [],
      ),
    ).toEqual([]);
    expect(models.decision).toHaveBeenCalledTimes(2);
    expect(models.embedded).not.toHaveBeenCalled();
  },
);
