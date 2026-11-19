import { expect, it } from "vitest";
import { FailoverError } from "../../agents/failover-error.js";
import { judgment } from "./group-participation.decision.test-support.js";
import { fixture, models } from "./group-participation.runner.test-support.js";

it.each([
  ["engagement", "instant", true],
  ["opportunity", "message", true],
  ["none", "instant", false],
  ["engagement", "never", false],
] as const)(
  "starts typing after participation (%s, %s)",
  async (attention, typingMode, shouldType) => {
    fixture.config.agents!.defaults!.typingMode = typingMode;
    models.decision.mockImplementation(async (batch) => {
      expect(fixture.typing()).toBe(0);
      return judgment(batch, { attention });
    });
    models.embedded.mockImplementation(async () => {
      expect(fixture.typing() > 0).toBe(shouldType);
      return { payloads: [{ text: "Approved reply." }], meta: { durationMs: 1 } };
    });
    await fixture.reply("Bob, which port?", "typing-order-source", "-10114");
    expect(fixture.typing() > 0).toBe(shouldType);
    expect(models.embedded).toHaveBeenCalledTimes(attention === "none" ? 0 : 1);
  },
);

it.each([
  "room-event",
  "native-command",
  "generic-cli",
  "mention",
  "assistance-absent",
  "assistance-off",
] as const)("keeps %s on the ordinary reply path", async (entry) => {
  const cli = entry === "generic-cli";
  const roomEvent = entry === "room-event";
  fixture.config.agents!.defaults!.model = {
    primary: cli ? "fixture-cli/test-model" : "test-provider/test-model",
  };
  if (entry.startsWith("assistance-")) {
    fixture.config.agents!.defaults!.experimental = {
      decisionAssistance: entry === "assistance-off" ? false : undefined,
    };
  }
  models.decision.mockImplementation(async (batch) => judgment(batch, { attention: "none" }));
  models.embedded.mockResolvedValue({
    payloads: roomEvent ? [] : [{ text: "Ordinary reply." }],
    meta: {
      durationMs: 1,
      ...(roomEvent ? { terminalReply: { disposition: "silent" as const } } : {}),
    },
  });
  models.cli.mockResolvedValue({
    payloads: [{ text: "Ordinary reply." }],
    meta: { durationMs: 1 },
  });
  const reply = await fixture.reply(
    roomEvent ? "Alice joined the group." : "Summarize the port.",
    entry,
    "-10110",
    undefined,
    entry === "mention",
    entry === "native-command" ? "native" : undefined,
    roomEvent ? "room_event" : undefined,
  );
  expect(
    (Array.isArray(reply) ? reply : [reply]).flatMap((payload) =>
      payload?.text ? [payload.text] : [],
    ),
  ).toEqual(roomEvent ? [] : ["Ordinary reply."]);
  expect(models.decision).not.toHaveBeenCalled();
  expect(models.embedded).toHaveBeenCalledTimes(cli ? 0 : 1);
  expect(models.cli).toHaveBeenCalledTimes(cli ? 1 : 0);
  expect((cli ? models.cli : models.embedded).mock.calls[0]?.[0]).toMatchObject({
    terminalReplyExpectation: roomEvent ? "optional" : "required",
  });
  if (!cli) {
    const params = models.embedded.mock.calls[0]?.[0];
    expect(params?.disableMessageTool).not.toBe(true);
    expect(params?.permissionMode).not.toBe("read-only");
    if (roomEvent) {
      expect(params?.sourceReplyDeliveryMode).toBe("message_tool_only");
    }
  }
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
