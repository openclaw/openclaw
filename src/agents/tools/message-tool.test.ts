import { describe, expect, it, vi } from "vitest";

import type { MessageActionRunResult } from "../../infra/outbound/message-action-runner.js";
import { createMessageTool } from "./message-tool.js";

const mocks = vi.hoisted(() => ({
  runMessageAction: vi.fn(),
  appendAssistantMessageToSessionTranscript: vi.fn(async () => ({ ok: true, sessionFile: "x" })),
}));

vi.mock("../../infra/outbound/message-action-runner.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../infra/outbound/message-action-runner.js")
  >("../../infra/outbound/message-action-runner.js");
  return {
    ...actual,
    runMessageAction: mocks.runMessageAction,
  };
});

vi.mock("../../config/sessions.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions.js")>(
    "../../config/sessions.js",
  );
  return {
    ...actual,
    appendAssistantMessageToSessionTranscript: mocks.appendAssistantMessageToSessionTranscript,
  };
});

describe("message tool mirroring", () => {
  it("mirrors media filename for plugin-handled sends", async () => {
    mocks.appendAssistantMessageToSessionTranscript.mockClear();
    mocks.runMessageAction.mockResolvedValue({
      kind: "send",
      action: "send",
      channel: "telegram",
      handledBy: "plugin",
      payload: {},
      dryRun: false,
    } satisfies MessageActionRunResult);

    const tool = createMessageTool({
      agentSessionKey: "agent:main:main",
      config: {} as never,
    });

    await tool.execute("1", {
      action: "send",
      target: "telegram:123",
      message: "",
      media: "https://example.com/files/report.pdf?sig=1",
    });

    expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith(
      expect.objectContaining({ text: "report.pdf" }),
    );
  });

  it("does not mirror on dry-run", async () => {
    mocks.appendAssistantMessageToSessionTranscript.mockClear();
    mocks.runMessageAction.mockResolvedValue({
      kind: "send",
      action: "send",
      channel: "telegram",
      handledBy: "plugin",
      payload: {},
      dryRun: true,
    } satisfies MessageActionRunResult);

    const tool = createMessageTool({
      agentSessionKey: "agent:main:main",
      config: {} as never,
    });

    await tool.execute("1", {
      action: "send",
      target: "telegram:123",
      message: "hi",
    });

    expect(mocks.appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
  });
});
