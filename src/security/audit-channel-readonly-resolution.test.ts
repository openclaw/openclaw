// Verifies readonly channel audit resolution behavior.
import { describe, expect, it } from "vitest";
import { stubAuditChannelPlugin } from "./audit-channel-test-helpers.js";
import { collectChannelSecurityFindingsCore } from "./audit-channel.js";

function stubChannelPlugin(message: string) {
  return stubAuditChannelPlugin({
    id: "zalouser",
    label: "Zalo Personal",
    commands: undefined,
    collectAuditFindings: undefined,
    inspectAccount: () => null,
    resolveAccount: () => {
      throw new Error(message);
    },
  });
}

describe("security audit channel read-only resolution", () => {
  it("reports both failed account checks in order without auditing the disabled account", async () => {
    const plugin = stubChannelPlugin("unused resolver");
    const checks: string[] = [];
    plugin.config.inspectAccount = () => ({});
    plugin.config.isEnabled = function () {
      expect(this).toBe(plugin.config);
      checks.push("enabled");
      throw new Error("enabled unavailable");
    };
    plugin.config.isConfigured = async function () {
      expect(this).toBe(plugin.config);
      checks.push("configured");
      await Promise.resolve();
      throw new Error("configured unavailable");
    };
    plugin.security = {
      collectWarnings: () => {
        throw new Error("disabled accounts must not be audited");
      },
    };

    const findings = await collectChannelSecurityFindingsCore({ cfg: {}, plugins: [plugin] });

    expect(checks).toEqual(["enabled", "configured"]);
    expect(findings.map((finding) => finding.detail)).toEqual([
      "zalouser:default: failed to evaluate enabled state (enabled unavailable).",
      "zalouser:default: failed to evaluate configured state (configured unavailable).",
    ]);
  });

  it("audits the DM policy of an asynchronously prepared account", async () => {
    const plugin = stubChannelPlugin("legacy account resolution");
    const account = { accountId: "default", enabled: true, configured: true };
    plugin.config.resolveAccountAsync = async () => account;
    plugin.security = {
      resolveDmPolicy: (context) => {
        expect(context.account).toBe(account);
        return {
          policy: "open",
          allowFrom: ["*"],
          policyPath: "channels.zalouser.dmPolicy",
          allowFromPath: "channels.zalouser.",
          approveHint: "approve",
        };
      },
    };

    const findings = await collectChannelSecurityFindingsCore({
      cfg: {},
      plugins: [plugin],
    });

    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: "channels.zalouser.dm.open",
        severity: "critical",
      }),
    );
    expect(findings.some((finding) => finding.checkId.endsWith("read_only_resolution"))).toBe(
      false,
    );
  });

  it("adds a read-only resolution warning when channel account resolveAccount throws", async () => {
    const findings = await collectChannelSecurityFindingsCore({
      cfg: { channels: { zalouser: { enabled: true } } },
      plugins: [stubChannelPlugin("missing SecretRef")],
    });
    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: "channels.zalouser.account.read_only_resolution",
        severity: "warn",
        title: expect.stringContaining("could not be fully resolved"),
        detail: expect.stringMatching(
          /zalouser:default: failed to resolve account.*missing SecretRef/,
        ),
      }),
    );
  });
});
