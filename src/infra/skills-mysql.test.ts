import { describe, expect, it } from "vitest";
import { resolveSkillUserId, sanitizeSkillSegment } from "./skills-mysql.js";

describe("resolveSkillUserId", () => {
  it("extracts userId from a guardian sessionKey", () => {
    expect(resolveSkillUserId("agent:rabbitmq-1749:rabbitmq:1749:session_abc")).toBe("1749");
  });

  it("falls back to the trailing number of the agentId", () => {
    expect(resolveSkillUserId(undefined, "rabbitmq-42")).toBe("42");
  });

  it("prefers the sessionKey segment over the agentId", () => {
    expect(resolveSkillUserId("agent:rabbitmq-1749:rabbitmq:1749:s1", "rabbitmq-999")).toBe("1749");
  });

  it("returns undefined when neither yields a numeric userId", () => {
    expect(resolveSkillUserId("agent:main:main", "main")).toBeUndefined();
    expect(resolveSkillUserId(undefined, undefined)).toBeUndefined();
  });
});

describe("sanitizeSkillSegment (path-traversal guard)", () => {
  it("keeps safe filenames", () => {
    expect(sanitizeSkillSegment("find-sessions.sh")).toBe("find-sessions.sh");
    expect(sanitizeSkillSegment("SKILL.md")).toBe("SKILL.md");
    expect(sanitizeSkillSegment("tmux")).toBe("tmux");
  });

  it("strips directory components and traversal", () => {
    expect(sanitizeSkillSegment("../../etc/passwd")).toBe("passwd");
    expect(sanitizeSkillSegment("/abs/path/evil.sh")).toBe("evil.sh");
    expect(sanitizeSkillSegment("nested\\win\\evil.sh")).toBe("evil.sh");
  });

  it("rejects empty/dot-only names", () => {
    expect(sanitizeSkillSegment("")).toBe("");
    expect(sanitizeSkillSegment(".")).toBe("");
    expect(sanitizeSkillSegment("..")).toBe("");
    expect(sanitizeSkillSegment(null)).toBe("");
    expect(sanitizeSkillSegment(undefined)).toBe("");
  });

  it("replaces unsafe characters with underscores", () => {
    expect(sanitizeSkillSegment("a b;rm -rf.sh")).toBe("a_b_rm_-rf.sh");
  });
});
