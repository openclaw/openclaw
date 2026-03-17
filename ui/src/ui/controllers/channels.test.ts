import { beforeEach, describe, expect, it, vi } from "vitest";
import { startWhatsAppLogin, waitWhatsAppLogin } from "./channels.ts";
import type { ChannelsState } from "./channels.types.ts";

function createState(
  requestImpl: (method: string, params?: unknown) => Promise<unknown>,
): ChannelsState {
  return {
    client: {
      request: vi.fn(requestImpl),
    } as unknown as ChannelsState["client"],
    connected: true,
    channelsLoading: false,
    channelsSnapshot: null,
    channelsError: null,
    channelsLastSuccess: null,
    whatsappLoginMessage: null,
    whatsappLoginQrDataUrl: null,
    whatsappLoginConnected: null,
    whatsappBusy: false,
  };
}

describe("channels controller whatsapp login", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refreshes the QR while waiting for login", async () => {
    const requests: Array<{ method: string; params?: unknown }> = [];
    const state = createState(async (method, params) => {
      requests.push({ method, params });
      if (method === "web.login.start") {
        const startCount = requests.filter((entry) => entry.method === "web.login.start").length;
        return {
          message: startCount === 1 ? "first qr" : "refreshed qr",
          qrDataUrl: startCount === 1 ? "data:first" : "data:second",
        };
      }
      if (method === "web.login.wait") {
        const waitCount = requests.filter((entry) => entry.method === "web.login.wait").length;
        return {
          message:
            waitCount === 1 ? "Still waiting for the QR scan." : "✅ Linked! WhatsApp is ready.",
          connected: waitCount > 1,
        };
      }
      throw new Error(`unexpected method ${method}`);
    });

    await startWhatsAppLogin(state, false);
    await waitWhatsAppLogin(state, { timeoutMs: 10_000, pollMs: 1_000 });

    expect(state.whatsappLoginQrDataUrl).toBeNull();
    expect(state.whatsappLoginConnected).toBe(true);
    expect(requests.filter((entry) => entry.method === "web.login.start")).toHaveLength(2);
  });
});
