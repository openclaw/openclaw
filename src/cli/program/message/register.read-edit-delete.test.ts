// Register read/edit/delete/unsend tests cover message mutation command wiring.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageCliHelpers } from "./helpers.js";
import { registerMessageReadEditDeleteCommands } from "./register.read-edit-delete.js";

function createHelpers(runMessageAction: MessageCliHelpers["runMessageAction"]): MessageCliHelpers {
  return {
    withMessageBase: (command) => command.option("--channel <channel>", "Channel"),
    withMessageTarget: (command) => command.option("-t, --target <dest>", "Target"),
    withRequiredMessageTarget: (command) => command.requiredOption("-t, --target <dest>", "Target"),
    runMessageAction,
  };
}

function firstMessageActionCall(runMessageAction: { mock: { calls: unknown[][] } }) {
  return runMessageAction.mock.calls[0] as [string, Record<string, unknown>] | undefined;
}

describe("registerMessageReadEditDeleteCommands", () => {
  const runMessageAction = vi.fn(
    async (_action: string, _opts: Record<string, unknown>) => undefined,
  );

  beforeEach(() => {
    runMessageAction.mockClear();
  });

  it("routes unsend through the message action runner", async () => {
    const message = new Command().exitOverride();
    registerMessageReadEditDeleteCommands(message, createHelpers(runMessageAction));

    await message.parseAsync(
      ["unsend", "--channel", "whatsapp", "-t", "+1555", "--message-id", "msg-123"],
      { from: "user" },
    );

    const call = firstMessageActionCall(runMessageAction);
    expect(call?.[0]).toBe("unsend");
    expect(call?.[1]?.channel).toBe("whatsapp");
    expect(call?.[1]?.target).toBe("+1555");
    expect(call?.[1]?.messageId).toBe("msg-123");
  });
});
