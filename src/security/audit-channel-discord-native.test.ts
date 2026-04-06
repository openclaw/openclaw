import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { collectDiscordSecurityAuditFindings } from "../plugin-sdk/discord.js";

type DiscordAuditParams = Parameters<typeof collectDiscordSecurityAuditFindings>[0];
type ResolvedDiscordAccount = DiscordAuditParams["account"];
type DiscordAccountConfig = ResolvedDiscordAccount["config"];

const { readChannelAllowFromStoreMock } = vi.hoisted(() => ({
  readChannelAllowFromStoreMock: vi.fn(async () => [] as string[]),
}));

vi.mock("openclaw/plugin-sdk/conversation-runtime", () => ({
  readChannelAllowFromStore: readChannelAllowFromStoreMock,
}));

function createAccount(config: DiscordAccountConfig): ResolvedDiscordAccount {
  return {
    accountId: "default",
    enabled: true,
    token: "t",
    tokenSource: "config",
    config,
  };
}

describe("security audit discord native command findings", () => {
  it("evaluates Discord native command allowlist findings", async () => {
    const cases = [
      {
        name: "flags missing guild user allowlists",
        cfg: {
          commands: { native: true },
          channels: {
            discord: {
              enabled: true,
              token: "t",
              groupPolicy: "allowlist",
              guilds: {
                "123": {
                  channels: {
                    general: { enabled: true },
                  },
                },
              },
            },
          },
        } as OpenClawConfig,
        expectFinding: true,
      },
      {
        name: "does not flag when dm.allowFrom includes a Discord snowflake id",
        cfg: {
          commands: { native: true },
          channels: {
            discord: {
              enabled: true,
              token: "t",
              dm: { allowFrom: ["387380367612706819"] },
              groupPolicy: "allowlist",
              guilds: {
                "123": {
                  channels: {
                    general: { enabled: true },
                  },
                },
              },
            },
          },
        } as OpenClawConfig,
        expectFinding: false,
      },
    ] as const;

    for (const testCase of cases) {
      readChannelAllowFromStoreMock.mockResolvedValue([]);
      const discord = testCase.cfg.channels?.discord;
      if (!discord) {
        throw new Error("discord config required");
      }
      const findings = await collectDiscordSecurityAuditFindings({
        cfg: testCase.cfg as OpenClawConfig & { channels: { discord: DiscordAccountConfig } },
        account: createAccount(discord),
        accountId: "default",
        orderedAccountIds: ["default"],
        hasExplicitAccountPath: false,
      });

      expect(
        findings.some(
          (finding) => finding.checkId === "channels.discord.commands.native.no_allowlists",
        ),
        testCase.name,
      ).toBe(testCase.expectFinding);
    }
  });
});
