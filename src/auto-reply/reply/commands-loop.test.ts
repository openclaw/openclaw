import { expect, it } from "vitest";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { normalizeCommandBody } from "../commands-registry-normalize.js";
import { handleLoopCommand } from "./commands-loop.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

function buildLoopParams(commandBodyNormalized: string): HandleCommandsParams {
  const params = buildCommandTestParams(
    commandBodyNormalized,
    {},
    {
      Provider: INTERNAL_MESSAGE_CHANNEL,
      Surface: INTERNAL_MESSAGE_CHANNEL,
      BodyForAgent: commandBodyNormalized,
    },
  );
  Object.assign(params.command, { isAuthorizedSender: true, senderIsOwner: true });
  params.sessionKey = "agent:main:webchat:test";
  return params;
}

async function rewrite(body: string): Promise<string> {
  const params = buildLoopParams(body);
  expect(await handleLoopCommand(params, true)).toEqual({ shouldContinue: true });
  return params.ctx.BodyForAgent ?? "";
}

const LOOP_PREFIX = "loop[88ddaa69d4c0]";

it("ignores non-loop text", async () => {
  expect(await handleLoopCommand(buildLoopParams("check ci"), true)).toBeNull();
});

it("returns usage for bare /loop without continuing", async () => {
  expect(await handleLoopCommand(buildLoopParams("/loop"), true)).toMatchObject({
    shouldContinue: false,
    reply: { text: expect.stringContaining("Usage: /loop [interval] <prompt>") },
  });
});

it("keeps multiline prompts in a current-session fixed-interval loop", async () => {
  const body = await rewrite(normalizeCommandBody("/loop 5m check these:\n- CI\n- deploy"));
  expect(body).toContain('schedule:{kind:"every",everyMs:300000}');
  expect(body).toContain('sessionTarget:"current"');
  expect(body).toContain(`name:"${LOOP_PREFIX} check these: - CI - deploy"`);
  expect(body).toContain(
    'message:"[loop check these: - CI - deploy] check these:\\n- CI\\n- deploy\\nDo the task',
  );
  expect(body).toContain("do not use the message tool");
  expect(body).toContain("with the automations tool");
  expect(body).not.toMatch(/\bcron tool\b/);
});

it("rewrites an interval-free loop with pacing and next_check guidance", async () => {
  const body = await rewrite("/loop watch for new github issues");
  expect(body).toContain('pacing:{min:"1m",max:"1h"}');
  expect(body).toContain('action:\\"next_check\\"');
  expect(body).toContain('in:\\"<duration>\\"');
});

it.each(["status", "stop"])("rewrites /loop %s as a scoped work order", async (command) => {
  const body = await rewrite(`/loop ${command}`);
  expect(body).toContain('action:"list", includeDisabled:true');
  expect(body).toContain(`name starts with "${LOOP_PREFIX}"`);
  if (command === "stop") {
    expect(body).toContain('action:"remove"');
    expect(body).toContain(`Never remove a job whose name does not start with "${LOOP_PREFIX}"`);
  } else {
    expect(body).toContain("Use the automations tool");
    expect(body).not.toMatch(/\bcron\b/i);
  }
});

it.each([
  { isAuthorizedSender: false, senderIsOwner: true, expected: { shouldContinue: false } },
  {
    isAuthorizedSender: true,
    senderIsOwner: false,
    expected: {
      shouldContinue: false,
      reply: { text: expect.stringContaining("operator.admin") },
    },
  },
])("rejects authorization $isAuthorizedSender / ownership $senderIsOwner", async (row) => {
  const params = buildLoopParams("/loop 5m check ci");
  Object.assign(params.command, row);
  expect(await handleLoopCommand(params, true)).toEqual(row.expected);
  expect(params.ctx.BodyForAgent).toBe("/loop 5m check ci");
});

it("rejects intervals below 30 seconds", async () => {
  const result = await handleLoopCommand(buildLoopParams("/loop 5s x"), true);

  expect(result?.shouldContinue).toBe(false);
  expect(result?.reply?.text).toContain("Minimum interval 30s");
});
