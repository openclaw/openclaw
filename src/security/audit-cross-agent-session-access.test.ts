import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { AgentConfig } from "../config/types.agents.js";
import { createCanonicalAgentConfigFixture } from "../test-utils/config-roster.js";
import { collectCrossAgentSessionAccessFindings } from "./audit-extra.summary.js";
import { collectSecurityAuditFindings } from "./audit.test-support.js";

const checkId = "security.trust_model.cross_agent_session_access_default";
const agents = { entries: { home: {}, work: {} } };
const sessionTools = [
  "sessions_list",
  "sessions_history",
  "sessions_search",
  "sessions_send",
  "session_status",
];
const reachable = (id: string) =>
  `- ${id}: unsandboxed sessions; allowed session tools: ${sessionTools.join(", ")}.`;
const removed = (id: string) =>
  `- ${id}: session tools removed by agent tool policy; its transcripts remain readable by the agents above.`;
const roster = (entries: Record<string, AgentConfig>): OpenClawConfig => ({
  agents: { entries },
});
const withWork = (work: AgentConfig) => roster({ home: {}, work });
const withTools = (tools: OpenClawConfig["tools"]): OpenClawConfig => ({ agents, tools });
const sandboxed = (sandbox: AgentConfig["sandbox"]): OpenClawConfig => ({
  agents: { ...agents, defaults: { sandbox } },
});
function expectFragments(text: string | undefined, fragments: string[]) {
  for (const fragment of fragments) {
    expect(text).toContain(fragment);
  }
}
function expectFinding(cfg: OpenClawConfig, severity: "info" | "warn") {
  const findings = collectCrossAgentSessionAccessFindings(cfg);
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({ checkId, severity });
  return findings[0]!;
}

describe("security audit cross-agent session access", () => {
  it.each<OpenClawConfig>([
    {},
    roster({ home: {} }),
    ...(["agent", "tree", "self"] as const).map((visibility) =>
      withTools({ sessions: { visibility } }),
    ),
    withTools({ agentToAgent: { enabled: false } }),
    ...[["home", "work"], [" "]].map((allow) => withTools({ agentToAgent: { allow } })),
    sandboxed({ mode: "all" }),
    roster({
      home: { tools: { deny: sessionTools } },
      work: { tools: { deny: sessionTools } },
    }),
  ])("does not flag restricted config %j", (cfg) => {
    expect(collectCrossAgentSessionAccessFindings(cfg)).toEqual([]);
  });

  it.each<OpenClawConfig>([
    { agents },
    createCanonicalAgentConfigFixture({ agents: { list: [{ id: "home" }, { id: "work" }] } })
      .config,
    withTools({ sessions: { visibility: "all" }, agentToAgent: { enabled: true, allow: [] } }),
    { agents, tools: { sessions: { visibility: "invalid" } } } as unknown as OpenClawConfig,
  ])("reports one informational finding for config %#", (cfg) => {
    const finding = expectFinding(cfg, "info");
    expect(finding.title).toBe("Agents share Gateway-wide session access (default)");
    expectFragments(finding.detail, [
      "Agents: home, work",
      'tools.sessions.visibility resolves to "all"',
      "tools.agentToAgent",
      "Agents that can reach other agents' sessions, including other users' transcripts:",
      ...["home", "work"].map(reachable),
      "Incognito sessions remain hidden.",
    ]);
    expectFragments(finding.remediation, [
      "tools.sessions.visibility",
      '"agent", "tree", or "self"',
      "tools.agentToAgent.allow",
      "requester and target ids",
      "tools.agentToAgent.enabled: false",
      "https://docs.openclaw.ai/gateway/config-tools#tools-agenttoagent",
      "https://docs.openclaw.ai/gateway/security#scope-one-trust-boundary-per-gateway",
    ]);
  });

  it.each<[string, OpenClawConfig, string[], string?]>([
    ...[
      { tools: { deny: ["exec"] }, signal: "tools.deny" },
      { tools: { allow: [] }, signal: "tools.allow" },
      { tools: { profile: "messaging" as const }, signal: "tools.profile" },
    ].map(({ tools, signal }): [string, OpenClawConfig, string[]] => [
      `agent-level ${signal}`,
      withWork({ tools }),
      ["different trust levels", `work: agent-level tool restrictions (${signal})`],
    ]),
    [
      "multi-user ingress",
      { agents, channels: { slack: { dmPolicy: "open" } } },
      ["different trust levels", 'channels.slack.dmPolicy="open"'],
    ],
    [
      "combined boundaries",
      {
        ...withWork({ sandbox: { mode: "all" }, tools: { deny: ["exec"] } }),
        channels: { slack: { dmPolicy: "open" } },
      },
      [
        "different trust levels",
        'work: sandbox.mode="all"',
        "work: agent-level tool restrictions (tools.deny)",
        'channels.slack.dmPolicy="open"',
      ],
    ],
    [
      "default sandbox clamp",
      withWork({ sandbox: { mode: "all" } }),
      [
        `${reachable("home")}\n` +
          "- work: sandboxed sessions clamped to their spawn tree; its transcripts remain readable by the agents above.",
        'work: sandbox.mode="all"',
        "different trust levels",
      ],
    ],
    [
      "non-main sandbox",
      sandboxed({ mode: "non-main" }),
      [
        "- home: unsandboxed main session;",
        "- work: unsandboxed main session;",
        'home: sandbox.mode="non-main"',
        'work: sandbox.mode="non-main"',
        "different trust levels",
      ],
    ],
    [
      "sandbox clamp disabled",
      sandboxed({ mode: "all", sessionToolsVisibility: "all" }),
      [
        "- home: sandboxed sessions (clamp disabled); allowed session tools:",
        "- work: sandboxed sessions (clamp disabled); allowed session tools:",
      ],
      "unsandboxed",
    ],
    [
      "session tools denied",
      withWork({ tools: { deny: sessionTools } }),
      [`${reachable("home")}\n${removed("work")}`],
      "- work: unsandboxed",
    ],
    [
      "session status only",
      withWork({ tools: { profile: "minimal" } }),
      [
        `${reachable("home")}\n` +
          "- work: unsandboxed sessions; allowed session tools: session_status.\n",
      ],
    ],
    [
      "non-reaching agent first",
      roster({ home: { tools: { deny: sessionTools } }, work: {} }),
      ["Agents: home, work", `${reachable("work")}\n${removed("home")}`],
    ],
  ])("renders session reach for %s", (_name, cfg, detail, absent) => {
    const finding = expectFinding(cfg, "warn");
    expectFragments(finding.detail, detail);
    if (absent) {
      expect(finding.detail).not.toContain(absent);
    }
  });

  it("registers the finding in the non-deep config audit", async () => {
    const findings = await collectSecurityAuditFindings({ agents });
    expect(findings.filter((finding) => finding.checkId === checkId)).toEqual([
      expect.objectContaining({ severity: "info" }),
    ]);
  });
});
