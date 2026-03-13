import { describe, expect, it } from "vitest";
import { applySessionStoreMigrations } from "./store-migrations.js";
import type { SessionEntry } from "./types.js";

function makeEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "sid-1",
    updatedAt: Date.now(),
    ...overrides,
  } as SessionEntry;
}

describe("applySessionStoreMigrations", () => {
  describe("legacy :dm: → :direct: key migration", () => {
    it("renames :dm: keys to :direct:", () => {
      const store: Record<string, SessionEntry> = {
        "agent:main:whatsapp:dm:+61419009073": makeEntry(),
      };
      applySessionStoreMigrations(store);
      expect(store["agent:main:whatsapp:direct:+61419009073"]).toBeDefined();
      expect(store["agent:main:whatsapp:dm:+61419009073"]).toBeUndefined();
    });

    it("handles multiple channels and lowercases keys", () => {
      const store: Record<string, SessionEntry> = {
        "agent:main:telegram:dm:123456": makeEntry(),
        "agent:main:slack:dm:C0123ABC": makeEntry(),
      };
      applySessionStoreMigrations(store);
      expect(store["agent:main:telegram:direct:123456"]).toBeDefined();
      expect(store["agent:main:slack:direct:c0123abc"]).toBeDefined();
      expect(store["agent:main:telegram:dm:123456"]).toBeUndefined();
      expect(store["agent:main:slack:dm:C0123ABC"]).toBeUndefined();
    });

    it("keeps newer :direct: entry on collision", () => {
      const oldEntry = makeEntry({ updatedAt: 1000 });
      const newEntry = makeEntry({ updatedAt: 2000 });
      const store: Record<string, SessionEntry> = {
        "agent:main:whatsapp:dm:+123": oldEntry,
        "agent:main:whatsapp:direct:+123": newEntry,
      };
      applySessionStoreMigrations(store);
      expect(store["agent:main:whatsapp:direct:+123"]).toBe(newEntry);
      expect(store["agent:main:whatsapp:dm:+123"]).toBeUndefined();
    });

    it("keeps newer :dm: entry on collision", () => {
      const oldEntry = makeEntry({ updatedAt: 1000 });
      const newEntry = makeEntry({ updatedAt: 2000 });
      const store: Record<string, SessionEntry> = {
        "agent:main:whatsapp:dm:+123": newEntry,
        "agent:main:whatsapp:direct:+123": oldEntry,
      };
      applySessionStoreMigrations(store);
      expect(store["agent:main:whatsapp:direct:+123"]).toBe(newEntry);
      expect(store["agent:main:whatsapp:dm:+123"]).toBeUndefined();
    });

    it("preserves thread-suffixed keys and lowercases", () => {
      const store: Record<string, SessionEntry> = {
        "agent:main:slack:dm:C012:thread:1234567890.123": makeEntry(),
      };
      applySessionStoreMigrations(store);
      expect(store["agent:main:slack:direct:c012:thread:1234567890.123"]).toBeDefined();
      expect(store["agent:main:slack:dm:C012:thread:1234567890.123"]).toBeUndefined();
    });

    it("leaves keys without :dm: untouched", () => {
      const entry = makeEntry();
      const store: Record<string, SessionEntry> = {
        "agent:main:main": entry,
        "agent:main:whatsapp:group:123@g.us": makeEntry(),
        "agent:main:whatsapp:direct:+123": makeEntry(),
      };
      applySessionStoreMigrations(store);
      expect(store["agent:main:main"]).toBe(entry);
      expect(store["agent:main:whatsapp:group:123@g.us"]).toBeDefined();
      expect(store["agent:main:whatsapp:direct:+123"]).toBeDefined();
    });
  });
});
