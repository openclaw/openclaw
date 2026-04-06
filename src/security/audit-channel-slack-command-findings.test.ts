import { describe, expect, it, vi } from "vitest";
import type { ResolvedSlackAccount } from "../../extensions/slack/src/accounts.js";
import { collectSlackSecurityAuditFindings } from "../../extensions/slack/src/security-audit.js";
import type { OpenClawConfig } from "../config/config.js";
import { withChannelSecurityStateDir } from "./audit-channel-security.test-helpers.js";

const { readChannelAllowFromStoreMock } = vi.hoisted(() => ({
  readChannelAllowFromStoreMock: vi.fn(async () => [] as string[]),
}));

vi.mock("openclaw/plugin-sdk/conversation-runtime", () => ({
  readChannelAllowFromStore: readChannelAllowFromStoreMock,
}));

function createSlackAccount(
  config: NonNullable<OpenClawConfig["channels"]>["slack"],
): ResolvedSlackAccount {
  return {
    accountId: "default",
    enabled: true,
    botToken: "xoxb-test",
    botTokenSource: "config",
    appTokenSource: "config",
    config,
  } as ResolvedSlackAccount;
}

describe("security audit slack command findings", () => {
  it("flags Slack slash commands without a channel users allowlist", async () => {
    const cfg: OpenClawConfig = {
      channels: {
        slack: {
          enabled: true,
          botToken: "xoxb-test",
          appToken: "xapp-test",
          groupPolicy: "open",
          slashCommand: { enabled: true },
        },
      },
    };

    await withChannelSecurityStateDir(async () => {
      readChannelAllowFromStoreMock.mockResolvedValue([]);
      const findings = await collectSlackSecurityAuditFindings({
        cfg: cfg as OpenClawConfig & {
          channels: {
            slack: NonNullable<OpenClawConfig["channels"]>["slack"];
          };
        },
        account: createSlackAccount(cfg.channels!.slack),
        accountId: "default",
      });

      expect(findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            checkId: "channels.slack.commands.slash.no_allowlists",
            severity: "warn",
          }),
        ]),
      );
    });
  });

  it("flags Slack slash commands when access-group enforcement is disabled", async () => {
    const cfg: OpenClawConfig = {
      commands: { useAccessGroups: false },
      channels: {
        slack: {
          enabled: true,
          botToken: "xoxb-test",
          appToken: "xapp-test",
          groupPolicy: "open",
          slashCommand: { enabled: true },
        },
      },
    };

    await withChannelSecurityStateDir(async () => {
      readChannelAllowFromStoreMock.mockResolvedValue([]);
      const findings = await collectSlackSecurityAuditFindings({
        cfg: cfg as OpenClawConfig & {
          channels: {
            slack: NonNullable<OpenClawConfig["channels"]>["slack"];
          };
        },
        account: createSlackAccount(cfg.channels!.slack),
        accountId: "default",
      });

      expect(findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            checkId: "channels.slack.commands.slash.useAccessGroups_off",
            severity: "critical",
          }),
        ]),
      );
    });
  });
});
