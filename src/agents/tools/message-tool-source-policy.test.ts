import { describe, expect, it } from "vitest";
import { MessageActionDeniedError } from "../../infra/outbound/message-action-denial.js";
import {
  enforceSourceReplyOnlyMessageAction,
  isInertSourceReplyArgument,
  isInertSourceReplyArgumentValue,
} from "./message-tool-source-policy.js";

const SOURCE_CONTEXT = {
  currentChannelProvider: "workspace",
  currentChannelId: "SOURCE",
  currentMessagingTarget: "SOURCE",
  currentThreadTs: "thread-1",
  currentMessageId: "message-1",
  currentAccountId: "default",
};

function enforce(
  args: Record<string, unknown>,
  overrides: Partial<Parameters<typeof enforceSourceReplyOnlyMessageAction>[0]> = {},
): void {
  enforceSourceReplyOnlyMessageAction({
    action: "send",
    args,
    ...SOURCE_CONTEXT,
    ...overrides,
  });
}

function capturePolicyDenial(run: () => void): MessageActionDeniedError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(MessageActionDeniedError);
    const denial = error as MessageActionDeniedError;
    expect(denial.reasonCode).toBe("message_source_reply_policy_denied");
    expect(denial.policyRef).toBe("message-source-reply:current-conversation");
    return denial;
  }
  throw new Error("expected a message source-reply policy denial");
}

function expectPolicyDenied(run: () => void, message: RegExp): void {
  expect(capturePolicyDenial(run).message).toMatch(message);
}

describe("isInertSourceReplyArgumentValue", () => {
  const inertValues: Array<{ label: string; value: unknown }> = [
    { label: "undefined", value: undefined },
    { label: "null", value: null },
    { label: "empty string", value: "" },
    { label: "false", value: false },
    { label: "empty array", value: [] },
    { label: "empty object", value: {} },
    { label: "null-prototype object", value: Object.create(null) },
    { label: "empty presentation", value: { title: "", blocks: [] } },
    { label: "nested empty objects", value: { blocks: [], meta: { nested: { title: "" } } } },
  ];

  it.each(inertValues)("treats $label as inert", ({ value }) => {
    expect(isInertSourceReplyArgumentValue(value)).toBe(true);
  });

  const meaningfulValues: Array<{ label: string; value: unknown }> = [
    { label: "true", value: true },
    { label: "non-empty string", value: "text" },
    { label: "zero", value: 0 },
    { label: "positive number", value: 1 },
    { label: "negative number", value: -1 },
    { label: "NaN", value: Number.NaN },
    { label: "bigint", value: 0n },
    { label: "symbol", value: Symbol("marker") },
    { label: "function", value: () => undefined },
    { label: "array entry", value: ["channel:C123"] },
    { label: "array with empty string entry", value: [""] },
    { label: "date", value: new Date(0) },
    { label: "Map instance", value: new Map() },
    { label: "non-empty object", value: { title: "Hello" } },
    { label: "array inside object", value: { blocks: [{}] } },
    { label: "nested non-inert value", value: { meta: { enabled: true } } },
  ];

  it.each(meaningfulValues)("treats $label as meaningful", ({ value }) => {
    expect(isInertSourceReplyArgumentValue(value)).toBe(false);
  });

  it("fails closed past the nesting bound", () => {
    let value: unknown = {};
    for (let index = 0; index < 20; index += 1) {
      value = { nested: value };
    }
    expect(isInertSourceReplyArgumentValue(value)).toBe(false);
  });
});

describe("isInertSourceReplyArgument", () => {
  it("treats default-valued flags as inert", () => {
    expect(isInertSourceReplyArgument("bestEffort", true)).toBe(true);
    expect(isInertSourceReplyArgument("dryRun", false)).toBe(true);
  });

  it.each(["audioAsVoice", "asVideoNote", "gifPlayback", "track_tool_calls", "members"] as const)(
    "treats the send boolean alias %s: false as inert",
    (name) => {
      expect(isInertSourceReplyArgument(name, false)).toBe(true);
    },
  );

  it("keeps non-default flag values meaningful", () => {
    expect(isInertSourceReplyArgument("bestEffort", false)).toBe(false);
    expect(isInertSourceReplyArgument("dryRun", true)).toBe(false);
    expect(isInertSourceReplyArgument("unknownFlag", false)).toBe(false);
  });

  it("applies the value rules to non-boolean arguments", () => {
    expect(isInertSourceReplyArgument("targets", [])).toBe(true);
    expect(isInertSourceReplyArgument("targets", ["channel:C123"])).toBe(false);
  });
});

describe("enforceSourceReplyOnlyMessageAction completion send arguments", () => {
  const requiredArgs = { action: "send", message: "completion" };

  const inertArgumentCases: Array<{
    label: string;
    extraArgs: Record<string, unknown>;
    allowlisted?: true;
  }> = [
    { label: "empty targets", extraArgs: { targets: [] } },
    { label: "empty channelIds", extraArgs: { channelIds: [] } },
    { label: "empty attachments", extraArgs: { attachments: [] }, allowlisted: true },
    { label: "empty media", extraArgs: { media: "" }, allowlisted: true },
    { label: "explicit non-dry-run", extraArgs: { dryRun: false } },
    { label: "default best-effort", extraArgs: { bestEffort: true } },
    { label: "disabled gif playback", extraArgs: { gifPlayback: false } },
    { label: "snake_case track-tool-calls off", extraArgs: { track_tool_calls: false } },
    { label: "empty presentation", extraArgs: { presentation: { title: "", blocks: [] } } },
    {
      label: "nested empty presentation fields",
      extraArgs: { presentation: { title: "", blocks: [], meta: { nested: {} } } },
    },
    { label: "unknown empty option", extraArgs: { metadata: {} } },
  ];

  it.each(inertArgumentCases)(
    "accepts $label alongside the required args",
    ({ extraArgs, allowlisted }) => {
      const args = { ...requiredArgs, ...extraArgs };
      expect(() => enforce(args)).not.toThrow();
      // Non-allowlisted inert keys are dropped from the dispatch copy: presence
      // alone is intent downstream (an own `targets: []` suppresses routing).
      expect(args).toEqual(allowlisted ? { ...requiredArgs, ...extraArgs } : requiredArgs);
    },
  );

  it("keeps allowlisted completion controls and content", () => {
    expect(() => enforce({ ...requiredArgs, final: false })).not.toThrow();
    expect(() => enforce({ ...requiredArgs, final: true })).not.toThrow();
    // `media` is an allowlisted send payload, so a URL is valid completion content.
    expect(() =>
      enforce({ ...requiredArgs, media: "https://example.com/photo.png" }),
    ).not.toThrow();
  });

  const meaningfulArgumentCases: Array<{
    label: string;
    extraArgs: Record<string, unknown>;
    argumentName: string;
  }> = [
    {
      label: "populated targets",
      extraArgs: { targets: ["channel:C123"] },
      argumentName: "targets",
    },
    {
      label: "populated channelIds",
      extraArgs: { channelIds: ["C123"] },
      argumentName: "channelIds",
    },
    { label: "enabled dryRun", extraArgs: { dryRun: true }, argumentName: "dryRun" },
    { label: "durable best-effort", extraArgs: { bestEffort: false }, argumentName: "bestEffort" },
    { label: "unknown true flag", extraArgs: { urgent: true }, argumentName: "urgent" },
    { label: "unknown false flag", extraArgs: { urgent: false }, argumentName: "urgent" },
    {
      label: "non-empty unknown object",
      extraArgs: { metadata: { source: "agent" } },
      argumentName: "metadata",
    },
    {
      label: "presentation with content",
      extraArgs: { presentation: { title: "Hi", blocks: [] } },
      argumentName: "presentation",
    },
  ];

  it.each(meaningfulArgumentCases)(
    "rejects $label with the policy denial",
    ({ extraArgs, argumentName }) => {
      expectPolicyDenied(
        () => enforce({ ...requiredArgs, ...extraArgs }),
        new RegExp(`"${argumentName}"`),
      );
    },
  );

  it("preserves the existing directive and destination checks", () => {
    expectPolicyDenied(
      () => enforce({ message: "[[reply_to:message-2]] stolen thread" }),
      /reply\/audio directives/,
    );
    expectPolicyDenied(() => enforce({ ...requiredArgs, channel: "telegram" }), /another channel/);
    expectPolicyDenied(
      () => enforce({ ...requiredArgs, accountId: "other-account" }),
      /another channel account/,
    );
    expectPolicyDenied(() => enforce({ ...requiredArgs, threadId: "thread-2" }), /another thread/);
    expectPolicyDenied(
      () => enforce({ ...requiredArgs, replyTo: "message-2" }),
      /reply outside the current thread/,
    );
    expectPolicyDenied(
      () => enforce({ ...requiredArgs, target: "channel:other" }),
      /another conversation or thread/,
    );
    expectPolicyDenied(
      () =>
        enforce(
          { ...requiredArgs },
          { currentChannelId: undefined, currentMessagingTarget: undefined },
        ),
      /authoritative current conversation/,
    );
    expectPolicyDenied(
      () =>
        enforceSourceReplyOnlyMessageAction({
          action: "delete",
          args: requiredArgs,
          ...SOURCE_CONTEXT,
        }),
      /only action "send"/,
    );
  });

  it("accepts explicit routing that matches the authoritative source", () => {
    expect(() =>
      enforce({
        action: "send",
        channel: "workspace",
        target: "SOURCE",
        accountId: "default",
        threadId: "thread-1",
        replyTo: "message-1",
        message: "completion",
        final: false,
      }),
    ).not.toThrow();
  });
});
