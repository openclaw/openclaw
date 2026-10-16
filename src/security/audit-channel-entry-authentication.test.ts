// Covers the entry-authentication audit findings with a synthetic channel fixture;
// bundled-channel classifier wiring is proven in each channel's own suite.
import { describe, expect, it, vi } from "vitest";
import { identityEntryAuthenticationClassifier } from "../channels/message-access/runtime-identity.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/config.js";
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

function createFixturePlugin(params: {
  accounts: Record<
    string,
    {
      allowFrom: Array<string | number>;
      dangerouslyAllowNameMatching?: boolean;
    }
  >;
}): ChannelPlugin {
  const accountIds = Object.keys(params.accounts);
  return {
    id: "whatsapp",
    meta: {
      id: "whatsapp",
      label: "WhatsApp",
      selectionLabel: "WhatsApp",
      docsPath: "/channels/whatsapp",
      blurb: "Test",
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => accountIds,
      defaultAccountId: () => accountIds[0] ?? "default",
      inspectAccount: (_cfg, accountId) => {
        const resolvedAccountId = accountId ?? "default";
        return {
          accountId: resolvedAccountId,
          enabled: true,
          configured: true,
          config: {
            dangerouslyAllowNameMatching:
              params.accounts[resolvedAccountId]?.dangerouslyAllowNameMatching,
          },
        };
      },
      resolveAccount: (_cfg, accountId) => {
        const resolvedAccountId = accountId ?? "default";
        return {
          accountId: resolvedAccountId,
          config: {
            dangerouslyAllowNameMatching:
              params.accounts[resolvedAccountId]?.dangerouslyAllowNameMatching,
          },
        };
      },
      isEnabled: () => true,
      isConfigured: () => true,
    },
    security: {
      resolveDmPolicy: ({ accountId }: { accountId?: string | null }) => {
        const resolvedAccountId = accountId ?? "default";
        const account = params.accounts[resolvedAccountId];
        if (!account) {
          return null;
        }
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
    },
  };
}

describe("channel entry authentication audit", () => {
  const stableId = "123456789012345678";
  const name = "Alice Example";
  const inertCheckId = "channels.whatsapp.allowFrom.mutable_entries_inert";
  const cfg: OpenClawConfig = { session: { dmScope: "per-account-channel-peer" } };

  it.each([
    { caseName: "default policy", allowFrom: [name, stableId], enabled: undefined, count: 1 },
    { caseName: "stable IDs only", allowFrom: [stableId], enabled: false, count: 0 },
    {
      caseName: "access group reference",
      allowFrom: ["accessGroup:operators"],
      enabled: false,
      count: 0,
    },
    {
      caseName: "access group preview",
      allowFrom: ["accessGroup:operators", name],
      enabled: true,
      count: 1,
    },
    { caseName: "wildcard excluded", allowFrom: [name, stableId, "*"], enabled: false, count: 1 },
    { caseName: "lockout preview", allowFrom: [name, stableId], enabled: true, count: 1 },
    { caseName: "zero lockout preview", allowFrom: [stableId], enabled: true, count: 0 },
  ])("reports counts without identifiers: $caseName", async ({ allowFrom, enabled, count }) => {
    const plugin = createFixturePlugin({
      accounts: { default: { allowFrom, dangerouslyAllowNameMatching: enabled } },
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
  });

  it("uses the account policy and exposes inert entries to doctor", async () => {
    const plugin = createFixturePlugin({
      accounts: {
        default: { allowFrom: [stableId], dangerouslyAllowNameMatching: true },
        work: { allowFrom: [name], dangerouslyAllowNameMatching: false },
      },
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
    const { loadBundledPluginFacade } =
      await import("../test-utils/bundled-plugin-public-surface.js");
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
            default: {
              authDir: "/tmp/openclaw-whatsapp-default-audit-test",
            },
            work: {
              authDir: "/tmp/openclaw-whatsapp-work-audit-test",
              groups: {
                "120363999999999@g.us": {
                  toolsBySender: {
                    "username:bob-handle": { allow: ["read"] },
                  },
                },
              },
            },
          },
        },
        slack: {
          enabled: true,
          botToken: "xoxb-test-token",
          appToken: "xapp-test-token",
          channels: {
            accounts: {
              toolsBySender: {
                "username:alice-handle": { allow: ["read"] },
              },
            },
          },
        },
      },
    };

    try {
      const report = await runSecurityAuditCore({
        config: auditConfig,
        sourceConfig: auditConfig,
        includeFilesystem: false,
        includeChannelSecurity: true,
        loadPluginSecurityCollectors: false,
        plugins: [whatsappSetupPlugin, slackPlugin],
      });
      const doctorFindings = await collectSecurityWarnings(auditConfig);

      for (const findings of [report.findings, doctorFindings]) {
        const whatsappDefaultFinding = findings.find(
          (entry) =>
            entry.checkId === "channels.whatsapp.toolsBySender.mutable_entries" &&
            entry.title.includes("(account: default)"),
        );
        expect(whatsappDefaultFinding).toMatchObject({
          severity: "warn",
          detail: expect.stringContaining(
            "1 toolsBySender entry in channels.whatsapp.accounts.default.groups.120363123456789@g.us.toolsBySender match mutable username:/name: sender attributes",
          ),
          remediation:
            "Prefer stable id: keys in toolsBySender, especially for entries that grant extra tools or override group deny rules.",
        });

        const whatsappWorkFinding = findings.find(
          (entry) =>
            entry.checkId === "channels.whatsapp.toolsBySender.mutable_entries" &&
            entry.title.includes("(account: work)"),
        );
        expect(whatsappWorkFinding).toMatchObject({
          severity: "warn",
          detail: expect.stringContaining(
            "1 toolsBySender entry in channels.whatsapp.accounts.work.groups.120363999999999@g.us.toolsBySender match mutable username:/name: sender attributes",
          ),
        });

        const slackFinding = findings.find(
          (entry) => entry.checkId === "channels.slack.toolsBySender.mutable_entries",
        );
        expect(slackFinding).toMatchObject({
          severity: "warn",
          detail: expect.stringContaining(
            "1 toolsBySender entry in channels.slack.channels.accounts.toolsBySender match mutable username:/name: sender attributes",
          ),
          remediation:
            "Prefer stable id: keys in toolsBySender, especially for entries that grant extra tools or override group deny rules.",
        });

        const serialized = JSON.stringify(findings);
        expect(serialized).not.toContain("ops-lead-name");
        expect(serialized).not.toContain("alice-handle");
        expect(serialized).not.toContain("bob-handle");
      }
    } finally {
      listReadOnlySpy.mockRestore();
    }
  });
});
