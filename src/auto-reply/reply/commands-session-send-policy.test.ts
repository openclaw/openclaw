import { expect, it } from "vitest";
import { handleSendPolicyCommand } from "./commands-session.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

it.each([
  ["/send on", "⚙️ Send policy set to on."],
  ["/send: on", "⚙️ Send policy set to on."],
  ["/send", "⚙️ Usage: /send on|off|inherit"],
  ["/send:", "⚙️ Usage: /send on|off|inherit"],
  ["send on", null],
  ["send", null],
] as const)("requires slash for send policy: %s", async (body, text) => {
  const params = buildCommandTestParams(body, { commands: { text: true } });
  Object.assign(params.command, {
    commandBodyNormalized: body,
    isAuthorizedSender: true,
    senderIsOwner: true,
  });
  await expect(handleSendPolicyCommand(params, true)).resolves.toEqual(
    text === null ? null : { shouldContinue: false, reply: { text } },
  );
});
