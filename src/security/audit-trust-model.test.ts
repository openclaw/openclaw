import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  collectExposureMatrixFindings,
  collectLikelyMultiUserSetupFindings,
} from "./audit-extra.sync.js";

function audit(cfg: OpenClawConfig) {
  return [...collectExposureMatrixFindings(cfg), ...collectLikelyMultiUserSetupFindings(cfg)];
}

describe("security audit trust model findings", () => {
  it("evaluates trust-model exposure findings", async () => {
    const cases = [
      {
        name: "flags open groupPolicy when tools.elevated is enabled",
        cfg: {
          tools: { elevated: { enabled: true, allowFrom: { whatsapp: ["+1"] } } },
          channels: { whatsapp: { groupPolicy: "open" } },
        } satisfies OpenClawConfig,
        assert: () => {
          const findings = audit(cases[0].cfg);
          expect(
            findings.some(
              (finding) =>
                finding.checkId === "security.exposure.open_groups_with_elevated" &&
                finding.severity === "critical",
            ),
          ).toBe(true);
        },
      },
      {
        name: "flags open groupPolicy when runtime/filesystem tools are exposed without guards",
        cfg: {
          channels: { whatsapp: { groupPolicy: "open" } },
          tools: { elevated: { enabled: false } },
        } satisfies OpenClawConfig,
        assert: () => {
          const findings = audit(cases[1].cfg);
          expect(
            findings.some(
              (finding) =>
                finding.checkId === "security.exposure.open_groups_with_runtime_or_fs" &&
                finding.severity === "critical",
            ),
          ).toBe(true);
        },
      },
      {
        name: "does not flag runtime/filesystem exposure for open groups when sandbox mode is all",
        cfg: {
          channels: { whatsapp: { groupPolicy: "open" } },
          tools: {
            elevated: { enabled: false },
            profile: "coding",
          },
          agents: {
            defaults: {
              sandbox: { mode: "all" },
            },
          },
        } satisfies OpenClawConfig,
        assert: () => {
          const findings = audit(cases[2].cfg);
          expect(
            findings.some(
              (finding) => finding.checkId === "security.exposure.open_groups_with_runtime_or_fs",
            ),
          ).toBe(false);
        },
      },
      {
        name: "does not flag runtime/filesystem exposure for open groups when runtime is denied and fs is workspace-only",
        cfg: {
          channels: { whatsapp: { groupPolicy: "open" } },
          tools: {
            elevated: { enabled: false },
            profile: "coding",
            deny: ["group:runtime"],
            fs: { workspaceOnly: true },
          },
        } satisfies OpenClawConfig,
        assert: () => {
          const findings = audit(cases[3].cfg);
          expect(
            findings.some(
              (finding) => finding.checkId === "security.exposure.open_groups_with_runtime_or_fs",
            ),
          ).toBe(false);
        },
      },
      {
        name: "warns when config combines a scoped allowlist with a broadening signal (open dmPolicy)",
        cfg: {
          channels: {
            discord: {
              groupPolicy: "allowlist",
              dmPolicy: "open",
              guilds: {
                "1234567890": {
                  channels: {
                    "7777777777": { enabled: true },
                  },
                },
              },
            },
          },
          tools: { elevated: { enabled: false } },
        } satisfies OpenClawConfig,
        assert: () => {
          const findings = audit(cases[4].cfg);
          const finding = findings.find(
            (entry) => entry.checkId === "security.trust_model.multi_user_heuristic",
          );
          expect(finding?.severity).toBe("warn");
          // Detail still surfaces the scoped allowlist signal alongside the broadening signal.
          expect(finding?.detail).toContain(
            'channels.discord.groupPolicy="allowlist" with configured group targets',
          );
          expect(finding?.detail).toContain('channels.discord.dmPolicy="open"');
          expect(finding?.detail).toContain("personal-assistant");
          expect(finding?.remediation).toContain('agents.defaults.sandbox.mode="all"');
        },
      },
      {
        name: "does not warn for multi-user heuristic when no shared-user signals are configured",
        cfg: {
          channels: {
            discord: {
              groupPolicy: "allowlist",
            },
          },
          tools: { elevated: { enabled: false } },
        } satisfies OpenClawConfig,
        assert: () => {
          const findings = audit(cases[5].cfg);
          expect(
            findings.some(
              (finding) => finding.checkId === "security.trust_model.multi_user_heuristic",
            ),
          ).toBe(false);
        },
      },
      {
        name: "does not fire on a single-operator allowlist-with-targets pattern (#26859)",
        cfg: {
          channels: {
            discord: {
              groupPolicy: "allowlist",
              guilds: {
                "1234567890": {
                  channels: {
                    "7777777777": { enabled: true },
                  },
                },
              },
            },
          },
          tools: { elevated: { enabled: false } },
        } satisfies OpenClawConfig,
        assert: () => {
          const findings = audit(cases[6].cfg);
          expect(
            findings.some(
              (finding) => finding.checkId === "security.trust_model.multi_user_heuristic",
            ),
          ).toBe(false);
        },
      },
      {
        name: "does not fire when a single operator runs multiple Discord agents with allowlist-with-targets each (#26859)",
        cfg: {
          channels: {
            discord: {
              accounts: {
                jarvis: {
                  groupPolicy: "allowlist",
                  guilds: {
                    "1111": { channels: { "2222": { enabled: true } } },
                  },
                },
                pepper: {
                  groupPolicy: "allowlist",
                  guilds: {
                    "1111": { channels: { "3333": { enabled: true } } },
                  },
                },
              },
            },
          },
          tools: { elevated: { enabled: false } },
        } satisfies OpenClawConfig,
        assert: () => {
          const findings = audit(cases[7].cfg);
          expect(
            findings.some(
              (finding) => finding.checkId === "security.trust_model.multi_user_heuristic",
            ),
          ).toBe(false);
        },
      },
      {
        name: "fires when a per-account allowFrom contains a wildcard",
        cfg: {
          channels: {
            discord: {
              accounts: {
                pepper: {
                  groupPolicy: "allowlist",
                  allowFrom: ["*"],
                },
              },
            },
          },
          tools: { elevated: { enabled: false } },
        } satisfies OpenClawConfig,
        assert: () => {
          const findings = audit(cases[8].cfg);
          const finding = findings.find(
            (entry) => entry.checkId === "security.trust_model.multi_user_heuristic",
          );
          expect(finding?.severity).toBe("warn");
          expect(finding?.detail).toContain(
            'channels.discord.accounts.pepper.allowFrom includes "*"',
          );
        },
      },
    ] as const;

    for (const testCase of cases) {
      testCase.assert();
    }
  });
});
