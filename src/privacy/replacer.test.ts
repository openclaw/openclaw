import { describe, expect, it } from "vitest";
import { PrivacyReplacer } from "./replacer.js";
import type { DetectionMatch, RiskLevel } from "./types.js";

function makeMatch(
  type: string,
  content: string,
  start: number,
  riskLevel: RiskLevel = "high",
): DetectionMatch {
  return {
    type,
    content,
    start,
    end: start + content.length,
    riskLevel,
    description: `test ${type}`,
  };
}

describe("PrivacyReplacer", () => {
  describe("replaceAll", () => {
    it("replaces email addresses", () => {
      const replacer = new PrivacyReplacer("test-session");
      const text = "Contact user@gmail.com for info";
      const match = makeMatch("email", "user@gmail.com", 8);
      const { replaced } = replacer.replaceAll(text, [match]);
      expect(replaced).not.toContain("user@gmail.com");
      expect(replaced).toContain("@example.net");
    });

    it("replaces phone numbers", () => {
      const replacer = new PrivacyReplacer("test-session");
      const text = "Call me at 13812345678";
      const match = makeMatch("phone_cn", "13812345678", 11);
      const { replaced } = replacer.replaceAll(text, [match]);
      expect(replaced).not.toContain("13812345678");
      expect(replaced).toContain("139");
    });

    it("replaces password assignments keeping the key", () => {
      const replacer = new PrivacyReplacer("test-session");
      const text = "password=MyS3cret";
      const match = makeMatch("password_assignment", "password=MyS3cret", 0, "critical");
      const { replaced } = replacer.replaceAll(text, [match]);
      expect(replaced).not.toContain("MyS3cret");
      expect(replaced).toContain("password=");
      expect(replaced).toContain("PF_PWD_");
    });

    it("preserves text around replacements", () => {
      const replacer = new PrivacyReplacer("test-session");
      const text = "prefix user@test.com suffix";
      const match = makeMatch("email", "user@test.com", 7);
      const { replaced } = replacer.replaceAll(text, [match]);
      expect(replaced).toMatch(/^prefix .+ suffix$/);
    });

    it("handles multiple matches", () => {
      const replacer = new PrivacyReplacer("test-session");
      const text = "email: a@b.com phone: 13800001111";
      const matches = [makeMatch("email", "a@b.com", 7), makeMatch("phone_cn", "13800001111", 22)];
      const { replaced } = replacer.replaceAll(text, matches);
      expect(replaced).not.toContain("a@b.com");
      expect(replaced).not.toContain("13800001111");
    });

    it("returns new mappings for first-time replacements", () => {
      const replacer = new PrivacyReplacer("test-session");
      const match = makeMatch("email", "user@test.com", 0);
      const { newMappings } = replacer.replaceAll("user@test.com", [match]);
      expect(newMappings).toHaveLength(1);
      expect(newMappings[0].type).toBe("email");
      expect(newMappings[0].sessionId).toBe("test-session");
    });
  });

  describe("idempotency", () => {
    it("returns same replacement for same original", () => {
      const replacer = new PrivacyReplacer("test-session");
      const match1 = makeMatch("email", "same@test.com", 0);
      const match2 = makeMatch("email", "same@test.com", 5);

      const { replaced: r1 } = replacer.replaceAll("same@test.com", [match1]);
      const { replaced: r2, newMappings } = replacer.replaceAll("xxx same@test.com", [match2]);

      // Both should use the same replacement value.
      const replacement = r1;
      expect(r2).toContain(replacement);
      expect(newMappings).toHaveLength(0);
    });
  });

  describe("restore", () => {
    it("restores replaced text to original", () => {
      const replacer = new PrivacyReplacer("test-session");
      const original = "Send to user@example.com please";
      const match = makeMatch("email", "user@example.com", 8);
      const { replaced } = replacer.replaceAll(original, [match]);

      // LLM response that echoes back the replacement.
      const llmResponse = `I see the email ${replaced.slice(8, replaced.indexOf(" please"))}`;
      const restored = replacer.restore(llmResponse);
      expect(restored).toContain("user@example.com");
    });

    it("handles text with no replacements", () => {
      const replacer = new PrivacyReplacer("test-session");
      const text = "no replacements here";
      expect(replacer.restore(text)).toBe(text);
    });
  });

  describe("loadMappings", () => {
    it("loads previously saved mappings", () => {
      const replacer = new PrivacyReplacer("test-session");
      const match = makeMatch("email", "old@test.com", 0);
      const { newMappings } = replacer.replaceAll("old@test.com", [match]);

      // Create new replacer and load mappings.
      const replacer2 = new PrivacyReplacer("test-session");
      replacer2.loadMappings(newMappings);

      // Should be able to restore using loaded mappings.
      const restored = replacer2.restore(newMappings[0].replacement);
      expect(restored).toBe("old@test.com");
    });
  });

  describe("clear", () => {
    it("clears all mappings", () => {
      const replacer = new PrivacyReplacer("test-session");
      const match = makeMatch("email", "test@test.com", 0);
      replacer.replaceAll("test@test.com", [match]);

      replacer.clear();
      expect(replacer.getMappings()).toHaveLength(0);
    });
  });
});
