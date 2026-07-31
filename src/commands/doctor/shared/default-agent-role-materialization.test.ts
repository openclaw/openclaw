import { describe, expect, it } from "vitest";
import {
  AgentSelectionRequiredError,
  resolveDefaultAgentId,
  tryResolveDefaultAgentId,
} from "../../../agents/agent-scope-config.js";
import { materializeLegacyDefaultAgentRoles } from "../../../config/legacy.default-agent-roles.js";
import { migratePersistedImplicitMainRoster } from "../../../config/legacy.roster.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveCronJobEffectiveAgentId } from "../../../cron/agent-id.js";
import { resolveHeartbeatAgents } from "../../../infra/heartbeat-runner.js";
import { resolveAgentRoute } from "../../../routing/resolve-route.js";
import { defaultRuntime } from "../../../runtime.js";
import { resolveSystemAgentTargetAgentId } from "../../../system-agent/inference-route.js";
import { resolveTalkTargetAgentId } from "../../../talk/agent-target.js";
import { resolveCliAgentId } from "../../agent-selection.js";

type SurfaceSnapshot = {
  channel: string;
  heartbeat: string[];
  consult: string;
  voice: string;
  cron: string;
  cli: string;
};

async function snapshotSurfaces(
  cfg: OpenClawConfig,
  explicitAgentId?: string,
): Promise<SurfaceSnapshot> {
  const soleAgentId = tryResolveDefaultAgentId(cfg);
  return {
    channel: resolveAgentRoute({
      cfg,
      channel: "telegram",
      accountId: "work",
      peer: { kind: "direct", id: "user-1" },
    }).agentId,
    heartbeat: resolveHeartbeatAgents(cfg).map((entry) => entry.agentId),
    consult: resolveSystemAgentTargetAgentId(cfg),
    voice: resolveTalkTargetAgentId(cfg),
    cron: resolveCronJobEffectiveAgentId(
      explicitAgentId ? { agentId: explicitAgentId } : {},
      soleAgentId,
    ),
    cli: await resolveCliAgentId({
      cfg,
      runtime: defaultRuntime,
      agentInput: explicitAgentId,
      surface: "matrix CLI",
      deps: { interactive: false },
    }),
  };
}

const explicitMultiAgent: OpenClawConfig = {
  agents: {
    ownership: "explicit",
    defaults: {
      heartbeat: { agentId: "ops" },
      systemAgent: { agentId: "ops" },
    },
    entries: { ops: {}, research: {} },
  },
  bindings: [{ agentId: "ops", match: { channel: "telegram", accountId: "*" } }],
  channels: { telegram: { enabled: true } },
  talk: { agentId: "ops", provider: "test" },
};

describe("sole-agent-or-explicit ambient routing", () => {
  it.each([
    {
      name: "legacy single-agent",
      config: migratePersistedImplicitMainRoster({}).config as OpenClawConfig,
      expected: "main",
      explicitMultiOwner: false,
    },
    {
      name: "explicit single-agent",
      config: {
        agents: { entries: { solo: {} } },
        channels: { telegram: { enabled: true } },
      } satisfies OpenClawConfig,
      expected: "solo",
      explicitMultiOwner: false,
    },
    {
      name: "migrated multi-agent legacy default",
      config: migratePersistedImplicitMainRoster({
        agents: { entries: { ops: { default: true }, research: {} } },
        channels: { telegram: { enabled: true } },
      }).config as OpenClawConfig,
      expected: "ops",
      explicitMultiOwner: true,
    },
    {
      name: "fully explicit multi-agent",
      config: explicitMultiAgent,
      expected: "ops",
      explicitMultiOwner: true,
    },
  ])("routes all six surfaces for $name", async ({ config, expected, explicitMultiOwner }) => {
    expect(await snapshotSurfaces(config, explicitMultiOwner ? expected : undefined)).toEqual({
      channel: expected,
      heartbeat: [expected],
      consult: expected,
      voice: expected,
      cron: expected,
      cli: expected,
    });
  });

  it("fails every ownerless multi-agent surface with typed remediation", async () => {
    const cfg: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
      channels: { telegram: { enabled: true } },
    };
    const operations = [
      () =>
        resolveAgentRoute({
          cfg,
          channel: "telegram",
          accountId: "work",
          peer: { kind: "direct", id: "user-1" },
        }),
      () => resolveHeartbeatAgents(cfg),
      () => resolveSystemAgentTargetAgentId(cfg),
      () => resolveTalkTargetAgentId(cfg),
      () =>
        resolveDefaultAgentId(cfg, {
          surface: "cron job creation",
          hint: "Pass --agent <id>.",
        }),
    ];
    for (const operation of operations) {
      expect(operation).toThrow(AgentSelectionRequiredError);
    }
    await expect(
      resolveCliAgentId({
        cfg,
        runtime: defaultRuntime,
        surface: "agent turn",
        deps: { interactive: false },
      }),
    ).rejects.toMatchObject({
      code: "AGENT_SELECTION_REQUIRED",
      surface: "agent turn",
    });
  });
});

describe("retired default role materialization", () => {
  it("pins a blank-string legacy workspace instead of treating it as resolved", () => {
    const result = materializeLegacyDefaultAgentRoles(
      {
        agents: {
          defaults: { workspace: "/srv/shared" },
          entries: { ops: { workspace: "" }, research: {} },
        },
      },
      "ops",
      { materializeWorkspace: true },
    );

    expect(result.config.agents?.entries?.ops?.workspace).toBe("/srv/shared");
    expect(result.insertedPaths).toContainEqual(["agents", "entries", "ops", "workspace"]);
  });

  it("adds only uncovered channel-wide bindings and preserves narrower routes", () => {
    const config: OpenClawConfig = {
      agents: { entries: { ops: {}, research: {} } },
      channels: {
        telegram: { enabled: true },
        discord: { enabled: true },
        slack: { enabled: false },
      },
      bindings: [
        { agentId: "research", match: { channel: "telegram", accountId: "work" } },
        { agentId: "research", match: { channel: "discord", accountId: "*" } },
      ],
    };

    const result = materializeLegacyDefaultAgentRoles(config, "ops");
    expect(result.config.bindings).toEqual([
      ...config.bindings!,
      { agentId: "ops", match: { channel: "telegram", accountId: "*" } },
    ]);
    expect(
      resolveAgentRoute({
        cfg: result.config,
        channel: "telegram",
        accountId: "work",
        peer: { kind: "direct", id: "user-1" },
      }).agentId,
    ).toBe("research");
  });

  it("preserves shared and per-agent heartbeat enrollment", () => {
    const allAgents: OpenClawConfig = {
      agents: {
        defaults: { heartbeat: { every: "1h" } },
        entries: { ops: {}, research: {} },
      },
    };
    const perAgent: OpenClawConfig = {
      agents: {
        entries: { ops: {}, research: { heartbeat: { every: "1h" } } },
      },
    };

    const shared = materializeLegacyDefaultAgentRoles(allAgents, "ops").config;
    const targeted = materializeLegacyDefaultAgentRoles(perAgent, "ops").config;
    expect(shared.agents?.defaults?.heartbeat).toEqual({ every: "1h" });
    expect(resolveHeartbeatAgents(shared).map((entry) => entry.agentId)).toEqual([
      "ops",
      "research",
    ]);
    expect(resolveHeartbeatAgents(targeted)).toEqual([
      { agentId: "research", heartbeat: { every: "1h" } },
    ]);
  });

  it.each([
    ["marked", { ops: { default: true }, research: {} }],
    ["marker-free legacy", { ops: {}, research: {} }],
  ] as const)(
    "persists the %s owner into an enabled voice-call plugin config",
    (_label, entries) => {
      const migrated = migratePersistedImplicitMainRoster({
        agents: { entries },
        plugins: {
          entries: {
            "voice-call": {
              enabled: true,
              config: { enabled: true, provider: "mock" },
            },
          },
        },
      }).config as OpenClawConfig;

      expect(migrated.plugins?.entries?.["voice-call"]?.config).toMatchObject({
        enabled: true,
        provider: "mock",
        agentId: "ops",
      });
    },
  );
});
