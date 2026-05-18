import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  collectExposureMatrixFindings,
  collectLikelyMultiUserSetupFindings,
} from "./audit-extra.sync.js";

function audit(cfg: OpenClawConfig) {
  return [...collectExposureMatrixFindings(cfg), ...collectLikelyMultiUserSetupFindings(cfg)];
}

function requireMultiUserHeuristicFinding(findings: ReturnType<typeof audit>) {
  const finding = findings.find(
    (entry) => entry.checkId === "security.trust_model.multi_user_heuristic",
  );
  if (!finding) {
    throw new Error("Expected multi-user heuristic finding");
  }
  return finding;
}

describe("security audit trust model findings", () => {
  it("evaluates trust-model exposure findings", () => {
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
        name: "warns when config heuristics suggest a likely multi-user setup",
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
          const findings = audit(cases[4].cfg);
          const finding = requireMultiUserHeuristicFinding(findings);
          expect(finding.severity).toBe("warn");
          expect(finding.detail).toContain(
            'channels.discord.groupPolicy="allowlist" with configured group targets',
          );
          expect(finding.detail).toContain("personal-assistant");
          expect(finding.remediation).toContain('agents.defaults.sandbox.mode="all"');
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
        name: "does not flag open group exposure when non-main sessions are sandboxed",
        cfg: {
          channels: { whatsapp: { groupPolicy: "open" } },
          tools: {
            elevated: { enabled: false },
            profile: "coding",
          },
          agents: {
            defaults: {
              sandbox: { mode: "non-main" },
            },
          },
        } satisfies OpenClawConfig,
        assert: () => {
          const findings = audit(cases[6].cfg);
          expect(
            findings.some(
              (finding) => finding.checkId === "security.exposure.open_groups_with_runtime_or_fs",
            ),
          ).toBe(false);
        },
      },
      {
        name: "does not warn when allowlisted WhatsApp groups run as non-main sandbox sessions",
        cfg: {
          channels: {
            whatsapp: {
              groupPolicy: "allowlist",
              groupAllowFrom: ["+15551234567"],
              groups: { "120363403215116621@g.us": { requireMention: true } },
            },
          },
          tools: {
            elevated: { enabled: false },
            profile: "coding",
          },
          agents: {
            defaults: {
              sandbox: { mode: "non-main" },
            },
          },
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
        name: "does not warn for unsandboxed main when the group route targets a sandboxed agent",
        cfg: {
          agents: {
            list: [
              {
                id: "main",
                default: true,
                sandbox: { mode: "off" },
                tools: { fs: { workspaceOnly: true } },
              },
              {
                id: "friends",
                sandbox: { mode: "all" },
              },
            ],
          },
          bindings: [
            {
              agentId: "friends",
              match: {
                channel: "whatsapp",
                peer: { kind: "group", id: "120363403215116621@g.us" },
              },
            },
          ],
          channels: {
            whatsapp: {
              groupPolicy: "allowlist",
              groupAllowFrom: ["+15551234567"],
              groups: { "120363403215116621@g.us": { requireMention: true } },
            },
          },
          tools: {
            elevated: { enabled: false },
            fs: { workspaceOnly: true },
          },
        } satisfies OpenClawConfig,
        assert: () => {
          const findings = audit(cases[8].cfg);
          expect(
            findings.some(
              (finding) => finding.checkId === "security.trust_model.multi_user_heuristic",
            ),
          ).toBe(false);
        },
      },
      {
        name: "warns for open direct DMs when only non-main sessions are sandboxed",
        cfg: {
          channels: { whatsapp: { dmPolicy: "open" } },
          tools: {
            elevated: { enabled: false },
            profile: "coding",
          },
          agents: {
            defaults: {
              sandbox: { mode: "non-main" },
            },
          },
        } satisfies OpenClawConfig,
        assert: () => {
          const findings = audit(cases[9].cfg);
          expect(
            findings.some(
              (finding) => finding.checkId === "security.trust_model.multi_user_heuristic",
            ),
          ).toBe(true);
        },
      },
      {
        name: "does not warn for open direct DMs when secure DM sessions are sandboxed",
        cfg: {
          session: { dmScope: "per-channel-peer" },
          channels: { whatsapp: { dmPolicy: "open" } },
          tools: {
            elevated: { enabled: false },
            profile: "coding",
          },
          agents: {
            defaults: {
              sandbox: { mode: "non-main" },
            },
          },
        } satisfies OpenClawConfig,
        assert: () => {
          const findings = audit(cases[10].cfg);
          expect(
            findings.some(
              (finding) => finding.checkId === "security.trust_model.multi_user_heuristic",
            ),
          ).toBe(false);
        },
      },
    ] as const;

    for (const testCase of cases) {
      testCase.assert();
    }
  });
});
