import { describe, expect, it, vi } from "vitest";

const { listBySessionMock } = vi.hoisted(() => ({
  listBySessionMock: vi.fn(),
}));

vi.mock("../../../infra/outbound/session-binding-service.js", () => ({
  getSessionBindingService: () => ({
    listBySession: listBySessionMock,
  }),
}));

import { handleSubagentsAgentsAction } from "./action-agents.js";

describe("handleSubagentsAgentsAction", () => {
  it("dedupes stale bound rows for the same child session", () => {
    const childSessionKey = "agent:main:subagent:worker";
    listBySessionMock.mockImplementation((sessionKey: string) =>
      sessionKey === childSessionKey
        ? [
            {
              bindingId: "binding-1",
              targetSessionKey: childSessionKey,
              targetKind: "subagent",
              conversation: {
                channel: "discord",
                accountId: "default",
                conversationId: "thread-1",
              },
              status: "active",
              boundAt: Date.now() - 20_000,
            },
          ]
        : [],
    );

    const result = handleSubagentsAgentsAction({
      params: {
        ctx: {
          Provider: "discord",
          Surface: "discord",
        },
        command: {
          channel: "discord",
        },
      },
      requesterKey: "agent:main:main",
      runs: [
        {
          runId: "run-current",
          childSessionKey,
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "current worker label",
          cleanup: "keep",
          createdAt: Date.now() - 10_000,
          startedAt: Date.now() - 10_000,
        },
        {
          runId: "run-stale",
          childSessionKey,
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "stale worker label",
          cleanup: "keep",
          createdAt: Date.now() - 20_000,
          startedAt: Date.now() - 20_000,
          endedAt: Date.now() - 15_000,
          outcome: { status: "ok" },
        },
      ],
      restTokens: [],
    } as never);

    expect(result.reply?.text).toContain("current worker label");
    expect(result.reply?.text).not.toContain("stale worker label");
  });
});
