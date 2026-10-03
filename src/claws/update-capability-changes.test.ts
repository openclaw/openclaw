import { describe, expect, it } from "vitest";
import { materializeClawToolProfile } from "./tool-profile-consent.js";
import {
  pushResolvedAgentCapabilityChanges,
  resourceCapabilityChange,
} from "./update-capability-changes.js";

type Changes = Parameters<typeof pushResolvedAgentCapabilityChanges>[0]["changes"];

describe.each(["mcpServer", "cronJob"] as const)("resourceCapabilityChange (%s)", (kind) => {
  it("treats a blocked removal without a desired value as a reduction", () => {
    const action = "manual";
    const change = resourceCapabilityChange({ kind, id: "resource", action, current: null });
    expect(change).toMatchObject({
      kind,
      id: "resource",
      path: `${kind === "mcpServer" ? "mcpServers" : "cronJobs"}.resource`,
      action,
      classification: "reduction",
      requiresDistinctConsent: false,
      effect: { removed: true },
      current: { summary: "not configured" },
    });
    expect(change).not.toHaveProperty("desired");
  });

  it("keeps absent values omitted and treats explicit null as present", () => {
    const params = { kind, id: "resource", action: "change" as const };
    const missing = resourceCapabilityChange(params);
    expect(missing).not.toHaveProperty("current");
    expect(missing).not.toHaveProperty("desired");
    expect(resourceCapabilityChange({ ...params, current: undefined, desired: undefined })).toEqual(
      missing,
    );

    const present = resourceCapabilityChange({ ...params, desired: null });
    expect(present).toMatchObject({
      classification: "escalation",
      requiresDistinctConsent: true,
      effect: { configured: false },
      desired: { summary: "not configured" },
    });
    expect(present).not.toHaveProperty("current");
  });

  it("ignores unchanged resources before reading their values", () => {
    expect(
      resourceCapabilityChange({
        kind,
        id: "resource",
        action: "unchanged",
        get current() {
          throw new Error("unchanged current value must not be read");
        },
        get desired() {
          throw new Error("unchanged desired value must not be read");
        },
      }),
    ).toBeUndefined();
  });
});

function collectChanges(params: {
  currentAgent: Parameters<typeof pushResolvedAgentCapabilityChanges>[0]["desiredAgent"];
  desiredAgent: Parameters<typeof pushResolvedAgentCapabilityChanges>[0]["desiredAgent"];
  defaults?: NonNullable<
    Parameters<typeof pushResolvedAgentCapabilityChanges>[0]["config"]["agents"]
  >["defaults"];
  tools?: Parameters<typeof pushResolvedAgentCapabilityChanges>[0]["config"]["tools"];
  memory?: Parameters<typeof pushResolvedAgentCapabilityChanges>[0]["config"]["memory"];
}): Changes {
  const changes: Changes = [];
  pushResolvedAgentCapabilityChanges({
    changes,
    agentId: params.currentAgent.id,
    config: {
      tools: params.tools,
      memory: params.memory,
      agents: {
        defaults: params.defaults,
        list: [params.currentAgent],
      },
    },
    desiredAgent: params.desiredAgent,
  });
  return changes;
}

describe("pushResolvedAgentCapabilityChanges", () => {
  type Agent = Parameters<typeof collectChanges>[0]["currentAgent"];
  type Classification = Changes[number]["classification"];
  type Expected = [path: string, classification: Classification, details?: Record<string, unknown>];
  type Case = Parameters<typeof collectChanges>[0] & {
    name: string;
    expected: Expected[];
    absent?: string[];
  };
  const agent = (settings: Omit<Agent, "id"> = {}): Agent => ({ id: "worker", ...settings });
  const cases: Case[] = [
    {
      name: "effective sandbox and heartbeat changes",
      currentAgent: agent({ sandbox: { mode: "all" }, heartbeat: { every: "1h" } }),
      desiredAgent: agent({ sandbox: { mode: "off" }, heartbeat: { every: "5m" } }),
      expected: [
        ["sandbox.mode", "escalation"],
        ["heartbeat.every", "escalation"],
      ],
    },
    {
      name: "inherited sandbox and heartbeat changes",
      currentAgent: agent({ sandbox: { mode: "all" }, heartbeat: { every: "1h" } }),
      desiredAgent: agent(),
      defaults: { sandbox: { mode: "off" }, heartbeat: { every: "5m" } },
      expected: [
        ["sandbox.mode", "escalation", { desired: expect.objectContaining({ summary: "off" }) }],
        [
          "heartbeat.every",
          "escalation",
          {
            current: expect.objectContaining({ summary: "1h" }),
            desired: expect.objectContaining({ summary: "5m" }),
          },
        ],
      ],
    },
    {
      name: "implicit heartbeat interval",
      currentAgent: { id: "main", heartbeat: { every: "1h" } },
      desiredAgent: { id: "main" },
      expected: [
        [
          "heartbeat.every",
          "escalation",
          {
            current: expect.objectContaining({ summary: "1h" }),
            desired: expect.objectContaining({ summary: "30m" }),
          },
        ],
      ],
    },
    {
      name: "heartbeat activity reductions",
      currentAgent: agent({
        heartbeat: { every: "5m", isolatedSession: false, timeoutSeconds: 60 },
      }),
      desiredAgent: agent({
        heartbeat: { every: "1h", isolatedSession: true, timeoutSeconds: 30 },
      }),
      expected: [
        ["heartbeat.every", "reduction"],
        ["heartbeat.isolatedSession", "reduction"],
        ["heartbeat.timeoutSeconds", "reduction"],
      ],
    },
    {
      name: "disabled heartbeat",
      currentAgent: agent({ heartbeat: { every: "5m" } }),
      desiredAgent: agent({ heartbeat: { every: "0m" } }),
      expected: [["heartbeat.every", "reduction"]],
    },
    {
      name: "narrower sandbox mode and sharing scope",
      currentAgent: agent({ sandbox: { mode: "off", scope: "shared" } }),
      desiredAgent: agent({ sandbox: { mode: "all", scope: "session" } }),
      expected: [
        ["sandbox.mode", "reduction"],
        ["sandbox.scope", "reduction"],
      ],
    },
    {
      name: "wider sandbox sharing scope",
      currentAgent: agent({ sandbox: { scope: "session" } }),
      desiredAgent: agent({ sandbox: { scope: "shared" } }),
      expected: [["sandbox.scope", "escalation"]],
    },
    {
      name: "substituted tool restrictions",
      currentAgent: agent({ tools: { deny: ["exec"] } }),
      desiredAgent: agent({ tools: { deny: ["read", "write"] } }),
      expected: [["tools.deny", "escalation"]],
    },
    ...(["allow", "deny"] as const).flatMap((field): Case[] => [
      {
        name: `added tools.${field} restriction`,
        currentAgent: agent(),
        desiredAgent: agent({ tools: { [field]: ["exec"] } }),
        expected: [[`tools.${field}`, "reduction"]],
      },
      {
        name: `removed tools.${field} restriction`,
        currentAgent: agent({ tools: { [field]: ["exec"] } }),
        desiredAgent: agent(),
        expected: [[`tools.${field}`, "escalation"]],
      },
    ]),
    ...([true, false] as const).map((added): Case => ({
      name: `${added ? "added" : "removed"} additive tool grant`,
      currentAgent: agent({
        tools: { profile: "coding", ...(added ? {} : { alsoAllow: ["browser"] }) },
      }),
      desiredAgent: agent({
        tools: { profile: "coding", ...(added ? { alsoAllow: ["browser"] } : {}) },
      }),
      expected: [["tools.alsoAllow", added ? "escalation" : "reduction"]],
      absent: ["agent.tools.profile"],
    })),
    {
      name: "growth in a frozen allowlist",
      currentAgent: agent({ tools: { allow: ["read", "write"] } }),
      desiredAgent: agent({ tools: { allow: ["read", "write", "apply_patch"] } }),
      expected: [["tools.allow", "escalation"]],
    },
    {
      name: "freezing an inherited additive tool grant",
      currentAgent: agent({ tools: { profile: "minimal" } }),
      desiredAgent: agent({
        tools: materializeClawToolProfile({ tools: { profile: "minimal" } }).tools,
      }),
      tools: { alsoAllow: ["browser"] },
      expected: [["tools.allow", "reduction"]],
    },
    {
      name: "inherited profile expansion",
      currentAgent: agent(),
      desiredAgent: agent({ tools: { profile: "coding" } }),
      tools: { profile: "minimal" },
      expected: [["tools.profile", "escalation"]],
    },
    {
      name: "wildcard profile reduction",
      currentAgent: agent({ tools: { profile: "full" } }),
      desiredAgent: agent({ tools: { profile: "coding" } }),
      expected: [["tools.profile", "reduction"]],
    },
    {
      name: "removal of workspace-only confinement",
      currentAgent: agent({ tools: { fs: { workspaceOnly: true } } }),
      desiredAgent: agent(),
      tools: { fs: { workspaceOnly: false } },
      expected: [["tools.fs.workspaceOnly", "escalation"]],
    },
    {
      name: "built-in profile and portable policy changes",
      currentAgent: agent({
        tools: { profile: "coding", fs: { workspaceOnly: false } },
        memory: {
          search: { enabled: false, rememberAcrossConversations: false, sources: ["memory"] },
        },
      }),
      desiredAgent: agent({
        tools: { profile: "full", alsoAllow: ["cron"], fs: { workspaceOnly: true } },
        memory: {
          search: {
            enabled: true,
            rememberAcrossConversations: true,
            sources: ["memory", "sessions"],
          },
        },
      }),
      expected: [
        [
          "tools.profile",
          "escalation",
          {
            effect: expect.objectContaining({
              current: "coding",
              desired: "full",
              currentCapabilities: expect.arrayContaining(["read", "write"]),
              desiredCapabilities: expect.arrayContaining(["*"]),
            }),
          },
        ],
        ["tools.fs.workspaceOnly", "reduction"],
        ["memory.search.enabled", "escalation"],
        ["memory.search.rememberAcrossConversations", "escalation"],
        ["memory.search.sources", "escalation"],
      ],
    },
    {
      name: "inherited memory defaults",
      currentAgent: agent({ memory: { search: { enabled: false } } }),
      desiredAgent: agent(),
      expected: [
        [
          "memory.search.enabled",
          "escalation",
          {
            current: expect.objectContaining({ summary: "false" }),
            desired: expect.objectContaining({ summary: "true" }),
          },
        ],
      ],
    },
    {
      name: "contextual cross-conversation recall defaults",
      currentAgent: agent({ memory: { search: { rememberAcrossConversations: false } } }),
      desiredAgent: agent(),
      expected: [
        ["memory.search.rememberAcrossConversations", "escalation"],
        ["memory.search.sources", "escalation"],
      ],
    },
  ];

  it.each(cases)("classifies $name", ({ expected, absent = [], ...input }) => {
    const changes = collectChanges(input);
    expect(changes).toEqual(
      expect.arrayContaining(
        expected.map(([path, classification, details]) =>
          expect.objectContaining({
            path: `agent.${path}`,
            classification,
            requiresDistinctConsent: classification === "escalation",
            ...details,
          }),
        ),
      ),
    );
    for (const path of absent) {
      expect(changes).not.toContainEqual(expect.objectContaining({ path }));
    }
  });

  const unchangedCases: Array<{
    name: string;
    prefix: string;
    config: Parameters<typeof pushResolvedAgentCapabilityChanges>[0]["config"];
    desiredAgent: Agent;
  }> = [
    {
      name: "implicit default-agent heartbeat",
      prefix: "agent.heartbeat.",
      config: { agents: { list: [{ id: "worker" }, { id: "other" }] } },
      desiredAgent: agent(),
    },
    {
      name: "inherited memory search",
      prefix: "agent.memory.search.",
      config: {
        agents: { list: [agent()] },
        memory: {
          search: {
            enabled: true,
            rememberAcrossConversations: true,
            sources: ["memory", "sessions"],
          },
        },
      },
      desiredAgent: agent(),
    },
    {
      name: "one-time profile freeze",
      prefix: "agent.tools.",
      config: {
        agents: {
          list: [agent({ tools: { profile: "minimal", alsoAllow: ["cron"], deny: ["exec"] } })],
        },
      },
      desiredAgent: agent({
        tools: materializeClawToolProfile({
          tools: { profile: "minimal", alsoAllow: ["cron"], deny: ["exec"] },
        }).tools,
      }),
    },
  ];
  it.each(unchangedCases)(
    "preserves $name without capability changes",
    ({ config, desiredAgent, prefix }) => {
      const changes: Changes = [];
      pushResolvedAgentCapabilityChanges({ changes, agentId: "worker", config, desiredAgent });
      expect(changes.filter((change) => change.path.startsWith(prefix))).toEqual([]);
    },
  );

  it.each([
    {
      name: "allow policy",
      desiredAgent: agent({ tools: { allow: ["exec"] } }),
      defaults: {},
      paths: ["tools.allow"],
    },
    {
      name: "deny policy",
      desiredAgent: agent({ tools: { deny: ["exec"] } }),
      defaults: {},
      paths: ["tools.deny"],
    },
    {
      name: "inherited capabilities",
      desiredAgent: agent(),
      defaults: { sandbox: { mode: "all" as const }, heartbeat: { every: "1h" } },
      paths: ["sandbox.mode", "heartbeat.every"],
    },
  ])(
    "treats $name on a restored missing agent as escalations",
    ({ desiredAgent, defaults, paths }) => {
      const changes: Changes = [];
      pushResolvedAgentCapabilityChanges({
        changes,
        agentId: "worker",
        config: { agents: { defaults, list: [] } },
        desiredAgent,
      });
      expect(changes).toEqual(
        expect.arrayContaining(
          paths.map((path) =>
            expect.objectContaining({
              path: `agent.${path}`,
              classification: "escalation",
              requiresDistinctConsent: true,
            }),
          ),
        ),
      );
    },
  );

  it("does not derive redacted capability digests from private details or payloads", () => {
    const firstMcp = resourceCapabilityChange({
      kind: "mcpServer",
      id: "search",
      action: "change",
      desired: { url: "https://first.example", auth: { scheme: "first" } },
    });
    const secondMcp = resourceCapabilityChange({
      kind: "mcpServer",
      id: "search",
      action: "change",
      desired: { url: "https://second.example", auth: { scheme: "second" } },
    });
    expect(firstMcp?.desired?.summary).toBe(secondMcp?.desired?.summary);
    expect(firstMcp?.desired?.digest).not.toBe(secondMcp?.desired?.digest);
    expect(firstMcp?.effect).toEqual({ connection: "remote-server", authConfigured: true });
    expect(JSON.stringify(firstMcp)).not.toContain("first.example");
    expect(JSON.stringify(firstMcp)).not.toContain('"scheme":"first"');

    const firstCron = resourceCapabilityChange({
      kind: "cronJob",
      id: "report",
      action: "change",
      desired: { schedule: { cron: "0 9 * * *" }, session: "isolated", message: "first" },
    });
    const secondCron = resourceCapabilityChange({
      kind: "cronJob",
      id: "report",
      action: "change",
      desired: { schedule: { cron: "0 9 * * *" }, session: "isolated", message: "second" },
    });
    expect(firstCron?.desired?.summary).toBe(secondCron?.desired?.summary);
    expect(firstCron?.desired?.digest).not.toBe(secondCron?.desired?.digest);
    expect(firstCron?.effect).toEqual({
      schedule: "cron",
      timezoneConfigured: false,
      session: "isolated",
      deliveryConfigured: false,
      payloadWithheld: true,
    });
    expect(JSON.stringify(firstCron)).not.toContain('"message":"first"');
  });

  it("describes MCP execution shape without exposing private configuration", () => {
    const change = resourceCapabilityChange({
      kind: "mcpServer",
      id: "private",
      action: "add",
      desired: {
        command: "private-command",
        args: ["--token", "secret-argument"],
        env: { PRIVATE_TOKEN: "secret-env" },
        auth: { token: "secret-auth" },
        toolFilter: { allow: ["secret-tool"] },
      },
    });
    expect(change?.effect).toEqual({
      connection: "local-process",
      commandConfigured: true,
      argumentCount: 2,
      authConfigured: true,
      toolFilterConfigured: true,
      envEntryCount: 1,
    });
    const serialized = JSON.stringify(change);
    for (const privateValue of [
      "private-command",
      "secret-argument",
      "PRIVATE_TOKEN",
      "secret-env",
      "secret-auth",
      "secret-tool",
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });
});
