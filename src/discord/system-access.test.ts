/**
 * Tests for Discord System Access Control
 */

import { describe, it, expect } from "vitest";
import {
  resolveDiscordSystemAccess,
  isDiscordOwner,
  formatAccessLevel,
} from "./system-access-resolver.js";
import {
  isToolAllowedForLevel,
  getToolRequiredLevel,
} from "./system-access-types.js";
import type { SystemAccessConfig } from "./system-access-types.js";

describe("Discord System Access Control", () => {
  const OWNER_ID = "119510072865980419";
  const USER_ALICE = "123456789";
  const USER_BOB = "987654321";
  const ROLE_ADMIN = "ROLE_ADMIN_123";
  const ROLE_MODERATOR = "ROLE_MOD_456";

  describe("Access Level Resolution", () => {
    it("returns Level 0 when system access is disabled", () => {
      const result = resolveDiscordSystemAccess({
        userId: USER_ALICE,
        systemAccessConfig: { enabled: false },
      });
      expect(result.level).toBe(0);
      expect(result.source).toBe("default");
    });

    it("identifies owner correctly", () => {
      const config: SystemAccessConfig = {
        enabled: true,
        owner: OWNER_ID,
      };
      const result = resolveDiscordSystemAccess({
        userId: OWNER_ID,
        systemAccessConfig: config,
      });
      expect(result.isOwner).toBe(true);
      expect(result.level).toBe(4);
      expect(result.source).toBe("owner");
    });

    it("applies user-specific grant", () => {
      const config: SystemAccessConfig = {
        enabled: true,
        owner: OWNER_ID,
        users: {
          [USER_ALICE]: {
            level: 2,
            name: "Alice",
          },
        },
      };
      const result = resolveDiscordSystemAccess({
        userId: USER_ALICE,
        systemAccessConfig: config,
      });
      expect(result.level).toBe(2);
      expect(result.source).toBe("user");
      expect(result.grantInfo?.name).toBe("Alice");
    });

    it("applies role-based grant", () => {
      const config: SystemAccessConfig = {
        enabled: true,
        owner: OWNER_ID,
        roles: {
          [ROLE_MODERATOR]: {
            level: 3,
            name: "Moderators",
          },
        },
      };
      const result = resolveDiscordSystemAccess({
        userId: USER_BOB,
        userRoles: [ROLE_MODERATOR],
        systemAccessConfig: config,
      });
      expect(result.level).toBe(3);
      expect(result.source).toBe("role");
      expect(result.roleId).toBe(ROLE_MODERATOR);
    });

    it("uses highest role level when user has multiple roles", () => {
      const config: SystemAccessConfig = {
        enabled: true,
        owner: OWNER_ID,
        roles: {
          [ROLE_ADMIN]: { level: 4, name: "Admins" },
          [ROLE_MODERATOR]: { level: 3, name: "Moderators" },
        },
      };
      const result = resolveDiscordSystemAccess({
        userId: USER_BOB,
        userRoles: [ROLE_MODERATOR, ROLE_ADMIN],
        systemAccessConfig: config,
      });
      expect(result.level).toBe(4);
      expect(result.roleId).toBe(ROLE_ADMIN);
    });

    it("prioritizes user grant over role grant", () => {
      const config: SystemAccessConfig = {
        enabled: true,
        owner: OWNER_ID,
        users: {
          [USER_ALICE]: { level: 2, name: "Alice" },
        },
        roles: {
          [ROLE_MODERATOR]: { level: 3, name: "Moderators" },
        },
      };
      const result = resolveDiscordSystemAccess({
        userId: USER_ALICE,
        userRoles: [ROLE_MODERATOR],
        systemAccessConfig: config,
      });
      expect(result.level).toBe(2);
      expect(result.source).toBe("user");
    });

    it("falls back to default level when no grants match", () => {
      const config: SystemAccessConfig = {
        enabled: true,
        owner: OWNER_ID,
        defaultLevel: 1,
      };
      const result = resolveDiscordSystemAccess({
        userId: USER_BOB,
        systemAccessConfig: config,
      });
      expect(result.level).toBe(1);
      expect(result.source).toBe("default");
    });

    it("ignores expired grants", () => {
      const config: SystemAccessConfig = {
        enabled: true,
        owner: OWNER_ID,
        users: {
          [USER_ALICE]: {
            level: 3,
            expiresAt: "2020-01-01T00:00:00Z", // Expired
          },
        },
        defaultLevel: 0,
      };
      const result = resolveDiscordSystemAccess({
        userId: USER_ALICE,
        systemAccessConfig: config,
      });
      expect(result.level).toBe(0);
      expect(result.source).toBe("default");
    });
  });

  describe("Tool Access Requirements", () => {
    it("allows Level 0 tools for Level 0 users", () => {
      expect(isToolAllowedForLevel("web_search", 0)).toBe(true);
      expect(isToolAllowedForLevel("web_fetch", 0)).toBe(true);
      expect(isToolAllowedForLevel("message", 0)).toBe(true);
    });

    it("denies Level 1+ tools for Level 0 users", () => {
      expect(isToolAllowedForLevel("read", 0)).toBe(false);
      expect(isToolAllowedForLevel("write", 0)).toBe(false);
      expect(isToolAllowedForLevel("exec", 0)).toBe(false);
    });

    it("allows read tools for Level 1 users", () => {
      expect(isToolAllowedForLevel("read", 1)).toBe(true);
      expect(isToolAllowedForLevel("memory_get", 1)).toBe(true);
    });

    it("allows write tools for Level 2 users", () => {
      expect(isToolAllowedForLevel("write", 2)).toBe(true);
      expect(isToolAllowedForLevel("edit", 2)).toBe(true);
    });

    it("allows exec tools for Level 3 users", () => {
      expect(isToolAllowedForLevel("exec", 3)).toBe(true);
      expect(isToolAllowedForLevel("process", 3)).toBe(true);
    });

    it("allows admin tools for Level 4 users", () => {
      expect(isToolAllowedForLevel("gateway", 4)).toBe(true);
      expect(isToolAllowedForLevel("cron", 4)).toBe(true);
    });

    it("defaults unknown tools to Level 4 (admin only)", () => {
      const unknownToolLevel = getToolRequiredLevel("unknown_dangerous_tool");
      expect(unknownToolLevel).toBe(4);
      expect(isToolAllowedForLevel("unknown_dangerous_tool", 3)).toBe(false);
      expect(isToolAllowedForLevel("unknown_dangerous_tool", 4)).toBe(true);
    });
  });

  describe("Owner Detection", () => {
    it("identifies owner correctly", () => {
      const config: SystemAccessConfig = {
        enabled: true,
        owner: OWNER_ID,
      };
      expect(isDiscordOwner({ userId: OWNER_ID, systemAccessConfig: config })).toBe(true);
      expect(isDiscordOwner({ userId: USER_ALICE, systemAccessConfig: config })).toBe(false);
    });

    it("returns false when no owner is configured", () => {
      const config: SystemAccessConfig = { enabled: true };
      expect(isDiscordOwner({ userId: OWNER_ID, systemAccessConfig: config })).toBe(false);
    });
  });

  describe("Formatting", () => {
    it("formats access levels correctly", () => {
      expect(formatAccessLevel(0)).toContain("Chat Only");
      expect(formatAccessLevel(1)).toContain("Information Reader");
      expect(formatAccessLevel(2)).toContain("Content Editor");
      expect(formatAccessLevel(3)).toContain("Developer");
      expect(formatAccessLevel(4)).toContain("System Administrator");
    });
  });
});
