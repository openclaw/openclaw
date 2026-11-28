import { beforeEach, expect, it, vi } from "vitest";
import { adoptTalkConsultRun } from "./chat-realtime.ts";
import { adoptStartedChatRun } from "./run-lifecycle.ts";

vi.mock("./run-lifecycle.ts", () => ({ adoptStartedChatRun: vi.fn() }));

type Host = Parameters<typeof adoptTalkConsultRun>[0];
const host = (overrides: Partial<Host> = {}) =>
  ({ sessionKey: "agent:main:main", chatRunId: null, ...overrides }) as Host;

beforeEach(() => vi.mocked(adoptStartedChatRun).mockClear());

it("adopts an accepted Talk consult run for the chat the call belongs to", () => {
  const chat = host();
  adoptTalkConsultRun(chat, { runId: "run-1", sessionKey: "agent:main:main" });
  expect(adoptStartedChatRun).toHaveBeenCalledExactlyOnceWith(chat, "run-1", expect.any(Number));
});

it("leaves another chat or an already active run alone", () => {
  adoptTalkConsultRun(host(), { runId: "run-1", sessionKey: "agent:main:other" });
  adoptTalkConsultRun(host({ chatRunId: "run-0" }), {
    runId: "run-1",
    sessionKey: "agent:main:main",
  });
  expect(adoptStartedChatRun).not.toHaveBeenCalled();
});
