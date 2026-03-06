import { describe, expect, it, vi } from "vitest";
import {
  logoutWhatsApp,
  startWhatsAppLogin,
  waitWhatsAppLogin,
  type ChannelsState,
} from "./channels.ts";

function createState() {
  return {
    channelsError: null,
    channelsLastSuccess: null,
    channelsLoading: false,
    channelsSnapshot: null,
    client: null,
    connected: true,
    whatsappBusy: false,
    whatsappLoginConnected: null,
    whatsappLoginMessage: null,
    whatsappLoginQrDataUrl: null,
  } satisfies ChannelsState;
}

describe("channels controller", () => {
  it("normalizes unavailable provider errors for whatsapp login start", async () => {
    const state = createState();
    state.client = {
      request: vi.fn().mockRejectedValue(new Error("web login provider is not available")),
    } as unknown as ChannelsState["client"];

    await startWhatsAppLogin(state, false);

    expect(state.whatsappLoginMessage).toBe("WhatsApp web login is not available in this gateway.");
    expect(state.whatsappLoginQrDataUrl).toBeNull();
    expect(state.whatsappLoginConnected).toBeNull();
  });

  it("normalizes unavailable provider errors for whatsapp login wait", async () => {
    const state = createState();
    state.client = {
      request: vi.fn().mockRejectedValue(new Error("web login provider is not available")),
    } as unknown as ChannelsState["client"];

    await waitWhatsAppLogin(state);

    expect(state.whatsappLoginMessage).toBe("WhatsApp web login is not available in this gateway.");
    expect(state.whatsappLoginConnected).toBeNull();
  });

  it("normalizes unavailable provider errors for whatsapp logout", async () => {
    const state = createState();
    state.client = {
      request: vi.fn().mockRejectedValue(new Error("web login provider is not available")),
    } as unknown as ChannelsState["client"];

    await logoutWhatsApp(state);

    expect(state.whatsappLoginMessage).toBe("WhatsApp web login is not available in this gateway.");
  });
});