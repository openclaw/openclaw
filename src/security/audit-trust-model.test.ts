// Verifies trust-model audit findings and severity mapping.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  collectExposureMatrixFindings,
  collectLikelyMultiUserSetupFindings,
} from "./audit-extra.sync.js";

function audit(cfg: OpenClawConfig) {
  return [...collectExposureMatrixFindings(cfg), ...collectLikelyMultiUserSetupFindings(cfg)];
}

function findFinding(findings: ReturnType<typeof audit>, checkId: string) {
  return findings.find((entry) => entry.checkId === checkId);
}

function requireFinding(findings: ReturnType<typeof audit>, checkId: string) {
  const result = findFinding(findings, checkId);
  if (!result) {
    throw new Error(`Expected ${checkId} finding`);
  }
  return result;
}

const exposure = "security.exposure.open_groups_with_";
const multiUser = "security.trust_model.multi_user_heuristic";
const groupScope = "security.trust_model.group_scope_main";

function openGroup(
  tools: OpenClawConfig["tools"] = {},
  agents?: OpenClawConfig["agents"],
): OpenClawConfig {
  return {
    channels: { whatsapp: { groupPolicy: "open" } },
    tools: { elevated: { enabled: false }, ...tools },
    ...(agents ? { agents } : {}),
  };
}

function roomBinding(
  agentId: string,
  scope: "main" | "per-group",
  kind?: "group" | "channel",
): NonNullable<OpenClawConfig["bindings"]>[number] {
  return {
    agentId,
    match: {
      channel: "discord",
      accountId: "work",
      ...(kind ? { peer: { kind, id: "room-1" } } : {}),
    },
    session: { groupScope: scope },
  };
}

type AuditCase = {
  name: string;
  cfg: OpenClawConfig;
  present?: { checkId: string; severity: string };
  absent?: string[];
  checkId?: string;
  match?: { severity?: string; title?: string };
  detail?: string[];
  notDetail?: string[];
  remediation?: string[];
  notRemediation?: string[];
  assert?: (findings: ReturnType<typeof audit>) => void;
};

describe("security audit trust model findings", () => {
  it.each([
    { name: "inherited", groupPolicy: undefined, expected: true },
    { name: "explicitly disabled", groupPolicy: "disabled", expected: false },
  ] as const)("audits account group targets with $name policy", ({ groupPolicy, expected }) => {
    const findings = collectLikelyMultiUserSetupFindings({
      channels: {
        discord: {
          groupPolicy: "allowlist",
          accounts: {
            work: { ...(groupPolicy ? { groupPolicy } : {}), guilds: { "1234567890": {} } },
          },
        },
      },
    });
    const finding = findFinding(findings, multiUser);
    expect(Boolean(finding)).toBe(expected);
    if (expected) {
      expect(finding?.detail).toContain(
        'channels.discord.accounts.work.groupPolicy="allowlist" with configured group targets',
      );
    }
  });

  it("evaluates trust-model exposure findings", () => {
    const cases: AuditCase[] = [
      {
        name: "flags open groupPolicy when tools.elevated is enabled",
        cfg: {
          tools: { elevated: { enabled: true, allowFrom: { whatsapp: ["+1"] } } },
          channels: { whatsapp: { groupPolicy: "open" } },
        } satisfies OpenClawConfig,
        present: { checkId: exposure + "elevated", severity: "critical" },
      },
      {
        name: "flags open groupPolicy when runtime/filesystem tools are exposed without guards",
        cfg: openGroup(),
        present: { checkId: exposure + "runtime_or_fs", severity: "critical" },
      },
      {
        name: "does not flag runtime/filesystem exposure for open groups when sandbox mode is all",
        cfg: openGroup({ profile: "coding" }, { defaults: { sandbox: { mode: "all" } } }),
        absent: [exposure + "runtime_or_fs"],
      },
      {
        name: "does not flag runtime/filesystem exposure for open groups when runtime is denied and fs is workspace-only",
        cfg: openGroup({ profile: "coding", deny: ["group:runtime"], fs: { workspaceOnly: true } }),
        absent: [exposure + "runtime_or_fs"],
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
        checkId: multiUser,
        match: { severity: "warn" },
        detail: [
          'channels.discord.groupPolicy="allowlist" with configured group targets',
          "personal-assistant",
          "https://docs.openclaw.ai/gateway/security/trust-model",
        ],
        remediation: ['agents.defaults.sandbox.mode="all"'],
      },
      {
        name: "does not warn for multi-user heuristic when no shared-user signals are configured",
        cfg: {
          channels: {
            discord: { groupPolicy: "allowlist" },
          },
          tools: { elevated: { enabled: false } },
        } satisfies OpenClawConfig,
        absent: [multiUser, groupScope],
      },
      {
        name: "warns when global group scope shares all rooms with the main session",
        cfg: {
          session: { groupScope: "main" },
        } satisfies OpenClawConfig,
        checkId: groupScope,
        match: { severity: "warn", title: "Group rooms share the main session" },
        detail: ['session.groupScope="main"', "all group/channel rooms"],
        remediation: ["https://docs.openclaw.ai/channels/groups#session-keys"],
      },
      {
        name: "warns with the matched room for binding group scope",
        cfg: {
          session: { groupScope: "per-group" },
          bindings: [
            {
              agentId: "support",
              match: {
                channel: "discord",
                accountId: "work",
                peer: { kind: "channel", id: "1234567890" },
                guildId: "9876543210",
                roles: ["operators", "reviewers"],
              },
              session: { groupScope: "main" },
            },
          ],
        } satisfies OpenClawConfig,
        checkId: groupScope,
        match: { severity: "warn" },
        detail: [
          "discord accountId=work peer=channel:1234567890 guild=9876543210 roles=operators,reviewers",
        ],
        notDetail: ["all group/channel rooms"],
      },
      {
        name: "does not warn for a direct-only binding group scope",
        cfg: {
          bindings: [
            {
              agentId: "support",
              match: {
                channel: "whatsapp",
                peer: { kind: "direct", id: "user-a" },
              },
              session: { groupScope: "main" },
            },
          ],
        } satisfies OpenClawConfig,
        absent: [groupScope],
      },
      {
        name: "does not warn for a main-scoped room binding shadowed by an earlier equivalent binding",
        cfg: {
          bindings: [
            roomBinding("isolated", "per-group", "group"),
            roomBinding("shared", "main", "channel"),
          ],
        } satisfies OpenClawConfig,
        absent: [groupScope],
      },
      {
        name: "warns when a main-scoped room binding precedes an equivalent binding",
        cfg: {
          bindings: [
            roomBinding("shared", "main", "channel"),
            roomBinding("isolated", "per-group", "group"),
          ],
        } satisfies OpenClawConfig,
        checkId: groupScope,
        detail: ["discord accountId=work peer=channel:room-1"],
      },
      {
        name: "warns for a more-specific main-scoped room binding after a broader binding",
        cfg: {
          bindings: [roomBinding("isolated", "per-group"), roomBinding("shared", "main", "group")],
        } satisfies OpenClawConfig,
        checkId: groupScope,
        detail: ["discord accountId=work peer=group:room-1"],
      },
      {
        name: "flags open dmPolicy when tools.elevated is enabled",
        cfg: {
          tools: { elevated: { enabled: true, allowFrom: { feishu: ["ou_123"] } } },
          channels: { feishu: { groupPolicy: "disabled", dmPolicy: "open" } },
        } satisfies OpenClawConfig,
        checkId: exposure + "elevated",
        match: { severity: "critical" },
        detail: ["channels.feishu.dmPolicy"],
      },
      {
        name: "flags open dmPolicy when runtime/filesystem tools are exposed without guards",
        cfg: {
          channels: { feishu: { groupPolicy: "disabled", dmPolicy: "open" } },
          tools: { elevated: { enabled: false }, profile: "coding" },
        } satisfies OpenClawConfig,
        checkId: exposure + "runtime_or_fs",
        match: { severity: "critical" },
        detail: ["channels.feishu.dmPolicy"],
      },
      {
        name: "flags account-level open dmPolicy",
        cfg: {
          channels: {
            discord: {
              dmPolicy: "allowlist",
              accounts: { work: { dmPolicy: "open" } },
            },
          },
        } satisfies OpenClawConfig,
        checkId: exposure + "elevated",
        detail: ["channels.discord.accounts.work.dmPolicy"],
        notDetail: ["channels.discord.dmPolicy"],
      },
      {
        name: "flags supported legacy open dm.policy",
        cfg: {
          channels: { discord: { dm: { policy: "open" } } },
        } as unknown as OpenClawConfig,
        checkId: exposure + "elevated",
        detail: ["channels.discord.dm.policy"],
      },
      {
        name: "preserves the detected nested-only DM policy path in remediation",
        cfg: {
          channels: { matrix: { dm: { policy: "open" } } },
        } satisfies OpenClawConfig,
        checkId: exposure + "elevated",
        detail: ["channels.matrix.dm.policy"],
        remediation: ["each listed group/DM policy"],
        notRemediation: ["dmPolicy"],
      },
      {
        name: "prefers canonical dmPolicy over conflicting legacy dm.policy",
        cfg: {
          channels: {
            discord: {
              dmPolicy: "allowlist",
              dm: { policy: "open" },
            },
          },
        } as unknown as OpenClawConfig,
        assert: (findings: ReturnType<typeof audit>) => {
          expect(
            findings.some((finding) =>
              finding.checkId.startsWith("security.exposure.open_groups_"),
            ),
          ).toBe(false);
        },
      },
      {
        name: "flags open groupPolicy when coding exposes update, automation, and plugin tools",
        cfg: openGroup({ profile: "coding" }),
        checkId: exposure + "control_plane_tools",
        match: { severity: "critical" },
        detail: ["channels.whatsapp.groupPolicy", "controlPlane=[automations, gateway, plugins]"],
        remediation: ["`plugins`"],
      },
      {
        name: "flags open dmPolicy when gateway is explicitly allowed",
        cfg: {
          channels: { slack: { dmPolicy: "open" } },
          tools: { elevated: { enabled: false }, allow: ["gateway"] },
        } satisfies OpenClawConfig,
        checkId: exposure + "control_plane_tools",
        match: { severity: "critical" },
        detail: ["channels.slack.dmPolicy", "controlPlane=[gateway]"],
      },
      {
        name: "flags global alsoAllow that widens a restrictive profile",
        cfg: {
          channels: { slack: { dmPolicy: "open" } },
          tools: {
            elevated: { enabled: false },
            profile: "messaging",
            alsoAllow: ["cron"],
          },
        } satisfies OpenClawConfig,
        checkId: exposure + "control_plane_tools",
        detail: ["agents.defaults (profile=messaging; controlPlane=[automations, gateway])"],
      },
      {
        name: "reports default and per-agent control-plane exposure",
        cfg: openGroup(
          { profile: "messaging" },
          { entries: { ops: { tools: { profile: "messaging", alsoAllow: ["gateway"] } } } },
        ),
        checkId: exposure + "control_plane_tools",
        detail: [
          "agents.entries.ops (profile=messaging; controlPlane=[gateway])",
          "agents.defaults (profile=messaging; controlPlane=[gateway])",
        ],
      },
      {
        name: "does not flag control-plane exposure when gateway, cron, and plugins are denied",
        cfg: openGroup({ profile: "coding", deny: ["gateway", "cron", "plugins"] }),
        absent: [exposure + "control_plane_tools"],
      },
      {
        name: "does not classify other owner-only tools as control-plane exposure",
        cfg: openGroup({ allow: ["nodes", "computer"] }),
        absent: [exposure + "control_plane_tools"],
      },
      {
        name: "does not flag control-plane exposure when inbound policy is not open",
        cfg: {
          channels: { whatsapp: { groupPolicy: "allowlist" } },
          tools: { elevated: { enabled: false }, profile: "coding" },
        } satisfies OpenClawConfig,
        absent: [exposure + "control_plane_tools"],
      },
    ];

    for (const testCase of cases) {
      const findings = audit(testCase.cfg);
      if (testCase.present) {
        expect(findings).toContainEqual(expect.objectContaining(testCase.present));
      }
      for (const checkId of testCase.absent ?? []) {
        expect(findFinding(findings, checkId)).toBeUndefined();
      }
      if (testCase.checkId) {
        const finding = requireFinding(findings, testCase.checkId);
        if (testCase.match) {
          expect(finding).toMatchObject(testCase.match);
        }
        for (const [value, includes, excludes] of [
          [finding.detail, testCase.detail, testCase.notDetail],
          [finding.remediation, testCase.remediation, testCase.notRemediation],
        ] as const) {
          for (const text of includes ?? []) {
            expect(value).toContain(text);
          }
          for (const text of excludes ?? []) {
            expect(value).not.toContain(text);
          }
        }
      }
      testCase.assert?.(findings);
    }
  });
});
