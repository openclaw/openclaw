import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CliDeps } from "../cli/deps.js";
import { pollCommand } from "./poll.js";

let testConfig: Record<string, unknown> = {};
vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => testConfig,
  };
});

const callGatewayMock = vi.fn();
vi.mock("../gateway/call.js", () => ({
  callGateway: (...args: unknown[]) => callGatewayMock(...args),
  randomIdempotencyKey: () => "idem-1",
}));

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

const deps: CliDeps = {
  sendMessageWhatsApp: vi.fn(),
  sendMessageTelegram: vi.fn(),
  sendMessageDiscord: vi.fn(),
  sendMessageSlack: vi.fn(),
  sendMessageSignal: vi.fn(),
  sendMessageIMessage: vi.fn(),
};

describe("pollCommand", () => {
  beforeEach(() => {
    callGatewayMock.mockReset();
    runtime.log.mockReset();
    runtime.error.mockReset();
    runtime.exit.mockReset();
    testConfig = {};
  });

  it("routes through gateway", async () => {
    callGatewayMock.mockResolvedValueOnce({ messageId: "p1" });
    await pollCommand(
      {
        to: "+1",
        question: "hi?",
        option: ["y", "n"],
      },
      deps,
      runtime,
    );
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({ method: "poll" }),
    );
  });

  it("does not override remote gateway URL", async () => {
    callGatewayMock.mockResolvedValueOnce({ messageId: "p1" });
    testConfig = {
      gateway: { mode: "remote", remote: { url: "wss://remote.example" } },
    };
    await pollCommand(
      {
        to: "+1",
        question: "hi?",
        option: ["y", "n"],
      },
      deps,
      runtime,
    );
    const args = callGatewayMock.mock.calls.at(-1)?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(args?.url).toBeUndefined();
  });

  it("emits json output with gateway metadata", async () => {
    callGatewayMock.mockResolvedValueOnce({ messageId: "p1", channelId: "C1" });
    await pollCommand(
      {
        to: "channel:C1",
        question: "hi?",
        option: ["y", "n"],
        provider: "discord",
        json: true,
      },
      deps,
      runtime,
    );
    const lastLog = runtime.log.mock.calls.at(-1)?.[0] as string | undefined;
    expect(lastLog).toBeDefined();
    const payload = JSON.parse(lastLog ?? "{}") as Record<string, unknown>;
    expect(payload).toMatchObject({
      provider: "discord",
      via: "gateway",
      to: "channel:C1",
      messageId: "p1",
      channelId: "C1",
      mediaUrl: null,
      question: "hi?",
      options: ["y", "n"],
      maxSelections: 1,
      durationHours: null,
    });
  });
});
