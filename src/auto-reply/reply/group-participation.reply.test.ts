import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { TOOL_CALL_RAW_TOOL_NAME } from "../../agents/tool-catalog.js";
import { readRecentUserAssistantTextForSession } from "../../config/sessions/transcript.js";
import {
  createGroupReplyFixture,
  decision,
  judgment,
} from "./group-participation.reply.test-support.js";

const answer = (content: string) => ({ delta: { role: "assistant", content } });
let fixture: Awaited<ReturnType<typeof createGroupReplyFixture>>;
beforeEach(async () => {
  fixture = await createGroupReplyFixture();
  decision.mockReset().mockResolvedValue(judgment("reply"));
});
afterEach(async () => {
  await fixture.close();
});
function systemMessages(request: unknown) {
  if (!isRecord(request) || !Array.isArray(request.messages)) {
    throw new Error("Expected provider messages");
  }
  return request.messages.filter(
    (message: unknown) => isRecord(message) && message.role === "system",
  );
}

it.each([
  ["silent", 0],
  ["text", 1],
  ["message-tool", 2],
  ["reaction", 2],
] as const)("persists and delivers %s participation", async (mode, primaryRequests) => {
  await writeFile(
    join(fixture.config.agents!.defaults!.workspace!, "IDENTITY.md"),
    "- **Name:** Cactux\n",
  );
  if (mode === "text") {
    fixture.config.agents!.entries!.main!.identity = { name: "Configured" };
  }
  decision.mockResolvedValue(judgment(mode === "silent" ? "silent" : "reply"));
  const onAdopted = vi.fn();
  const onAbandoned = vi.fn();
  const reactionOnly = mode === "reaction";
  const messageToolOnly = mode === "message-tool" || reactionOnly;
  if (reactionOnly) {
    fixture.config.agents!.defaults!.silentReply = { group: "allow" };
  }
  const input = reactionOnly ? "Thanks for sorting that out!" : "Bob, which TLS port?";
  const text = "The TLS port is 443.";
  if (messageToolOnly) {
    fixture.respond(
      {
        delta: {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "reply",
              type: "function",
              function: {
                name: TOOL_CALL_RAW_TOOL_NAME,
                arguments: JSON.stringify({
                  id: "message",
                  args: reactionOnly
                    ? { action: "react", emoji: "🙌", messageId: "delivery-reaction", final: true }
                    : { action: "send", message: text, final: true },
                }),
              },
            },
          ],
        },
        stop: "tool_calls",
      },
      answer("NO_REPLY"),
    );
  } else {
    fixture.respond(answer(text));
  }
  await fixture.dispatch(
    input,
    `delivery-${mode}`,
    "-10001",
    {
      sourceReplyDeliveryMode: messageToolOnly ? "message_tool_only" : "automatic",
      turnAdoptionLifecycle: { onAdopted, onAbandoned },
    },
    reactionOnly ? { SenderIsBot: true, InboundEventKind: "user_request" } : undefined,
  );
  expect(decision).toHaveBeenCalledOnce();
  expect(decision.mock.calls[0]?.[0]).toMatchObject({
    state: { agentName: mode === "text" ? "Configured" : "Cactux" },
  });
  expect(fixture.requests).toHaveLength(primaryRequests);
  expect(fixture.sent).toEqual(mode === "silent" || reactionOnly ? [] : [text]);
  expect(fixture.reactions).toEqual(
    reactionOnly ? [{ emoji: "🙌", messageId: "delivery-reaction" }] : [],
  );
  expect(onAdopted).toHaveBeenCalledOnce();
  expect(onAbandoned).not.toHaveBeenCalled();
  const history = await readRecentUserAssistantTextForSession({
    agentId: "main",
    sessionKey: "agent:main:telegram:group:-10001",
    storePath: fixture.storePath,
  });
  expect(history).toContainEqual(
    expect.objectContaining({ role: "user", text: expect.stringContaining(input) }),
  );
  if (reactionOnly) {
    expect(JSON.stringify(fixture.requests[0])).not.toContain("Default: stay silent.");
    expect(JSON.stringify(fixture.requests[0])).not.toContain("NO_REPLY");
  }
  if (mode === "text") {
    const first = fixture.requests[0];
    expect(JSON.stringify(first)).not.toContain("NO_REPLY");
    expect(JSON.stringify(first)).not.toContain("mostly lurk");
    const prefix = systemMessages(first);
    expect(prefix).toHaveLength(1);
    fixture.respond(answer("NO_REPLY"));
    const settled = createDeferred();
    const ordinary = await fixture.dispatch(
      "Please check again.",
      "ordinary-mention",
      "-10001",
      {
        onQueuedFollowupSettled: () => settled.resolve(),
      },
      { WasMentioned: true },
    );
    if (ordinary.deferredToActiveRun) {
      await settled.promise;
    }
    expect(fixture.requests).toHaveLength(2);
    expect(systemMessages(fixture.requests.at(-1))).toEqual(prefix);
    expect(JSON.stringify(fixture.requests.at(-1))).toContain("NO_REPLY");
    expect(JSON.stringify(fixture.requests.at(-1))).toContain("mostly lurk");
    expect(decision).toHaveBeenCalledOnce();
    expect(fixture.sent).toEqual([text]);
  }
});

it.each(["off", "command", "audio", "internal", "unavailable"] as const)(
  "preserves the ordinary %s path",
  async (mode) => {
    if (mode === "off") {
      fixture.config.agents!.defaults!.experimental = { decisionAssistance: false };
    }
    if (mode === "unavailable") {
      decision.mockResolvedValue({ status: "unavailable", reason: "overloaded" });
    }
    fixture.respond(answer("NO_REPLY"));
    const reply = await fixture.reply(
      "Check the port.",
      `ordinary-${mode}`,
      "-10003",
      undefined,
      mode === "command"
        ? { CommandSource: "native", CommandAuthorized: true }
        : mode === "audio"
          ? {
              Transcript: "Check the port.",
              media: [{ path: "/tmp/voice.ogg", kind: "audio", transcribed: true }],
            }
          : mode === "internal"
            ? { InputProvenance: { kind: "internal_system" } }
            : undefined,
    );
    expect([reply].flat().flatMap((payload) => (payload?.text ? [payload.text] : []))).toEqual([]);
    expect(fixture.requests).toHaveLength(1);
    expect(decision).toHaveBeenCalledTimes(mode === "unavailable" ? 1 : 0);
    expect(JSON.stringify(fixture.requests[0])).toContain("NO_REPLY");
  },
);
