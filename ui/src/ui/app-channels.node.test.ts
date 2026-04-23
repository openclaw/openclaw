import { describe, expect, it, vi } from "vitest";
import { handleNostrProfileImport, handleNostrProfileSave } from "./app-channels.ts";
import { createNostrProfileFormState } from "./views/channels.nostr-profile-form.ts";

function createHost(overrides: Record<string, unknown> = {}) {
  return {
    client: null,
    connected: true,
    channelsLoading: false,
    channelsSnapshot: null,
    channelsError: null,
    channelsLastSuccess: null,
    whatsappLoginMessage: null,
    whatsappLoginQrDataUrl: null,
    whatsappLoginConnected: null,
    whatsappBusy: false,
    configLoading: false,
    configRaw: "",
    configRawOriginal: "",
    configValid: true,
    configIssues: [],
    configSaving: false,
    configApplying: false,
    configFormDirty: false,
    hello: null,
    password: null,
    bootstrapGatewayToken: null,
    settings: { token: null, gatewayUrl: "ws://127.0.0.1:18789" },
    nostrProfileFormState: createNostrProfileFormState(undefined),
    nostrProfileAccountId: null,
    ...overrides,
  };
}

describe("nostr channel auth headers", () => {
  it("skips header-unsafe gateway credentials and falls back to the next safe credential", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, persisted: true }),
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const host = createHost({
      settings: {
        token: "line-one\nline-two",
        gatewayUrl: "ws://127.0.0.1:18789",
      },
      password: "safe-password",
    });

    await handleNostrProfileSave(host as never);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/channels/nostr/default/profile",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer safe-password",
        }),
      }),
    );

    vi.unstubAllGlobals();
  });

  it("omits Authorization when every available credential is header-unsafe", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, imported: {}, merged: {}, saved: true }),
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const host = createHost({
      hello: { auth: { deviceToken: "unsafe\r\ndevice-token" } },
      settings: {
        token: "unsafe\nstored-token",
        gatewayUrl: "ws://127.0.0.1:18789",
      },
      password: "unsafe\rpassword",
    });

    await handleNostrProfileImport(host as never);

    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBeUndefined();

    vi.unstubAllGlobals();
  });
});
