import { describe, expect, test } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import {
  capArrayByJsonBytes,
  classifySessionKey,
  parseGroupKey,
} from "./session-utils.js";

describe("gateway session utils", () => {
  test("capArrayByJsonBytes trims from the front", () => {
    const res = capArrayByJsonBytes(["a", "b", "c"], 10);
    expect(res.items).toEqual(["b", "c"]);
  });

  test("parseGroupKey handles group prefixes", () => {
    expect(parseGroupKey("group:abc")).toEqual({ id: "abc" });
    expect(parseGroupKey("discord:group:dev")).toEqual({
      provider: "discord",
      kind: "group",
      id: "dev",
    });
    expect(parseGroupKey("foo:bar")).toBeNull();
  });

  test("classifySessionKey respects chat type + prefixes", () => {
    expect(classifySessionKey("global")).toBe("global");
    expect(classifySessionKey("unknown")).toBe("unknown");
    expect(classifySessionKey("group:abc")).toBe("group");
    expect(classifySessionKey("discord:group:dev")).toBe("group");
    expect(classifySessionKey("main")).toBe("direct");
    const entry = { chatType: "group" } as SessionEntry;
    expect(classifySessionKey("main", entry)).toBe("group");
  });
});
