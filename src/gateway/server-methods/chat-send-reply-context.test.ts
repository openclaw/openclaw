import { beforeEach, expect, it, vi } from "vitest";
import { resolveChatSendReplyContext } from "./chat-send-reply-context.js";

const read = vi.hoisted(() => vi.fn());
// mock-isolation: Reply projection uses supplied messages and read failures, not a live transcript.
vi.mock("../session-transcript-readers.js", () => ({ readSessionMessageByIdAsync: read }));
const base = {
  replyToId: "msg-1",
  cfg: { agents: { entries: { main: { identity: { name: "Molty" } } } } },
  agentId: "main",
  sessionKey: "agent:main:webchat",
  sessionEntry: { sessionFile: "session.jsonl", sessionId: "session-1" },
  storePath: "/tmp/sessions.json",
};
type Options = Partial<Parameters<typeof resolveChatSendReplyContext>[0]>;
const resolve = (options: Options = {}) => resolveChatSendReplyContext({ ...base, ...options });
function resolveMessage(message: Record<string, unknown>, options: Options = {}) {
  read.mockResolvedValue({ found: true, message });
  return resolve(options);
}
beforeEach(() => {
  read.mockReset().mockResolvedValue({ found: false });
});

it.each([
  ["missing reply id", { replyToId: undefined }, {}, 0],
  ["blank reply id", { replyToId: "  " }, {}, 0],
  ["missing session", { sessionEntry: undefined }, { ReplyToId: "msg-1" }, 0],
  ["missing message", {}, { ReplyToId: "msg-1" }, 1],
] as const)("returns only available fields for %s", async (_name, options, expected, reads) => {
  expect(await resolve(options)).toEqual(expected);
  expect(read).toHaveBeenCalledTimes(reads);
});

it("tolerates read failures and warns", async () => {
  read.mockRejectedValue(new Error("transcript unavailable"));
  const warn = vi.fn();
  expect(await resolve({ warn })).toEqual({ ReplyToId: "msg-1" });
  expect(warn).toHaveBeenCalledOnce();
});

it("hydrates display-visible assistant content without tool payloads", async () => {
  const fields = await resolveMessage({
    role: "assistant",
    content: [
      { type: "text", text: "visible answer" },
      { type: "text", text: '<tool_call>{"name":"exec","arguments":{}}</tool_call>' },
    ],
  });
  expect(fields).toMatchObject({
    ReplyToBody: expect.stringContaining("visible answer"),
    ReplyToSender: "Molty",
  });
  expect(fields.ReplyToBody).not.toContain("tool_call");
});

it.each([
  [
    "user",
    "[Sat 2026-07-18 11:31 MDT] Which stage runs the integration tests?",
    { ReplyToBody: "Which stage runs the integration tests?", ReplyToSender: "Ada" },
  ],
  ["assistant", [{ type: "text", text: "NO_REPLY" }], {}],
] as const)("projects %s reply targets", async (role, content, expected) => {
  expect(await resolveMessage({ role, content }, { userSenderLabel: "Ada" })).toEqual({
    ReplyToId: "msg-1",
    ...expected,
  });
});
