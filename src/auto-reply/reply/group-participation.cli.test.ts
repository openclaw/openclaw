import { expect, it } from "vitest";
import { FailoverError } from "../../agents/failover-error.js";
import { judgment } from "./group-participation.decision.test-support.js";
import { fixture, models } from "./group-participation.runner.test-support.js";

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

it("preserves ordinary policy when an admitted embedded reply falls back to CLI", async () => {
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
    terminalReplyExpectation: "required",
  });
  expect(models.embedded.mock.calls[0]?.[0].permissionMode).not.toBe("read-only");
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
  expect(models.embedded.mock.calls[0]?.[0].permissionMode).not.toBe("read-only");
  expect(models.cli).not.toHaveBeenCalled();
});
