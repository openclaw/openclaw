import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import { getActiveNamedSessionKey, setActiveNamedSession } from "../gateway/session-utils.js";
import {
  buildNamedDmSessionKey,
  isNamedDmSessionKey,
  parseNamedDmSessionKey,
} from "./session-key-utils.js";

describe("Named DM Session Keys (ETH-608)", () => {
  describe("buildNamedDmSessionKey", () => {
    it("builds a valid named DM session key", () => {
      const key = buildNamedDmSessionKey({
        agentId: "main",
        peerId: "123456789",
        name: "valorant",
      });
      expect(key).toBe("agent:main:dm-named:123456789:valorant");
    });

    it("normalizes inputs to lowercase", () => {
      const key = buildNamedDmSessionKey({
        agentId: "MAIN",
        peerId: "USER123",
        name: "MySession",
      });
      expect(key).toBe("agent:main:dm-named:user123:mysession");
    });

    it("throws on empty agentId", () => {
      expect(() =>
        buildNamedDmSessionKey({
          agentId: "",
          peerId: "123",
          name: "work",
        }),
      ).toThrow("agentId, peerId, and name are required");
    });

    it("throws on empty peerId", () => {
      expect(() =>
        buildNamedDmSessionKey({
          agentId: "main",
          peerId: "",
          name: "work",
        }),
      ).toThrow("agentId, peerId, and name are required");
    });

    it("throws on empty name", () => {
      expect(() =>
        buildNamedDmSessionKey({
          agentId: "main",
          peerId: "123",
          name: "",
        }),
      ).toThrow("agentId, peerId, and name are required");
    });

    it("throws when agentId contains a colon", () => {
      expect(() =>
        buildNamedDmSessionKey({
          agentId: "ma:in",
          peerId: "123",
          name: "work",
        }),
      ).toThrow();
    });

    it("throws when peerId contains a colon", () => {
      expect(() =>
        buildNamedDmSessionKey({
          agentId: "main",
          peerId: "123:456",
          name: "work",
        }),
      ).toThrow();
    });

    it("trims whitespace", () => {
      const key = buildNamedDmSessionKey({
        agentId: "  main  ",
        peerId: "  123  ",
        name: "  work  ",
      });
      expect(key).toBe("agent:main:dm-named:123:work");
    });
  });

  describe("isNamedDmSessionKey", () => {
    it("returns true for valid named DM session keys", () => {
      expect(isNamedDmSessionKey("agent:main:dm-named:123456789:valorant")).toBe(true);
      expect(isNamedDmSessionKey("agent:ops:dm-named:999:work")).toBe(true);
    });

    it("returns false for non-agent keys", () => {
      expect(isNamedDmSessionKey("main")).toBe(false);
      expect(isNamedDmSessionKey("discord:direct:123")).toBe(false);
    });

    it("returns false for agent keys that are not named DM keys", () => {
      expect(isNamedDmSessionKey("agent:main:main")).toBe(false);
      expect(isNamedDmSessionKey("agent:main:direct:123")).toBe(false);
      expect(isNamedDmSessionKey("agent:main:group:456")).toBe(false);
    });

    it("returns false for malformed named DM keys", () => {
      expect(isNamedDmSessionKey("agent:main:dm-named")).toBe(false);
      expect(isNamedDmSessionKey("agent:main:dm-named:123")).toBe(false);
      expect(isNamedDmSessionKey("agent:main:dm-named:123:work:extra")).toBe(false);
    });

    it("returns false for null/undefined/empty", () => {
      expect(isNamedDmSessionKey(null)).toBe(false);
      expect(isNamedDmSessionKey(undefined)).toBe(false);
      expect(isNamedDmSessionKey("")).toBe(false);
    });
  });

  describe("parseNamedDmSessionKey", () => {
    it("parses valid named DM session keys", () => {
      const result = parseNamedDmSessionKey("agent:main:dm-named:123456789:valorant");
      expect(result).toEqual({
        agentId: "main",
        peerId: "123456789",
        name: "valorant",
      });
    });

    it("normalizes to lowercase", () => {
      const result = parseNamedDmSessionKey("AGENT:MAIN:DM-NAMED:USER123:WORK");
      expect(result).toEqual({
        agentId: "main",
        peerId: "user123",
        name: "work",
      });
    });

    it("returns null for non-agent keys", () => {
      expect(parseNamedDmSessionKey("main")).toBe(null);
      expect(parseNamedDmSessionKey("discord:direct:123")).toBe(null);
    });

    it("returns null for non-named-DM agent keys", () => {
      expect(parseNamedDmSessionKey("agent:main:main")).toBe(null);
      expect(parseNamedDmSessionKey("agent:main:direct:123")).toBe(null);
    });

    it("returns null for malformed named DM keys", () => {
      expect(parseNamedDmSessionKey("agent:main:dm-named")).toBe(null);
      expect(parseNamedDmSessionKey("agent:main:dm-named:123")).toBe(null);
    });

    it("returns null for null/undefined/empty", () => {
      expect(parseNamedDmSessionKey(null)).toBe(null);
      expect(parseNamedDmSessionKey(undefined)).toBe(null);
      expect(parseNamedDmSessionKey("")).toBe(null);
    });

    it("handles multiple agents", () => {
      const result1 = parseNamedDmSessionKey("agent:ops:dm-named:456:project-x");
      expect(result1).toEqual({
        agentId: "ops",
        peerId: "456",
        name: "project-x",
      });

      const result2 = parseNamedDmSessionKey("agent:dev:dm-named:789:testing");
      expect(result2).toEqual({
        agentId: "dev",
        peerId: "789",
        name: "testing",
      });
    });
  });

  describe("round-trip", () => {
    it("build and parse round-trip correctly", () => {
      const original = {
        agentId: "main",
        peerId: "123456789",
        name: "valorant",
      };

      const key = buildNamedDmSessionKey(original);
      const parsed = parseNamedDmSessionKey(key);

      expect(parsed).toEqual(original);
    });

    it("round-trip with normalization", () => {
      const key = buildNamedDmSessionKey({
        agentId: "MAIN",
        peerId: "USER123",
        name: "MySession",
      });

      const parsed = parseNamedDmSessionKey(key);

      expect(parsed).toEqual({
        agentId: "main",
        peerId: "user123",
        name: "mysession",
      });
    });
  });

  describe("setActiveNamedSession", () => {
    it("sets activeNamedSession on the entry and returns true", () => {
      const entry = {} as SessionEntry;
      const result = setActiveNamedSession({ mainEntry: entry, name: "work" });
      expect(result).toBe(true);
      expect(entry.activeNamedSession).toBe("work");
    });

    it("is idempotent — returns false when called twice with same name", () => {
      const entry = {} as SessionEntry;
      setActiveNamedSession({ mainEntry: entry, name: "work" });
      const result = setActiveNamedSession({ mainEntry: entry, name: "work" });
      expect(result).toBe(false);
    });

    it("clears activeNamedSession when name is null and returns true", () => {
      const entry = { activeNamedSession: "work" } as SessionEntry;
      const result = setActiveNamedSession({ mainEntry: entry, name: null });
      expect(result).toBe(true);
      expect(entry.activeNamedSession).toBeUndefined();
    });

    it("returns false when clearing an already-cleared entry", () => {
      const entry = {} as SessionEntry;
      const result = setActiveNamedSession({ mainEntry: entry, name: null });
      expect(result).toBe(false);
    });

    it("throws when name contains a colon", () => {
      const entry = {} as SessionEntry;
      expect(() => setActiveNamedSession({ mainEntry: entry, name: "foo:bar" })).toThrow();
      expect(entry.activeNamedSession).toBeUndefined();
    });

    it("normalizes name to lowercase", () => {
      const entry = {} as SessionEntry;
      setActiveNamedSession({ mainEntry: entry, name: "Work" });
      expect(entry.activeNamedSession).toBe("work");
    });
  });

  describe("getActiveNamedSessionKey", () => {
    it("returns null when mainEntry is undefined", () => {
      const result = getActiveNamedSessionKey({
        mainEntry: undefined,
        agentId: "main",
        peerId: "123",
      });
      expect(result).toBeNull();
    });

    it("returns null when activeNamedSession is not set", () => {
      const entry = {} as SessionEntry;
      const result = getActiveNamedSessionKey({ mainEntry: entry, agentId: "main", peerId: "123" });
      expect(result).toBeNull();
    });

    it("returns null when activeNamedSession is whitespace-only", () => {
      const entry = { activeNamedSession: "   " } as SessionEntry;
      const result = getActiveNamedSessionKey({ mainEntry: entry, agentId: "main", peerId: "123" });
      expect(result).toBeNull();
    });

    it("returns the correct named session key on round-trip", () => {
      const entry = {} as SessionEntry;
      setActiveNamedSession({ mainEntry: entry, name: "work" });
      const result = getActiveNamedSessionKey({ mainEntry: entry, agentId: "main", peerId: "123" });
      expect(result).toBe("agent:main:dm-named:123:work");
    });
  });
});
