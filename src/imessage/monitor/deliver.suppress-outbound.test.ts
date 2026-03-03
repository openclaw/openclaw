import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.js";
import type { RuntimeEnv } from "../../runtime.js";
import { deliverReplies } from "./deliver.js";

const sendMessageIMessageMock = vi.hoisted(() => vi.fn().mockResolvedValue({ messageId: "m1" }));
const loadConfigMock = vi.hoisted(() => vi.fn());

vi.mock("../send.js", () => ({
  sendMessageIMessage: (...args: unknown[]) => sendMessageIMessageMock(...args),
}));
vi.mock("../../config/config.js", () => ({
  loadConfig: () => loadConfigMock(),
}));

describe("iMessage deliverReplies suppressOutbound", () => {
  it("blocks delivery when suppressOutbound is true", async () => {
    loadConfigMock.mockReturnValue({
      channels: { imessage: { suppressOutbound: true } },
    } as OpenClawConfig);

    await deliverReplies({
      replies: [{ text: "hello" }],
      target: "+15550001111",
      // oxlint-disable-next-line typescript/no-explicit-any
      client: {} as any,
      accountId: "default",
      runtime: { log: vi.fn() } as unknown as RuntimeEnv,
      maxBytes: 1024,
      textLimit: 4000,
    });

    expect(sendMessageIMessageMock).not.toHaveBeenCalled();
  });

  it("allows delivery when not suppressed", async () => {
    loadConfigMock.mockReturnValue({
      channels: { imessage: {} },
    } as OpenClawConfig);

    await deliverReplies({
      replies: [{ text: "hello" }],
      target: "+15550001111",
      // oxlint-disable-next-line typescript/no-explicit-any
      client: {} as any,
      accountId: "default",
      runtime: { log: vi.fn() } as unknown as RuntimeEnv,
      maxBytes: 1024,
      textLimit: 4000,
    });

    expect(sendMessageIMessageMock).toHaveBeenCalled();
  });
});
