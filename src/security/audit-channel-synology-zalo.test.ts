import { describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { collectSynologyChatSecurityAuditFindings } from "../plugin-sdk/synology-chat.js";
import { collectZalouserSecurityAuditFindings } from "../plugin-sdk/zalouser.js";
import { withChannelSecurityStateDir } from "./audit-channel-security.test-helpers.js";
import { collectChannelSecurityFindings } from "./audit-channel.js";

type SynologyAuditParams = Parameters<typeof collectSynologyChatSecurityAuditFindings>[0];
type ResolvedSynologyChatAccount = SynologyAuditParams["account"];
type ZalouserAuditParams = Parameters<typeof collectZalouserSecurityAuditFindings>[0];
type ResolvedZalouserAccount = ZalouserAuditParams["account"];

function stubZalouserPlugin(): ChannelPlugin {
  return {
    id: "zalouser",
    meta: {
      id: "zalouser",
      label: "Zalo Personal",
      selectionLabel: "Zalo Personal",
      docsPath: "/docs/testing",
      blurb: "test stub",
    },
    capabilities: {
      chatTypes: ["direct", "group"],
    },
    security: {
      collectAuditFindings: collectZalouserSecurityAuditFindings,
    },
    config: {
      listAccountIds: () => ["default"],
      inspectAccount: (cfg) => ({
        accountId: "default",
        enabled: true,
        configured: true,
        config: cfg.channels?.zalouser ?? {},
      }),
      resolveAccount: (cfg) =>
        ({
          accountId: "default",
          enabled: true,
          config: cfg.channels?.zalouser ?? {},
        }) as ResolvedZalouserAccount,
      isEnabled: () => true,
      isConfigured: () => true,
    },
  };
}

function createSynologyChatAccount(params: {
  cfg: OpenClawConfig;
  accountId: string;
}): ResolvedSynologyChatAccount {
  const channel = params.cfg.channels?.["synology-chat"] ?? {};
  const accountConfig =
    params.accountId === "default"
      ? channel
      : ((channel.accounts as Record<string, unknown> | undefined)?.[params.accountId] ?? {});
  return {
    accountId: params.accountId,
    dangerouslyAllowNameMatching:
      Boolean(
        (accountConfig as { dangerouslyAllowNameMatching?: boolean }).dangerouslyAllowNameMatching,
      ) ||
      Boolean(
        params.accountId === "default" &&
        (channel as { dangerouslyAllowNameMatching?: boolean }).dangerouslyAllowNameMatching,
      ),
  } as ResolvedSynologyChatAccount;
}

describe("security audit synology and zalo channel routing", () => {
  it.each([
    {
      name: "audits Synology Chat base dangerous name matching",
      cfg: {
        channels: {
          "synology-chat": {
            token: "t",
            incomingUrl: "https://nas.example.com/incoming",
            dangerouslyAllowNameMatching: true,
          },
        },
      } satisfies OpenClawConfig,
      expectedMatch: {
        checkId: "channels.synology-chat.reply.dangerous_name_matching_enabled",
        severity: "info",
        title: "Synology Chat dangerous name matching is enabled",
      },
    },
    {
      name: "audits non-default Synology Chat accounts for dangerous name matching",
      cfg: {
        channels: {
          "synology-chat": {
            token: "t",
            incomingUrl: "https://nas.example.com/incoming",
            accounts: {
              alpha: {
                token: "a",
                incomingUrl: "https://nas.example.com/incoming-alpha",
              },
              beta: {
                token: "b",
                incomingUrl: "https://nas.example.com/incoming-beta",
                dangerouslyAllowNameMatching: true,
              },
            },
          },
        },
      } satisfies OpenClawConfig,
      expectedMatch: {
        checkId: "channels.synology-chat.reply.dangerous_name_matching_enabled",
        severity: "info",
        title: expect.stringContaining("(account: beta)"),
      },
    },
  ])("$name", async (testCase) => {
    await withChannelSecurityStateDir(async () => {
      const synologyChat = testCase.cfg.channels?.["synology-chat"];
      if (!synologyChat) {
        throw new Error("synology-chat config required");
      }
      const accountId = Object.keys(synologyChat.accounts ?? {}).includes("beta")
        ? "beta"
        : "default";
      const findings = collectSynologyChatSecurityAuditFindings({
        account: createSynologyChatAccount({ cfg: testCase.cfg, accountId }),
        accountId,
        orderedAccountIds: Object.keys(synologyChat.accounts ?? {}),
        hasExplicitAccountPath: accountId !== "default",
      });
      expect(findings).toEqual(
        expect.arrayContaining([expect.objectContaining(testCase.expectedMatch)]),
      );
    });
  });

  it.each([
    {
      name: "warns when Zalouser group routing contains mutable group entries",
      cfg: {
        channels: {
          zalouser: {
            enabled: true,
            groups: {
              "Ops Room": { allow: true },
              "group:g-123": { allow: true },
            },
          },
        },
      } satisfies OpenClawConfig,
      expectedSeverity: "warn",
      detailIncludes: ["channels.zalouser.groups:Ops Room"],
      detailExcludes: ["group:g-123"],
    },
    {
      name: "marks Zalouser mutable group routing as break-glass when dangerous matching is enabled",
      cfg: {
        channels: {
          zalouser: {
            enabled: true,
            dangerouslyAllowNameMatching: true,
            groups: {
              "Ops Room": { allow: true },
            },
          },
        },
      } satisfies OpenClawConfig,
      expectedSeverity: "info",
      detailIncludes: ["out-of-scope"],
      expectFindingMatch: {
        checkId: "channels.zalouser.allowFrom.dangerous_name_matching_enabled",
        severity: "info",
      },
    },
  ])("$name", async (testCase) => {
    await withChannelSecurityStateDir(async () => {
      const findings = await collectChannelSecurityFindings({
        cfg: testCase.cfg,
        plugins: [stubZalouserPlugin()],
      });
      const finding = findings.find(
        (entry) => entry.checkId === "channels.zalouser.groups.mutable_entries",
      );

      expect(finding).toBeDefined();
      expect(finding?.severity).toBe(testCase.expectedSeverity);
      for (const snippet of testCase.detailIncludes) {
        expect(finding?.detail).toContain(snippet);
      }
      for (const snippet of testCase.detailExcludes ?? []) {
        expect(finding?.detail).not.toContain(snippet);
      }
      if (testCase.expectFindingMatch) {
        expect(findings).toEqual(
          expect.arrayContaining([expect.objectContaining(testCase.expectFindingMatch)]),
        );
      }
    });
  });
});
