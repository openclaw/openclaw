import { describe, expect, it } from "vitest";
import {
  buildPortalSessionKey,
  buildChannelSessionKey,
  extractTenantId,
  extractAgentId,
  extractInnerSessionKey,
  isSessionForTenant,
  isSessionForAgent,
  buildTenantMemoryNamespace,
} from "./session-manager.js";

describe("session-manager", () => {
  describe("buildPortalSessionKey", () => {
    it("uses default agentId", () => {
      expect(buildPortalSessionKey("user123")).toBe("tenant_user123:main:main");
    });

    it("uses custom agentId", () => {
      expect(buildPortalSessionKey("user123", "work")).toBe("tenant_user123:work:main");
    });
  });

  describe("buildChannelSessionKey", () => {
    it("builds key without threadId", () => {
      expect(buildChannelSessionKey("user123", "main", "telegram", "98765")).toBe(
        "tenant_user123:main:telegram:98765",
      );
    });

    it("builds key with threadId", () => {
      expect(buildChannelSessionKey("user123", "main", "slack", "U111", "T999")).toBe(
        "tenant_user123:main:slack:U111:T999",
      );
    });

    it("defaults agentId to main", () => {
      expect(buildChannelSessionKey("user123", undefined, "discord", "D555")).toBe(
        "tenant_user123:main:discord:D555",
      );
    });

    it("uses custom agentId", () => {
      expect(buildChannelSessionKey("user123", "personal", "whatsapp", "W777")).toBe(
        "tenant_user123:personal:whatsapp:W777",
      );
    });
  });

  describe("extractTenantId", () => {
    it("extracts userId from portal key", () => {
      expect(extractTenantId("tenant_user123:main:main")).toBe("user123");
    });

    it("extracts userId from channel key", () => {
      expect(extractTenantId("tenant_abc:work:telegram:98765")).toBe("abc");
    });

    it("returns null for non-tenant key", () => {
      expect(extractTenantId("main")).toBeNull();
    });

    it("returns null for empty string", () => {
      expect(extractTenantId("")).toBeNull();
    });

    it("returns null for tenant_ prefix with no separator", () => {
      expect(extractTenantId("tenant_user123")).toBeNull();
    });

    it("handles tenant_ prefix with immediate separator", () => {
      expect(extractTenantId("tenant_:main:main")).toBe("");
    });
  });

  describe("extractAgentId", () => {
    it("extracts agentId from portal key", () => {
      expect(extractAgentId("tenant_user123:main:main")).toBe("main");
    });

    it("extracts custom agentId", () => {
      expect(extractAgentId("tenant_user123:work:telegram:98765")).toBe("work");
    });

    it("returns default for non-tenant key", () => {
      expect(extractAgentId("some:other:key")).toBe("main");
    });

    it("returns default when no separator after prefix", () => {
      expect(extractAgentId("tenant_user123")).toBe("main");
    });

    it("returns agentId when only userId and agentId present", () => {
      expect(extractAgentId("tenant_user123:work")).toBe("work");
    });

    it("returns default for empty agentId segment", () => {
      expect(extractAgentId("tenant_user123::rest")).toBe("main");
    });
  });

  describe("extractInnerSessionKey", () => {
    it("extracts inner key from portal session", () => {
      expect(extractInnerSessionKey("tenant_user123:main:main")).toBe("main");
    });

    it("extracts inner key from channel session", () => {
      expect(extractInnerSessionKey("tenant_user123:work:telegram:98765")).toBe("telegram:98765");
    });

    it("extracts inner key with threadId", () => {
      expect(extractInnerSessionKey("tenant_user123:main:slack:U111:T999")).toBe("slack:U111:T999");
    });

    it("returns original key for non-tenant key", () => {
      expect(extractInnerSessionKey("telegram:12345")).toBe("telegram:12345");
    });

    it("returns original when no separator after prefix", () => {
      expect(extractInnerSessionKey("tenant_user123")).toBe("tenant_user123");
    });

    it("returns agentId when no second separator", () => {
      expect(extractInnerSessionKey("tenant_user123:work")).toBe("work");
    });
  });

  describe("isSessionForTenant", () => {
    it("returns true for matching userId", () => {
      expect(isSessionForTenant("tenant_user123:main:main", "user123")).toBe(true);
    });

    it("returns false for different userId", () => {
      expect(isSessionForTenant("tenant_user123:main:main", "user456")).toBe(false);
    });

    it("returns false for non-tenant key", () => {
      expect(isSessionForTenant("main", "user123")).toBe(false);
    });

    it("does not match partial userId prefix", () => {
      expect(isSessionForTenant("tenant_user123:main:main", "user12")).toBe(false);
    });
  });

  describe("isSessionForAgent", () => {
    it("returns true for matching userId and default agentId", () => {
      expect(isSessionForAgent("tenant_user123:main:main", "user123")).toBe(true);
    });

    it("returns true for matching userId and custom agentId", () => {
      expect(isSessionForAgent("tenant_user123:work:telegram:98765", "user123", "work")).toBe(true);
    });

    it("returns false for wrong agentId", () => {
      expect(isSessionForAgent("tenant_user123:work:main", "user123", "personal")).toBe(false);
    });

    it("returns false for wrong userId", () => {
      expect(isSessionForAgent("tenant_user123:main:main", "user456")).toBe(false);
    });

    it("returns false for non-tenant key", () => {
      expect(isSessionForAgent("main", "user123")).toBe(false);
    });
  });

  describe("buildTenantMemoryNamespace", () => {
    it("builds namespace with default agentId", () => {
      expect(buildTenantMemoryNamespace("user123")).toBe("tenant_user123:main");
    });

    it("builds namespace with custom agentId", () => {
      expect(buildTenantMemoryNamespace("user123", "work")).toBe("tenant_user123:work");
    });
  });
});
