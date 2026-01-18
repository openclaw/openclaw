import { beforeEach, describe, expect, it, vi } from "vitest";

const dispatchMock = vi.fn();
const readAllowFromMock = vi.fn();

vi.mock("../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: (...args: unknown[]) => readAllowFromMock(...args),
  upsertChannelPairingRequest: vi.fn(),
}));

describe("signal event handler sender prefix", () => {
  beforeEach(() => {
    dispatchMock.mockReset().mockImplementation(async ({ dispatcher, ctx }) => {
      dispatcher.sendFinalReply({ text: "ok" });
      return { queuedFinal: true, counts: { final: 1 }, ctx };
    });
    readAllowFromMock.mockReset().mockResolvedValue([]);
  });

  it("prefixes group bodies with sender label", async () => {
    let capturedBody = "";
    const dispatchModule = await import("../auto-reply/reply/dispatch-from-config.js");
    vi.spyOn(dispatchModule, "dispatchReplyFromConfig").mockImplementation(
      async (...args: unknown[]) => dispatchMock(...args),
    );
    dispatchMock.mockImplementationOnce(async ({ dispatcher, ctx }) => {
      capturedBody = ctx.Body ?? "";
      dispatcher.sendFinalReply({ text: "ok" });
      return { queuedFinal: true, counts: { final: 1 } };
    });

    const { createSignalEventHandler } = await import("./monitor/event-handler.js");
    const handler = createSignalEventHandler({
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: (code: number): never => {
          throw new Error(`exit ${code}`);
        },
      },
      cfg: {
        agents: { defaults: { model: "anthropic/claude-opus-4-5", workspace: "/tmp/clawd" } },
        channels: { signal: {} },
      } as never,
      baseUrl: "http://localhost",
      account: "+15550009999",
      accountId: "default",
      blockStreaming: false,
      historyLimit: 0,
      groupHistories: new Map(),
      textLimit: 4000,
      dmPolicy: "open",
      allowFrom: [],
      groupAllowFrom: [],
      groupPolicy: "open",
      reactionMode: "off",
      reactionAllowlist: [],
      mediaMaxBytes: 1000,
      ignoreAttachments: true,
      fetchAttachment: async () => null,
      deliverReplies: async () => undefined,
      resolveSignalReactionTargets: () => [],
      isSignalReactionMessage: () => false,
      shouldEmitSignalReactionNotification: () => false,
      buildSignalReactionSystemEventText: () => "",
    });

    const payload = {
      envelope: {
        sourceNumber: "+15550002222",
        sourceName: "Alice",
        timestamp: 1700000000000,
        dataMessage: {
          message: "hello",
          groupInfo: { groupId: "group-1", groupName: "Test Group" },
        },
      },
    };

    await handler({ event: "receive", data: JSON.stringify(payload) });

    expect(dispatchMock).toHaveBeenCalled();
    expect(capturedBody).toContain("Alice (+15550002222): hello");
  });
});
