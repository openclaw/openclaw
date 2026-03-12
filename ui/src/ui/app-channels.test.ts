import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleNostrProfileSave } from "./app-channels.ts";
import type { OpenClawApp } from "./app.ts";
import { createNostrProfileFormState } from "./views/channels.nostr-profile-form.ts";

const loadChannels = vi.fn();

vi.mock("./controllers/channels.ts", () => ({
  loadChannels: (...args: unknown[]) => loadChannels(...args),
  logoutWhatsApp: vi.fn(),
  startWhatsAppLogin: vi.fn(),
  waitWhatsAppLogin: vi.fn(),
}));

vi.mock("./controllers/config.ts", () => ({
  loadConfig: vi.fn(),
  saveConfig: vi.fn(),
}));

function createHost(): OpenClawApp {
  return {
    channelsSnapshot: null,
    hello: null,
    nostrProfileAccountId: "default",
    nostrProfileFormState: createNostrProfileFormState({
      name: "alice",
      displayName: "Alice",
      about: "",
      picture: "",
      banner: "",
      website: "",
      nip05: "",
      lud16: "",
    }),
    password: "",
    settings: { token: "" },
  } as unknown as OpenClawApp;
}

describe("handleNostrProfileSave", () => {
  beforeEach(() => {
    loadChannels.mockReset();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not start a save while import is in progress", async () => {
    const host = createHost();
    if (!host.nostrProfileFormState) {
      throw new Error("expected form state");
    }
    host.nostrProfileFormState.importing = true;

    await handleNostrProfileSave(host);

    expect(fetch).not.toHaveBeenCalled();
    expect(loadChannels).not.toHaveBeenCalled();
  });

  it("aligns the saved baseline with the current form state after async success", async () => {
    const host = createHost();
    let resolveResponse!: (value: unknown) => void;
    const responsePromise = new Promise<unknown>((resolve) => {
      resolveResponse = resolve;
    });
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(responsePromise));

    const savePromise = handleNostrProfileSave(host);
    if (!host.nostrProfileFormState) {
      throw new Error("expected form state");
    }
    host.nostrProfileFormState = {
      ...host.nostrProfileFormState,
      values: {
        ...host.nostrProfileFormState.values,
        displayName: "Alice Updated",
      },
    };

    resolveResponse({
      ok: true,
      json: async () => ({ ok: true, persisted: true }),
    });
    await savePromise;

    expect(host.nostrProfileFormState?.values.displayName).toBe("Alice Updated");
    expect(host.nostrProfileFormState?.original.displayName).toBe("Alice Updated");
    expect(loadChannels).toHaveBeenCalledWith(host, true);
  });
});
