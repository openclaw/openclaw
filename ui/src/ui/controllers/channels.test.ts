import { beforeEach, describe, expect, it } from "vitest";
import { startWhatsAppLogin, waitWhatsAppLogin } from "./channels.ts";
import type { ChannelsState } from "./channels.types.ts";

function createState(
  requestImpl: (method: string, params?: unknown) => Promise<unknown>,
): ChannelsState {
  return {
    client: {
      request: requestImpl,
    } as never,
    connected: true,
    channelsLoading: false,
    channelsError: null,
    channelsSnapshot: null,
    channelsLastSuccess: null,
    whatsappBusy: false,
    whatsappLoginMessage: null,
    whatsappLoginQrDataUrl: null,
    whatsappLoginConnected: null,
  } as ChannelsState;
}

describe("channels controller", () => {
  beforeEach(() => {});

  it("refreshes QR while waiting for WhatsApp login to finish", async () => {
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
            waitCount > 1 ? "✅ Linked! WhatsApp is ready." : "Still waiting for the QR scan.",
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

  it("recovers from a transient QR refresh failure while still completing login", async () => {
    const requests: Array<{ method: string; params?: unknown }> = [];
    let refreshFailed = false;
    const state = createState(async (method, params) => {
      requests.push({ method, params });
      if (method === "web.login.start") {
        const startCount = requests.filter((entry) => entry.method === "web.login.start").length;
        if (startCount === 1) {
          return {
            message: "first qr",
            qrDataUrl: "data:first",
          };
        }
        if (!refreshFailed) {
          refreshFailed = true;
          throw new Error("transient refresh failure");
        }
        return {
          message: "refreshed qr",
          qrDataUrl: "data:second",
        };
      }
      if (method === "web.login.wait") {
        const waitCount = requests.filter((entry) => entry.method === "web.login.wait").length;
        return {
          message:
            waitCount >= 3 ? "✅ Linked! WhatsApp is ready." : "Still waiting for the QR scan.",
          connected: waitCount >= 3,
        };
      }
      throw new Error(`unexpected method ${method}`);
    });

    await startWhatsAppLogin(state, false);
    await waitWhatsAppLogin(state, { timeoutMs: 10_000, pollMs: 1_000 });

    expect(state.whatsappLoginConnected).toBe(true);
    expect(state.whatsappBusy).toBe(false);
    expect(state.whatsappLoginMessage).toBe("✅ Linked! WhatsApp is ready.");
  });
});
