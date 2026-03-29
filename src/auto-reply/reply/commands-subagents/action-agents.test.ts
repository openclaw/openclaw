import { beforeEach, describe, expect, it, vi } from "vitest";

const { listBySessionMock } = vi.hoisted(() => ({
  listBySessionMock: vi.fn(),
}));

vi.mock("../../../infra/outbound/session-binding-service.js", () => ({
  getSessionBindingService: () => ({
    listBySession: listBySessionMock,
  }),
}));

let handleSubagentsAgentsAction: typeof import("./action-agents.js").handleSubagentsAgentsAction;

describe("handleSubagentsAgentsAction", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ handleSubagentsAgentsAction } = await import("./action-agents.js"));
    listBySessionMock.mockReset();
  });

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

  it("keeps /agents numbering aligned with target resolution when hidden recent rows exist", () => {
    const hiddenSessionKey = "agent:main:subagent:hidden-recent";
    const visibleSessionKey = "agent:main:subagent:visible-bound";
    listBySessionMock.mockImplementation((sessionKey: string) =>
      sessionKey === visibleSessionKey
        ? [
            {
              bindingId: "binding-visible",
              targetSessionKey: visibleSessionKey,
              targetKind: "subagent",
              conversation: {
                channel: "discord",
                accountId: "default",
                conversationId: "thread-visible",
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
          runId: "run-hidden-recent",
          childSessionKey: hiddenSessionKey,
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "hidden recent worker",
          cleanup: "keep",
          createdAt: Date.now() - 10_000,
          startedAt: Date.now() - 10_000,
          endedAt: Date.now() - 5_000,
          outcome: { status: "ok" },
        },
        {
          runId: "run-visible-bound",
          childSessionKey: visibleSessionKey,
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "visible bound worker",
          cleanup: "keep",
          createdAt: Date.now() - 20_000,
          startedAt: Date.now() - 20_000,
          endedAt: Date.now() - 15_000,
          outcome: { status: "ok" },
        },
      ],
      restTokens: [],
    } as never);

    expect(result.reply?.text).toContain("2. visible bound worker");
    expect(result.reply?.text).not.toContain("1. visible bound worker");
    expect(result.reply?.text).not.toContain("hidden recent worker");
  });

  it("shows matrix runs as unbound instead of claiming only discord/telegram bindings", () => {
    listBySessionMock.mockReturnValue([]);

    const result = handleSubagentsAgentsAction({
      params: {
        ctx: {
          Provider: "matrix",
          Surface: "matrix",
        },
        command: {
          channel: "matrix",
        },
      },
      requesterKey: "agent:main:main",
      runs: [
        {
          runId: "run-matrix-worker",
          childSessionKey: "agent:main:subagent:matrix-worker",
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "matrix worker",
          cleanup: "keep",
          createdAt: Date.now() - 20_000,
          startedAt: Date.now() - 20_000,
        },
      ],
      restTokens: [],
    } as never);

    expect(result.reply?.text).toContain("matrix worker (unbound)");
    expect(result.reply?.text).not.toContain("bindings available on discord/telegram");
  });

  it("formats matrix bindings as threads", () => {
    const childSessionKey = "agent:main:subagent:matrix-bound";
    listBySessionMock.mockImplementation((sessionKey: string) =>
      sessionKey === childSessionKey
        ? [
            {
              bindingId: "binding-matrix",
              targetSessionKey: childSessionKey,
              targetKind: "subagent",
              conversation: {
                channel: "matrix",
                accountId: "default",
                conversationId: "room-thread-1",
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
          Provider: "matrix",
          Surface: "matrix",
        },
        command: {
          channel: "matrix",
        },
      },
      requesterKey: "agent:main:main",
      runs: [
        {
          runId: "run-matrix-bound",
          childSessionKey,
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "matrix bound worker",
          cleanup: "keep",
          createdAt: Date.now() - 20_000,
          startedAt: Date.now() - 20_000,
        },
      ],
      restTokens: [],
    } as never);

    expect(result.reply?.text).toContain("matrix bound worker (thread:room-thread-1)");
    expect(result.reply?.text).not.toContain("binding:room-thread-1");
  });
});
