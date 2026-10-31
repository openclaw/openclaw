import { describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/config.js";
import type { DmScope } from "../config/types.base.js";
import { createChannelTestPluginBase } from "../test-utils/channel-plugins.js";
import { collectChannelSecurityFindingsCore } from "./audit-channel.js";
import { runSecurityAuditCore } from "./audit.js";
import type { SecurityAuditFinding } from "./audit.types.js";

const getFinding = (findings: SecurityAuditFinding[], checkId: string) =>
  findings.find((entry) => entry.checkId === checkId);
const openAccount = () => ({ policy: "open", allowFrom: ["*"] });
const mayShare = {
  title: expect.stringContaining("may share"),
  detail: expect.stringContaining("can resolve to the same session bucket"),
};

function collisionFindings(findings: SecurityAuditFinding[]): SecurityAuditFinding[] {
  return findings.filter((finding) => finding.checkId.includes(".dm.session_collision."));
}

type Accounts = Record<string, { policy?: string; allowFrom: Array<string | number> }>;
function createDmPlugin(
  accounts: Accounts = { default: { policy: "allowlist", allowFrom: ["user-a", "user-b"] } },
  dmRouting?: NonNullable<ChannelPlugin["security"]>["dmRouting"],
  id: "telegram" | "whatsapp" = "whatsapp",
) {
  const accountIds = Object.keys(accounts);
  const security: NonNullable<ChannelPlugin["security"]> = {
    resolveDmPolicy: ({ accountId }: { accountId?: string | null }) => {
      const resolvedAccountId = accountId ?? "default";
      const policy = accounts[resolvedAccountId];
      return policy
        ? {
            policy: policy.policy ?? "allowlist",
            allowFrom: policy.allowFrom,
            policyPath: `channels.${id}.accounts.${resolvedAccountId}.dmPolicy`,
            allowFromPath: `channels.${id}.accounts.${resolvedAccountId}.`,
            approveHint: `approve ${resolvedAccountId}`,
          }
        : null;
    },
    ...(dmRouting ? { dmRouting } : {}),
  };

  return {
    ...createChannelTestPluginBase({
      id,
      label: id === "telegram" ? "Telegram" : "WhatsApp",
      config: {
        listAccountIds: () => accountIds,
        defaultAccountId: () => accountIds[0] ?? "default",
        inspectAccount: (_cfg, accountId) => ({
          accountId: accountId ?? "default",
          enabled: true,
          configured: true,
        }),
      },
    }),
    security,
  } satisfies ChannelPlugin;
}

function dmBinding(id: string, dmScope: DmScope, accountId?: string) {
  return {
    agentId: "main",
    match: {
      channel: "whatsapp",
      peer: { kind: "direct" as const, id },
      ...(accountId ? { accountId } : {}),
    },
    session: { dmScope },
  };
}

describe("security audit channel dm policy", () => {
  it("reports unowned DM routes without losing sibling findings in audit mode", async () => {
    const findings = await collectChannelSecurityFindingsCore({
      mode: "audit",
      cfg: {
        agents: { entries: { main: {}, research: {} } },
        bindings: [{ agentId: "research", match: { channel: "whatsapp", accountId: "owned" } }],
      },
      plugins: [
        createDmPlugin({
          finite: { allowFrom: ["user-a", "user-b"] },
          open: openAccount(),
          owned: { allowFrom: ["user-c", "user-d"] },
        }),
      ],
    });

    for (const account of ["finite", "open"]) {
      expect(
        getFinding(findings, `channels.whatsapp.routing.owner_missing.${account}`),
      ).toMatchObject({
        severity: "warn",
        remediation: expect.stringContaining(`whatsapp:${account}`),
      });
    }
    expect(
      findings.filter((finding) => finding.checkId.includes(".routing.owner_missing.")),
    ).toHaveLength(2);
    expect(getFinding(findings, "channels.whatsapp.dm.open")?.severity).toBe("critical");
    expect(collisionFindings(findings)).toHaveLength(1);
    expect(collisionFindings(findings)[0]?.detail).toContain("owned");
  });

  it("keeps producer-owned channel severity through the audit summary", async () => {
    const checkId = "channels.whatsapp.test.open_access";
    const disabledAccounts = { default: { policy: "disabled", allowFrom: [] } };
    const plugin = createDmPlugin(disabledAccounts);
    plugin.security.collectWarnings = () => [
      {
        checkId,
        severity: "critical",
        title: "warning",
        detail: "open access",
      },
    ];

    const auditOptions = { config: {}, includeFilesystem: false } as const;
    const baseline = await runSecurityAuditCore({
      ...auditOptions,
      plugins: [createDmPlugin(disabledAccounts)],
    });
    const report = await runSecurityAuditCore({ ...auditOptions, plugins: [plugin] });

    expect(getFinding(report.findings, checkId)).toMatchObject({
      severity: "critical",
      detail: "open access",
    });
    expect(report.summary.critical).toBe(baseline.summary.critical + 1);
  });

  it.each([
    ...[true, false].map((linked) => ({
      name: linked ? "identity-linked aliases" : "distinct principals",
      cfg: {
        session: {
          dmScope: "main" as const,
          ...(linked ? { identityLinks: { alice: ["whatsapp:user-a", "whatsapp:user-b"] } } : {}),
        },
      },
      plugins: [createDmPlugin()],
      expected: linked ? [] : [{}],
    })),
    {
      name: "separate collision topologies",
      cfg: {
        agents: { entries: { alpha: {}, beta: {} } },
        session: { dmScope: "main" as const },
        bindings: ["a", "b", "c", "d"].map((accountId, index) => ({
          agentId: index < 2 ? "alpha" : "beta",
          match: { channel: "whatsapp", accountId },
        })),
      },
      plugins: [
        createDmPlugin({
          a: { allowFrom: ["user-a"] },
          b: { allowFrom: ["user-b"] },
          c: { allowFrom: ["user-c"] },
          d: { allowFrom: ["user-d"] },
        }),
      ],
      expected: [{}, {}],
    },
    {
      name: "per-channel wildcard intersects a concrete sender on the same channel",
      expected: [mayShare],
      cfg: { session: { dmScope: "per-channel-peer" as const } },
      plugins: [
        createDmPlugin(
          {
            open: openAccount(),
            finite: { allowFrom: ["user-b"] },
          },
          {
            resolveDmRoute: ({ principalId }) =>
              principalId === undefined ? { kind: "core" } : undefined,
          },
        ),
      ],
    },
    {
      name: "per-peer wildcard subsumes an overlapping per-channel wildcard",
      expected: [mayShare],
      cfg: {},
      plugins: (["whatsapp", "telegram"] as const).map((id) =>
        createDmPlugin(
          { open: openAccount() },
          {
            resolveDmScope: () => (id === "whatsapp" ? "per-peer" : "per-channel-peer"),
          },
          id,
        ),
      ),
    },
    {
      name: "finite probe bindings cannot hide an open-DM collision",
      expected: [{}],
      cfg: {
        session: { dmScope: "main" },
        bindings: [1, 2].map((n) =>
          dmBinding(`__openclaw_audit_unmatched_dm_${n}__`, "per-channel-peer"),
        ),
      } satisfies OpenClawConfig,
      plugins: [createDmPlugin({ default: openAccount() })],
    },
    {
      name: "exact DM bindings admitted by wildcard policy",
      expected: [
        {
          title: "DM principals share a session",
          detail: expect.stringContaining("2 distinct admitted DM principals"),
        },
      ],
      cfg: {
        session: { dmScope: "per-account-channel-peer" },
        bindings: [dmBinding("bound-a", "main", "*"), dmBinding("bound-b", "main", " WORK ")],
      } satisfies OpenClawConfig,
      plugins: [createDmPlugin({ work: openAccount() })],
    },
  ])("audits collision topology for $name", async ({ cfg, plugins, expected }) => {
    const findings = await collectChannelSecurityFindingsCore({ cfg, plugins });
    const collisions = collisionFindings(findings);
    expect(collisions).toEqual(expected.map((shape) => expect.objectContaining(shape)));
    if (expected.length > 1) {
      expect(new Set(collisions.map((finding) => finding.checkId)).size).toBe(2);
      expect(new Set(collisions.map((finding) => finding.detail)).size).toBe(2);
    }
  });

  it("warns when custom finite routing omits an unknown-principal policy", async () => {
    const findings = await collectChannelSecurityFindingsCore({
      cfg: { session: { dmScope: "main" } },
      plugins: [
        createDmPlugin(
          { default: openAccount() },
          {
            resolveDmRoute: ({ principalId, route }) =>
              principalId === undefined ? undefined : { sessionKey: route.sessionKey },
          },
        ),
      ],
    });

    const finding = getFinding(
      findings,
      "channels.whatsapp.dm.wildcard_routing_unverified.default",
    );
    expect(finding?.detail).toContain("resolveDmRoute returned no unknown-principal policy");
  });
});
