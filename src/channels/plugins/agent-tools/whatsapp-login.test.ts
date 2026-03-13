import { beforeEach, describe, expect, it, vi } from "vitest";

const gatewayMocks = vi.hoisted(() => ({
  callGatewayTool: vi.fn(),
}));

vi.mock("../../../agents/tools/gateway.js", () => ({
  callGatewayTool: (...args: unknown[]) => gatewayMocks.callGatewayTool(...args),
}));

import { createWhatsAppLoginTool } from "./whatsapp-login.js";

describe("createWhatsAppLoginTool", () => {
  beforeEach(() => {
    gatewayMocks.callGatewayTool.mockReset();
  });

  it("routes start through web.login.start", async () => {
    gatewayMocks.callGatewayTool.mockResolvedValueOnce({
      qrDataUrl: "data:image/png;base64,base64",
      message: "Scan this QR in WhatsApp -> Linked Devices.",
    });

    const tool = createWhatsAppLoginTool();
    const result = await tool.execute("tool-call-1", {
      action: "start",
      timeoutMs: 5_000,
      force: true,
    });

    expect(gatewayMocks.callGatewayTool).toHaveBeenCalledWith(
      "web.login.start",
      { timeoutMs: 5_000 },
      {
        timeoutMs: 5_000,
        force: true,
      },
    );
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: expect.stringContaining("![whatsapp-qr](data:image/png;base64,base64)"),
        },
      ],
      details: { qr: true },
    });
  });

  it("routes wait through web.login.wait", async () => {
    gatewayMocks.callGatewayTool.mockResolvedValueOnce({
      connected: true,
      message: "Linked! WhatsApp is ready.",
    });

    const tool = createWhatsAppLoginTool();
    const result = await tool.execute("tool-call-2", {
      action: "wait",
      timeoutMs: 5_000,
    });

    expect(gatewayMocks.callGatewayTool).toHaveBeenCalledWith(
      "web.login.wait",
      { timeoutMs: 5_000 },
      {
        timeoutMs: 5_000,
      },
    );
    expect(result).toEqual({
      content: [{ type: "text", text: "Linked! WhatsApp is ready." }],
      details: { connected: true },
    });
  });
});
