// Settings persistence tests cover local user identity read/write.
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadLocalUserIdentity, saveLocalUserIdentity } from "./settings.js";

describe("local user identity persistence", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("saveLocalUserIdentity writes and reads back the avatar", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    });

    expect(loadLocalUserIdentity().avatar).toBeNull();

    saveLocalUserIdentity({ avatar: "data:image/png;base64,abc" });
    expect(loadLocalUserIdentity().avatar).toBe("data:image/png;base64,abc");

    saveLocalUserIdentity({ avatar: null });
    expect(loadLocalUserIdentity().avatar).toBeNull();
  });

  it("saveLocalUserIdentity merges with existing identity fields", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    });

    saveLocalUserIdentity({ name: "tester" });
    saveLocalUserIdentity({ avatar: "😀" });
    const identity = loadLocalUserIdentity();
    expect(identity.name).toBe("tester");
    expect(identity.avatar).toBe("😀");
  });
});
