import { expectDefined } from "@openclaw/normalization-core/expect";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { collectAttackSurfaceSummaryFindings } from "./audit-extra.summary.js";

async function attackSurface(cfg: OpenClawConfig) {
  const findings = await collectAttackSurfaceSummaryFindings(cfg);
  const summary = findings.find((f) => f.checkId === "summary.attack_surface");
  expect(summary).toMatchObject({ checkId: "summary.attack_surface", severity: "info" });
  return expectDefined(summary, "summary");
}

describe("security audit attack surface summary", () => {
  it("warns for each agent opting its GitHub identity into sandboxed execution", async () => {
    const identity = { profileId: "ghp_0123456789abcdef0123456789abcdef" };
    const optedIn = { ...identity, allowInSandbox: true };
    const optedOut = { ...identity, allowInSandbox: false };
    const findings = (
      await collectAttackSurfaceSummaryFindings({
        agents: {
          ownership: "explicit",
          entries: {
            release: { tools: { github: optedIn } },
            maintenance: { tools: { github: optedIn } },
            disabled: { tools: { github: optedOut } },
            default: { tools: { github: identity } },
            unconfigured: {},
          },
        },
      })
    ).filter((finding) => finding.checkId === "sandbox.github_identity_exposed");
    expect(findings).toEqual(
      ["release", "maintenance"].map((agentId) =>
        expect.objectContaining({
          checkId: "sandbox.github_identity_exposed",
          severity: "warn",
          detail: expect.stringContaining(`agents.entries.${agentId}.tools.github.allowInSandbox`),
          remediation: expect.stringContaining(
            `agents.entries.${agentId}.tools.github.allowInSandbox`,
          ),
        }),
      ),
    );
    for (const finding of findings) {
      expect(finding.detail).toContain("sandboxed execution");
    }
  });

  it("includes an attack surface summary (info)", async () => {
    const summary = await attackSurface({
      channels: { whatsapp: { groupPolicy: "open" }, telegram: { groupPolicy: "allowlist" } },
      tools: { elevated: { enabled: true, allowFrom: { whatsapp: ["+1"] } } },
      hooks: { enabled: true },
      browser: { enabled: true },
    });

    expect(summary.detail).toBe(
      [
        "groups: open=1, allowlist=1",
        "direct messages: open=0",
        "tools.elevated: enabled",
        "hooks.webhooks: enabled",
        "hooks.internal: disabled",
        "browser control: enabled",
        "trust model: personal assistant (one trusted operator boundary), not hostile multi-tenant on one shared gateway. For mutually untrusted users or organizations, run separate Gateways with separate credentials, ideally under separate OS users or hosts: https://docs.openclaw.ai/gateway/security/trust-model",
      ].join("\n"),
    );
  });

  it.each<[string, OpenClawConfig["plugins"], boolean | undefined, string]>([
    ["allowlist wins", { allow: ["openai"] }, true, "disabled"],
    ["case-insensitive IDs", { allow: ["Browser"] }, undefined, "enabled"],
    ["case-normalized deny wins", { allow: ["browser"], deny: ["BROWSER"] }, true, "disabled"],
    [
      "disabled entry wins",
      { allow: ["browser"], entries: { browser: { enabled: false } } },
      true,
      "disabled",
    ],
    ["browser.enabled=false wins", { allow: ["browser"] }, false, "disabled"],
  ])(
    "reports browser control from effective plugin policy: %s",
    async (_name, plugins, enabled, expected) => {
      const summary = await attackSurface({
        plugins,
        browser: enabled === undefined ? undefined : { enabled },
      });
      expect(summary.detail).toContain(`browser control: ${expected}`);
    },
  );
});
