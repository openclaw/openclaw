import { expectDefined } from "@openclaw/normalization-core/expect";
import { describe, expect, it, vi } from "vitest";
import { identityEntryAuthenticationClassifier } from "../channels/message-access/runtime-identity.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/config.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { stubAuditChannelPlugin } from "./audit-channel-test-helpers.js";
import { collectChannelSecurityFindingsCore } from "./audit-channel.js";

vi.mock("../channels/message-access/store-allow-from.js", () => ({
  readChannelIngressStoreAllowFromForDmPolicy: async () => ["stored-only#9999"],
}));

const classifyEntryAuthentication = identityEntryAuthenticationClassifier({
  key: "stable-id",
  kind: "stable-id",
  authentication: "verified",
  normalizeEntry: (value) => (/^\d+$/.test(value.trim()) ? value.trim() : null),
  aliases: [
    {
      key: "display-name",
      kind: "username",
      authentication: "mutable",
      normalizeEntry: (value) => {
        const text = value.trim();
        return text && !/^\d+$/.test(text) ? text.toLowerCase() : null;
      },
    },
  ],
});

type FixtureAccount = { allowFrom: Array<string | number>; dangerouslyAllowNameMatching?: boolean };

function createFixturePlugin(accounts: Record<string, FixtureAccount>): ChannelPlugin {
  const accountIds = Object.keys(accounts);
  const plugin = stubAuditChannelPlugin({
    id: "whatsapp",
    label: "WhatsApp",
    commands: undefined,
    collectAuditFindings: undefined,
    resolveAccount: (_cfg, accountId) => ({
      accountId: accountId ?? "default",
      config: accounts[accountId ?? "default"],
    }),
  });
  plugin.config.listAccountIds = () => accountIds;
  plugin.config.defaultAccountId = () => accountIds[0] ?? "default";
  plugin.security = {
    resolveDmPolicy: ({ accountId }: { accountId?: string | null }) => {
      const resolvedAccountId = accountId ?? "default";
      const account = expectDefined(accounts[resolvedAccountId], "fixture account");
      const scope = resolvedAccountId === "default" ? "" : `accounts.${resolvedAccountId}.`;
      return {
        policy: "allowlist",
        allowFrom: account.allowFrom,
        policyPath: `channels.whatsapp.${scope}dmPolicy`,
        allowFromPath: `channels.whatsapp.${scope}`,
        approveHint: `approve ${resolvedAccountId}`,
        classifyEntryAuthentication,
      };
    },
  };
  return plugin;
}

describe("channel entry authentication audit", () => {
  const stableId = "123456789012345678";
  const name = "Alice Example";
  const inertCheckId = "channels.whatsapp.allowFrom.mutable_entries_inert";
  const cfg: OpenClawConfig = { session: { dmScope: "per-account-channel-peer" } };

  it.each([
    ["default policy", [name, stableId], undefined, 1],
    ["stable IDs only", [stableId], false, 0],
    ["access group reference", ["accessGroup:operators"], false, 0],
    ["access group preview", ["accessGroup:operators", name], true, 1],
    ["wildcard excluded", [name, stableId, "*"], false, 1],
    ["lockout preview", [name, stableId], true, 1],
    ["zero lockout preview", [stableId], true, 0],
  ] satisfies [string, string[], boolean | undefined, number][])(
    "reports counts without identifiers: %s",
    async (_caseName, allowFrom, enabled, count) => {
      const plugin = createFixturePlugin({
        default: { allowFrom, dangerouslyAllowNameMatching: enabled },
      });
      const findings = await collectChannelSecurityFindingsCore({ cfg, plugins: [plugin] });

      const configuredEntries = allowFrom.filter((raw) => raw !== "*");
      const inert = findings.find((finding) => finding.checkId === inertCheckId);
      if (!enabled && count > 0) {
        expect(inert).toMatchObject({ severity: "warn" });
        expect(inert?.detail).toContain(
          `${count} of ${configuredEntries.length} entries in channels.whatsapp.allowFrom`,
        );
        expect(inert?.detail).toContain("silently inert");
      } else {
        expect(inert).toBeUndefined();
      }
      if (enabled) {
        const preview = findings.find((finding) =>
          finding.checkId.endsWith("dangerous_name_matching_enabled"),
        );
        expect(preview?.detail).toContain(
          `${count} of ${configuredEntries.length} allowFrom entries depend on mutable matching`,
        );
        expect(preview?.detail).toContain("mutable_identifier_disabled");
        expect(preview?.detail).toContain("identifier_authentication_too_weak");
      }
      const serialized = JSON.stringify(findings);
      for (const raw of [name, stableId, "stored-only#9999"]) {
        expect(serialized).not.toContain(raw);
      }
    },
  );

  it("uses the account policy and exposes inert entries to doctor", async () => {
    const plugin = createFixturePlugin({
      default: { allowFrom: [stableId], dangerouslyAllowNameMatching: true },
      work: { allowFrom: [name], dangerouslyAllowNameMatching: false },
    });
    const findings = await collectChannelSecurityFindingsCore({
      cfg,
      plugins: [plugin],
      mode: "doctor",
    });
    expect(findings.find((finding) => finding.checkId === inertCheckId)).toMatchObject({
      severity: "warn",
      detail: expect.stringContaining(
        "1 of 1 entries in channels.whatsapp.accounts.work.allowFrom",
      ),
    });
    expect(JSON.stringify(findings)).not.toContain(name);
  });

  it("warns when real WhatsApp and Slack channel accounts use mutable toolsBySender keys without leaking identifiers", async () => {
    const { whatsappSetupPlugin } = await loadBundledPluginFacade<{
      whatsappSetupPlugin: ChannelPlugin;
    }>({
      pluginId: "whatsapp",
      artifactBasename: "api.js",
    });
    const { slackPlugin } = await loadBundledPluginFacade<{
      slackPlugin: ChannelPlugin;
    }>({
      pluginId: "slack",
      artifactBasename: "api.js",
    });
    const { runSecurityAuditCore } = await import("./audit.js");
    const { collectSecurityWarnings } = await import("../commands/doctor-security.js");
    const readOnlyPluginsModule = await import("../channels/plugins/read-only.js");
    const listReadOnlySpy = vi
      .spyOn(readOnlyPluginsModule, "listReadOnlyChannelPluginsForConfig")
      .mockReturnValue([whatsappSetupPlugin, slackPlugin]);
    const readOverride = (sender: string) => ({
      toolsBySender: { [sender]: { allow: ["read"] } },
    });

    const auditConfig: OpenClawConfig = {
      session: { dmScope: "per-account-channel-peer" },
      channels: {
        whatsapp: {
          allowFrom: [stableId],
          groups: {
            "120363123456789@g.us": {
              tools: { deny: ["exec"] },
              toolsBySender: {
                "name:ops-lead-name": { alsoAllow: ["exec"] },
                "id:12345": { allow: ["exec"] },
              },
            },
          },
          accounts: {
            default: { authDir: "/tmp/openclaw-whatsapp-default-audit-test" },
            work: {
              authDir: "/tmp/openclaw-whatsapp-work-audit-test",
              groups: {
                "120363999999999@g.us": readOverride("username:bob-handle"),
              },
            },
          },
        },
        slack: {
          enabled: true,
          botToken: "xoxb-test-token",
          appToken: "xapp-test-token",
          channels: { accounts: readOverride("username:alice-handle") },
        },
      },
    };

    try {
      const report = await runSecurityAuditCore({
        config: auditConfig,
        sourceConfig: auditConfig,
        includeFilesystem: false,
        loadPluginSecurityCollectors: false,
        plugins: [whatsappSetupPlugin, slackPlugin],
      });
      const doctorFindings = await collectSecurityWarnings(auditConfig);

      for (const findings of [report.findings, doctorFindings]) {
        for (const [channel, account, scope] of [
          ["whatsapp", "default", "accounts.default.groups.120363123456789@g.us"],
          ["whatsapp", "work", "accounts.work.groups.120363999999999@g.us"],
          ["slack", "", "channels.accounts"],
        ]) {
          const finding = findings.find(
            (entry) =>
              entry.checkId === `channels.${channel}.toolsBySender.mutable_entries` &&
              (!account || entry.title.includes(`(account: ${account})`)),
          );
          expect(finding).toMatchObject({
            severity: "warn",
            detail: expect.stringContaining(
              `1 toolsBySender entry in channels.${channel}.${scope}.toolsBySender match mutable username:/name: sender attributes`,
            ),
          });
          if (account !== "work") {
            expect(finding?.remediation).toBe(
              "Prefer stable id: keys in toolsBySender, especially for entries that grant extra tools or override group deny rules.",
            );
          }
        }
        const serialized = JSON.stringify(findings);
        for (const identifier of ["ops-lead-name", "alice-handle", "bob-handle"]) {
          expect(serialized).not.toContain(identifier);
        }
      }
    } finally {
      listReadOnlySpy.mockRestore();
    }
  });
});
