import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { FailoverError } from "../../agents/failover-error.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { judgment } from "./group-participation.decision.test-support.js";
import { createGroupReplyFixture } from "./group-participation.reply.test-support.js";

const models = vi.hoisted(() => ({
  embedded: vi.fn<typeof import("../../agents/embedded-agent.js").runEmbeddedAgent>(),
  cli: vi.fn<typeof import("../../agents/cli-runner.js").runCliAgent>(),
  decision: vi.fn<typeof import("../../decisions/runtime.js").evaluateDecision>(),
}));
vi.mock("../../agents/embedded-agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/embedded-agent.js")>()),
  runEmbeddedAgent: models.embedded,
}));
vi.mock("../../agents/cli-runner.js", () => ({ runCliAgent: models.cli }));
vi.mock("../../decisions/runtime.js", () => ({ evaluateDecision: models.decision }));

let fixture: Awaited<ReturnType<typeof createGroupReplyFixture>>;
beforeAll(async () => {
  fixture = await createGroupReplyFixture();
});
afterAll(async () => {
  await fixture.close();
});
beforeEach(() => {
  models.embedded.mockReset();
  models.cli.mockReset();
  models.decision.mockReset();
  fixture.config.agents!.defaults!.experimental = { decisionAssistance: true };
  const registry = createTestRegistry();
  registry.cliBackends.push({
    pluginId: "synthetic-cli",
    source: "test",
    backend: { id: "fixture-cli", config: { command: "synthetic-cli" }, bundleMcp: false },
  });
  setActivePluginRegistry(registry);
});

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
    models.decision.mockImplementation(async (batch) => {
      const next = structuredClone(fixture.config);
      if (change === "opt-out") {
        next.agents!.defaults!.experimental = { decisionAssistance: false };
      } else {
        next.agents!.defaults!.decisionModel = "";
      }
      setRuntimeConfigSnapshot(next, fixture.config);
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

it("keeps ambient room events on their message-tool path without participation evaluation", async () => {
  fixture.config.agents!.defaults!.model = { primary: "test-provider/test-model" };
  models.decision.mockImplementation(async (batch) =>
    judgment(batch, { attention: "opportunity" }),
  );
  models.embedded.mockResolvedValue({ payloads: [], meta: { durationMs: 1 } });
  await fixture.reply(
    "Alice joined the group.",
    "room-event-source",
    "-10111",
    undefined,
    false,
    undefined,
    "room_event",
  );
  expect(models.decision).not.toHaveBeenCalled();
  expect(models.embedded).toHaveBeenCalledTimes(1);
  const params = models.embedded.mock.calls[0]?.[0];
  expect(params).toMatchObject({
    sourceReplyDeliveryMode: "message_tool_only",
    terminalReplyExpectation: "optional",
  });
  expect(params?.disableMessageTool).not.toBe(true);
  expect(params?.permissionMode).not.toBe("read-only");
  expect(params?.reviewSettledDraft).toBeUndefined();
});

it("keeps explicit native group commands on the ordinary reply path", async () => {
  fixture.config.agents!.defaults!.model = { primary: "test-provider/test-model" };
  models.decision.mockImplementation(async (batch) => judgment(batch, { attention: "none" }));
  models.embedded.mockResolvedValue({
    payloads: [{ text: "The requested summary." }],
    meta: { durationMs: 1 },
  });
  const reply = await fixture.reply(
    "Summarize the deployment port.",
    "native-command-source",
    "-10110",
    undefined,
    false,
    "native",
  );
  expect(Array.isArray(reply) ? reply : [reply]).toEqual(
    expect.arrayContaining([expect.objectContaining({ text: "The requested summary." })]),
  );
  expect(models.decision).not.toHaveBeenCalled();
  expect(models.embedded).toHaveBeenCalledTimes(1);
});

it("keeps a selected generic CLI turn ordinary without a participation decision", async () => {
  fixture.config.agents!.defaults!.model = { primary: "fixture-cli/test-model" };
  models.cli.mockResolvedValue({
    payloads: [{ text: "Ordinary CLI reply." }],
    meta: { durationMs: 1 },
  });
  const reply = await fixture.reply("Bob, do you know the port?", "cli-source", "-10101");
  expect(reply).toMatchObject({ text: "Ordinary CLI reply." });
  expect(models.decision).not.toHaveBeenCalled();
  expect(models.embedded).not.toHaveBeenCalled();
  expect(models.cli).toHaveBeenCalledTimes(1);
  expect(models.cli.mock.calls[0]?.[0]).toMatchObject({ terminalReplyExpectation: "required" });
});

it("restores ordinary policy before a private embedded attempt falls back to CLI", async () => {
  fixture.config.agents!.defaults!.model = {
    primary: "test-provider/test-model",
    fallbacks: ["fixture-cli/test-model"],
  };
  models.decision.mockImplementation(async (batch) =>
    judgment(batch, { attention: "opportunity" }),
  );
  models.embedded.mockRejectedValue(
    new FailoverError("Synthetic provider outage", {
      reason: "rate_limit",
      provider: "test-provider",
      model: "test-model",
    }),
  );
  models.cli.mockResolvedValue({
    payloads: [{ text: "Ordinary fallback reply." }],
    meta: { durationMs: 1 },
  });
  const reply = await fixture.reply("Bob, do you know the port?", "cli-fallback-source", "-10102");
  expect(reply).toMatchObject({ text: "Ordinary fallback reply." });
  expect(models.embedded).toHaveBeenCalledTimes(1);
  expect(models.embedded.mock.calls[0]?.[0]).toMatchObject({
    permissionMode: "read-only",
    terminalReplyExpectation: "optional",
  });
  expect(models.cli).toHaveBeenCalledTimes(1);
  expect(models.cli.mock.calls[0]?.[0]).toMatchObject({
    terminalReplyExpectation: "required",
    sourceReplyDeliveryMode: "automatic",
  });
});

it("keeps ordinary behavior when the initial Decision Model is unavailable", async () => {
  fixture.config.agents!.defaults!.model = { primary: "test-provider/test-model" };
  models.decision.mockResolvedValue({ status: "unavailable", reason: "overloaded" });
  models.embedded.mockResolvedValue({
    payloads: [{ text: "Ordinary embedded reply." }],
    meta: { durationMs: 1 },
  });
  const reply = await fixture.reply(
    "Bob, do you know the port?",
    "initial-outage-source",
    "-10103",
  );
  expect(Array.isArray(reply) ? reply : [reply]).toEqual(
    expect.arrayContaining([expect.objectContaining({ text: "Ordinary embedded reply." })]),
  );
  expect(models.embedded).toHaveBeenCalledTimes(1);
  expect(models.embedded.mock.calls[0]?.[0]).toMatchObject({
    terminalReplyExpectation: "required",
  });
  expect(models.embedded.mock.calls[0]?.[0].reviewSettledDraft).toBeUndefined();
  expect(models.embedded.mock.calls[0]?.[0].permissionMode).not.toBe("read-only");
  expect(models.cli).not.toHaveBeenCalled();
});
