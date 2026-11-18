import { expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { judgment } from "./group-participation.decision.test-support.js";
import { fixture, models } from "./group-participation.runner.test-support.js";

it.each([
  ["opt-out", false],
  ["model-removal", false],
  ["opt-out", true],
] as const)(
  "discards an awaited decision after %s (reversed before completion: %s)",
  async (change, reversed) => {
    setRuntimeConfigSnapshot(fixture.config);
    models.decision.mockImplementationOnce(async (batch, options) => {
      expect(options.admit?.()).toBe(true);
      const next = structuredClone(fixture.config);
      if (change === "opt-out") {
        next.agents!.defaults!.experimental = { decisionAssistance: false };
      } else {
        next.agents!.defaults!.decisionModel = "";
      }
      setRuntimeConfigSnapshot(next, fixture.config);
      if (reversed) {
        setRuntimeConfigSnapshot(fixture.config);
      } else {
        expect(options.admit?.()).toBe(false);
      }
      return judgment(batch, { attention: "none" });
    });
    models.decision.mockImplementation(async (batch) =>
      judgment(batch, { attention: "engagement" }),
    );
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
      expect(models.decision).toHaveBeenCalledTimes(reversed ? 2 : 1);
      expect(models.embedded).toHaveBeenCalledTimes(1);
    } finally {
      setRuntimeConfigSnapshot(fixture.config);
    }
  },
);

it.each(["none", "engagement"] as const)(
  "restores a required reply when consent is withdrawn after %s assessment",
  async (attention) => {
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
