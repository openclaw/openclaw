import { beforeEach, expect, it, vi } from "vitest";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import { buildCommandContext } from "./commands-context.js";
import { handleInlineActions } from "./get-reply-inline-actions.js";
import {
  createHandleInlineActionsInput,
  createTypingController,
} from "./get-reply-inline-actions.test-support.js";
import { buildTestCtx } from "./test-ctx.js";

const execute = vi.hoisted(() => vi.fn());

// mock-isolation: Keep command dispatch and parsing real; isolate the external shell.
vi.mock("../../agents/bash-tools.js", () => ({
  createExecTool: () => ({ execute }),
}));

beforeEach(() => {
  execute.mockReset().mockResolvedValue({
    content: [{ type: "text", text: "fixture output" }],
    details: { status: "completed", exitCode: 0, aggregated: "fixture output" },
  });
});

function bashInput(
  body: string,
  options: { authorized?: boolean; group?: boolean; literal?: boolean } = {},
) {
  const { authorized = true, group = false, literal = false } = options;
  const cfg = {
    commands: { bash: true, text: true },
    messages: { groupChat: { mentionPatterns: ["@bot"] } },
  };
  const ctx = buildTestCtx({
    Body: body,
    CommandBody: body,
    CommandAuthorized: authorized,
    CommandInterpretationSuppressed: literal,
    ChatType: group ? "group" : "direct",
    WasMentioned: group,
  });
  const command = buildCommandContext(
    { ctx, cfg, agentId: "main", isGroup: group, triggerBodyNormalized: body },
    { ownerList: [], senderIsOwner: authorized, isAuthorizedSender: authorized },
  );
  return createHandleInlineActionsInput({
    ctx,
    command,
    typing: createTypingController(),
    cleanedBody: body,
    overrides: {
      cfg,
      isGroup: group,
      sessionKey: "agent:main:main",
      allowTextCommands: true,
      elevatedEnabled: true,
      elevatedAllowed: true,
    },
  });
}

it.each([
  ["! printf fixture", "printf fixture"],
  ["!(printf fixture)", "(printf fixture)"],
  ["/bash printf fixture", "printf fixture"],
  ["@bot ! printf fixture", "printf fixture"],
  ["![ -f fixture ]", "[ -f fixture ]"],
])("dispatches %s through the bash handler before a model turn", async (body, command) => {
  const result = await handleInlineActions(bashInput(body, { group: body.startsWith("@bot") }));
  expect(result).toMatchObject({
    kind: "reply",
    reply: { text: expect.stringContaining("fixture output") },
  });
  expect(execute).toHaveBeenCalledExactlyOnceWith(
    "chat-bash",
    expect.objectContaining({ command }),
  );
  if (result.kind !== "reply" || !result.reply || Array.isArray(result.reply)) {
    throw new Error("Expected a command reply");
  }
  expect(getReplyPayloadMetadata(result.reply)).toMatchObject({ commandReply: true });
});

it.each([true, false])("keeps Markdown images as chat with bash enabled=%s", async (enabled) => {
  for (const body of [
    "![diagram](https://example.com/diagram.png)",
    "![nested [diagram]][figure]",
  ]) {
    const input = bashInput(body);
    input.cfg.commands = { bash: enabled, text: true };
    expect(await handleInlineActions(input)).toMatchObject({ kind: "continue" });
    expect(execute).not.toHaveBeenCalled();
  }
});

it.each(["!poll", "! poll", "!stop", "/bash poll", "@bot ! poll"])(
  "handles %s without executing a shell",
  async (body) => {
    expect(
      await handleInlineActions(bashInput(body, { group: body.startsWith("@bot") })),
    ).toMatchObject({
      kind: "reply",
      reply: { text: "⚙️ No active bash job." },
    });
    expect(execute).not.toHaveBeenCalled();
  },
);

it("shows bash usage for a bare bang", async () => {
  expect(await handleInlineActions(bashInput("!"))).toMatchObject({
    kind: "reply",
    reply: { text: expect.stringContaining("⚙️ Usage:") },
  });
  expect(execute).not.toHaveBeenCalled();
});

it.each([
  { body: "hello ! poll" },
  { body: "explain !poll" },
  { body: "! printf fixture", authorized: false },
  { body: "! printf fixture", literal: true },
])("keeps non-command or gated input out of the shell: $body", async ({ body, ...options }) => {
  expect(await handleInlineActions(bashInput(body, options))).toMatchObject({ kind: "continue" });
  expect(execute).not.toHaveBeenCalled();
});

it("preserves the bash feature gate", async () => {
  const input = bashInput("! printf fixture");
  input.cfg.commands = { bash: false };
  expect(await handleInlineActions(input)).toMatchObject({
    kind: "reply",
    reply: { text: expect.stringContaining("bash is disabled") },
  });
  expect(execute).not.toHaveBeenCalled();
});
