import type { RequestClient } from "@buape/carbon";
import { PermissionFlagsBits, Routes } from "discord-api-types/v10";
import { describe, expect, it, vi } from "vitest";
import {
  fetchMemberGuildPermissionsDiscord,
  hasAllGuildPermissionsDiscord,
  hasAnyGuildPermissionDiscord,
} from "./send.permissions.js";

const mockRest = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("./client.js", () => ({
  resolveDiscordRest: () => mockRest as unknown as RequestClient,
}));

describe("discord guild permission authorization", () => {
  describe("fetchMemberGuildPermissionsDiscord", () => {
    it("returns null when user is not a guild member", async () => {
      mockRest.get.mockRejectedValueOnce(new Error("404 Member not found"));

      const result = await fetchMemberGuildPermissionsDiscord("guild-1", "user-1");
      expect(result).toBeNull();
    });

    it("includes @everyone and member roles in computed permissions", async () => {
      mockRest.get.mockImplementation(async (route: string) => {
        if (route === Routes.guild("guild-1")) {
          return {
            id: "guild-1",
            roles: [
              { id: "guild-1", permissions: PermissionFlagsBits.ViewChannel.toString() },
              { id: "role-mod", permissions: PermissionFlagsBits.KickMembers.toString() },
            ],
          };
        }
        if (route === Routes.guildMember("guild-1", "user-1")) {
          return {
            id: "user-1",
            roles: ["role-mod"],
          };
        }
        throw new Error(`Unexpected route: ${route}`);
      });

      const result = await fetchMemberGuildPermissionsDiscord("guild-1", "user-1");
      expect(result).not.toBeNull();
      expect((result! & PermissionFlagsBits.ViewChannel) === PermissionFlagsBits.ViewChannel).toBe(
        true,
      );
      expect((result! & PermissionFlagsBits.KickMembers) === PermissionFlagsBits.KickMembers).toBe(
        true,
      );
    });
  });

  describe("hasAnyGuildPermissionDiscord", () => {
    it("returns true when user has required permission", async () => {
      mockRest.get.mockImplementation(async (route: string) => {
        if (route === Routes.guild("guild-1")) {
          return {
            id: "guild-1",
            roles: [
              { id: "guild-1", permissions: "0" },
              { id: "role-mod", permissions: PermissionFlagsBits.KickMembers.toString() },
            ],
          };
        }
        if (route === Routes.guildMember("guild-1", "user-1")) {
          return { id: "user-1", roles: ["role-mod"] };
        }
        throw new Error(`Unexpected route: ${route}`);
      });

      const result = await hasAnyGuildPermissionDiscord("guild-1", "user-1", [
        PermissionFlagsBits.KickMembers,
      ]);
      expect(result).toBe(true);
    });

    it("returns true when user has ADMINISTRATOR", async () => {
      mockRest.get.mockImplementation(async (route: string) => {
        if (route === Routes.guild("guild-1")) {
          return {
            id: "guild-1",
            roles: [
              { id: "guild-1", permissions: "0" },
              {
                id: "role-admin",
                permissions: PermissionFlagsBits.Administrator.toString(),
              },
            ],
          };
        }
        if (route === Routes.guildMember("guild-1", "user-1")) {
          return { id: "user-1", roles: ["role-admin"] };
        }
        throw new Error(`Unexpected route: ${route}`);
      });

      const result = await hasAnyGuildPermissionDiscord("guild-1", "user-1", [
        PermissionFlagsBits.KickMembers,
      ]);
      expect(result).toBe(true);
    });

    it("returns false when user lacks all required permissions", async () => {
      mockRest.get.mockImplementation(async (route: string) => {
        if (route === Routes.guild("guild-1")) {
          return {
            id: "guild-1",
            roles: [{ id: "guild-1", permissions: PermissionFlagsBits.ViewChannel.toString() }],
          };
        }
        if (route === Routes.guildMember("guild-1", "user-1")) {
          return { id: "user-1", roles: [] };
        }
        throw new Error(`Unexpected route: ${route}`);
      });

      const result = await hasAnyGuildPermissionDiscord("guild-1", "user-1", [
        PermissionFlagsBits.BanMembers,
        PermissionFlagsBits.KickMembers,
      ]);
      expect(result).toBe(false);
    });
  });

  describe("hasAllGuildPermissionsDiscord", () => {
    it("returns false when user has only one of multiple required permissions", async () => {
      mockRest.get.mockImplementation(async (route: string) => {
        if (route === Routes.guild("guild-1")) {
          return {
            id: "guild-1",
            roles: [
              { id: "guild-1", permissions: "0" },
              { id: "role-mod", permissions: PermissionFlagsBits.KickMembers.toString() },
            ],
          };
        }
        if (route === Routes.guildMember("guild-1", "user-1")) {
          return { id: "user-1", roles: ["role-mod"] };
        }
        throw new Error(`Unexpected route: ${route}`);
      });

      const result = await hasAllGuildPermissionsDiscord("guild-1", "user-1", [
        PermissionFlagsBits.KickMembers,
        PermissionFlagsBits.BanMembers,
      ]);
      expect(result).toBe(false);
    });
  });
});
