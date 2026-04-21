import { describe, expect, it } from "vitest";
import {
  evaluateUrlRouting,
  resolveUrlRoutingRules,
  type UrlRoutingConfig,
} from "./url-routing.js";

describe("evaluateUrlRouting", () => {
  describe("no rules", () => {
    it("returns matched=false when rules array is empty", () => {
      const result = evaluateUrlRouting("https://x.com/user/status/123", []);
      expect(result.matched).toBe(false);
    });
  });

  describe("action: redirect", () => {
    const rules: UrlRoutingConfig = [
      {
        match: "x\\.com|twitter\\.com",
        action: "redirect",
        redirectTo: "skill:xread",
        reason: "X.com blocks unauthenticated fetch. Use the xread skill instead.",
      },
    ];

    it("matches x.com URL and returns block with redirect hint", () => {
      const result = evaluateUrlRouting("https://x.com/user/status/123456", rules);
      expect(result.matched).toBe(true);
      if (!result.matched) {
        return;
      }
      expect(result.rule.action).toBe("redirect");
      expect(result.blockReason).toContain("skill:xread");
      expect(result.blockReason).toContain("X.com blocks unauthenticated");
      expect(result.warnMessage).toBeUndefined();
    });

    it("matches twitter.com URL", () => {
      const result = evaluateUrlRouting("https://twitter.com/user/status/123456", rules);
      expect(result.matched).toBe(true);
      if (!result.matched) {
        return;
      }
      expect(result.blockReason).toContain("skill:xread");
    });

    it("matches case-insensitively", () => {
      const result = evaluateUrlRouting("https://X.COM/user/status/123", rules);
      expect(result.matched).toBe(true);
    });

    it("does not match unrelated URLs", () => {
      const result = evaluateUrlRouting("https://example.com/page", rules);
      expect(result.matched).toBe(false);
    });

    it("includes reason in blockReason when provided", () => {
      const result = evaluateUrlRouting("https://x.com/status/1", rules);
      expect(result.matched).toBe(true);
      if (!result.matched) {
        return;
      }
      expect(result.blockReason).toContain("xread skill");
    });

    it("works without reason field", () => {
      const noReasonRules: UrlRoutingConfig = [
        { match: "x\\.com", action: "redirect", redirectTo: "skill:xread" },
      ];
      const result = evaluateUrlRouting("https://x.com/status/1", noReasonRules);
      expect(result.matched).toBe(true);
      if (!result.matched) {
        return;
      }
      expect(result.blockReason).toContain("skill:xread");
    });

    it("works without redirectTo field", () => {
      const noRedirectRules: UrlRoutingConfig = [
        { match: "x\\.com", action: "redirect", reason: "X blocks scrapers" },
      ];
      const result = evaluateUrlRouting("https://x.com/status/1", noRedirectRules);
      expect(result.matched).toBe(true);
      if (!result.matched) {
        return;
      }
      expect(result.blockReason).toContain("X blocks scrapers");
    });
  });

  describe("action: block", () => {
    const rules: UrlRoutingConfig = [
      {
        match: "internal\\.corp",
        action: "block",
        reason: "Internal URLs are not accessible from the agent runtime.",
      },
    ];

    it("blocks matching URL with reason", () => {
      const result = evaluateUrlRouting("https://api.internal.corp/data", rules);
      expect(result.matched).toBe(true);
      if (!result.matched) {
        return;
      }
      expect(result.rule.action).toBe("block");
      expect(result.blockReason).toContain("Internal URLs");
      expect(result.warnMessage).toBeUndefined();
    });

    it("does not match unrelated URLs", () => {
      const result = evaluateUrlRouting("https://example.com/page", rules);
      expect(result.matched).toBe(false);
    });
  });

  describe("action: warn", () => {
    const rules: UrlRoutingConfig = [
      {
        match: "linkedin\\.com",
        action: "warn",
        reason: "LinkedIn blocks scrapers — results may be empty.",
      },
    ];

    it("returns warnMessage for matching URL", () => {
      const result = evaluateUrlRouting("https://www.linkedin.com/in/user", rules);
      expect(result.matched).toBe(true);
      if (!result.matched) {
        return;
      }
      expect(result.rule.action).toBe("warn");
      expect(result.warnMessage).toContain("LinkedIn blocks scrapers");
      expect(result.blockReason).toBeUndefined();
    });

    it("does not block — no blockReason", () => {
      const result = evaluateUrlRouting("https://linkedin.com/jobs", rules);
      expect(result.matched).toBe(true);
      if (!result.matched) {
        return;
      }
      expect(result.blockReason).toBeUndefined();
    });
  });

  describe("rule precedence", () => {
    it("returns first matching rule", () => {
      const rules: UrlRoutingConfig = [
        { match: "x\\.com", action: "warn", reason: "First rule" },
        { match: "x\\.com", action: "block", reason: "Second rule" },
      ];
      const result = evaluateUrlRouting("https://x.com/status/1", rules);
      expect(result.matched).toBe(true);
      if (!result.matched) {
        return;
      }
      expect(result.rule.action).toBe("warn"); // first match wins
      expect(result.warnMessage).toContain("First rule");
    });
  });

  describe("invalid regex", () => {
    it("skips rules with invalid regex patterns without throwing", () => {
      const rules: UrlRoutingConfig = [
        { match: "[invalid(regex", action: "block" }, // invalid regex
        { match: "example\\.com", action: "block", reason: "Should still match" },
      ];
      // Should not throw, and should still match the valid rule
      const result = evaluateUrlRouting("https://example.com/page", rules);
      expect(result.matched).toBe(true);
      if (!result.matched) {
        return;
      }
      expect(result.blockReason).toContain("Should still match");
    });

    it("returns matched=false when all rules have invalid regex", () => {
      const rules: UrlRoutingConfig = [
        { match: "[bad", action: "block" },
        { match: "((broken", action: "redirect" },
      ];
      const result = evaluateUrlRouting("https://example.com", rules);
      expect(result.matched).toBe(false);
    });
  });
});

describe("resolveUrlRoutingRules", () => {
  it("returns empty array when fetchConfig is undefined", () => {
    expect(resolveUrlRoutingRules(undefined)).toEqual([]);
  });

  it("returns empty array when urlRouting is not set", () => {
    expect(resolveUrlRoutingRules({})).toEqual([]);
  });

  it("returns urlRouting array when configured", () => {
    const rules: UrlRoutingConfig = [
      { match: "x\\.com", action: "redirect", redirectTo: "skill:xread" },
    ];
    expect(resolveUrlRoutingRules({ urlRouting: rules })).toEqual(rules);
  });

  it("returns empty array when urlRouting is explicitly empty", () => {
    expect(resolveUrlRoutingRules({ urlRouting: [] })).toEqual([]);
  });
});
