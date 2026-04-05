import { beforeEach, describe, expect, it, vi } from "vitest";

const { callGatewayMock } = vi.hoisted(() => ({
  callGatewayMock: vi.fn(),
}));

vi.mock("../../../gateway/call.js", () => ({
  callGateway: (params: unknown) => callGatewayMock(params),
}));

let handleSubagentsLogAction: typeof import("./action-log.js").handleSubagentsLogAction;

describe("handleSubagentsLogAction", () => {
  beforeEach(async () => {
    vi.resetModules();
    callGatewayMock.mockReset();
    ({ handleSubagentsLogAction } = await import("./action-log.js"));
  });

  it("filters tool messages by default and formats remaining chat lines", async () => {
    callGatewayMock.mockResolvedValue({
      messages: [
        { role: "user", content: [{ type: "text", text: "hello" }] },
        { role: "tool", content: [{ type: "text", text: "hidden" }] },
        { role: "assistant", content: [{ type: "text", text: "[Tool Call: run] done" }] },
      ],
    });

    const result = await handleSubagentsLogAction({
      params: { cfg: {} },
      runs: [
        {
          runId: "run-1",
          childSessionKey: "agent:main:subagent:abc",
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "worker",
          cleanup: "keep",
          createdAt: 1_000,
          startedAt: 1_000,
        },
      ],
      restTokens: ["1"],
    } as never);

    expect(result.reply?.text).toContain("Subagent log: worker");
    expect(result.reply?.text).toContain("User: hello");
    expect(result.reply?.text).toContain("Assistant: done");
    expect(result.reply?.text).not.toContain("hidden");
  });

  it("shows a usage hint when target is missing", async () => {
    const result = await handleSubagentsLogAction({
      params: { cfg: {} },
      runs: [],
      restTokens: [],
    } as never);

    expect(result.reply?.text).toContain("Usage: /subagents log <id|#> [limit]");
  });
});
