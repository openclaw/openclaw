import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SkillStatusReport } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { configSnapshot } from "../../lib/config/config-snapshot.test-support.ts";
import {
  createRuntimeConfigCapability,
  type RuntimeConfigCapability,
} from "../../lib/config/runtime-config-capability.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createSkill } from "../skills/view.test-support.ts";
import { createAgentConfigActions } from "./agent-config-actions.ts";
import { createAgentsPageLifetime } from "./agents-page-lifetime.ts";
import { createAgentSkillsReset, type AgentSkillsState } from "./skills.ts";

describe("createAgentSkillActions", () => {
  it("snapshots reported skills without learned Workshop skills on the first toggle", async () => {
    const report: SkillStatusReport = {
      workspaceDir: "/tmp/workspace",
      managedSkillsDir: "/tmp/skills",
      skills: [
        createSkill({ name: "github", source: "openclaw-bundled" }),
        createSkill({ name: "weather", source: "openclaw-managed" }),
        createSkill({ name: "actual-budget-operations", source: "openclaw-workshop" }),
      ],
    };
    const client = createTestGatewayClient(async () => configSnapshot({}));
    const runtimeConfig = createRuntimeConfigCapability({
      snapshot: { client, phase: "connected", sessionKey: "main" },
      subscribe: () => () => undefined,
    });

    try {
      await runtimeConfig.ensureLoaded();
      const actions = createAgentConfigActions({
        getRuntimeConfig: () => runtimeConfig,
        getReport: () => report,
        canUpdate: () => true,
        onPrimaryChanged: () => undefined,
      }).skills;
      actions.onToggle("main", "weather", false);

      expect(runtimeConfig.state.configForm).toEqual({
        agents: { entries: { main: { skills: ["github"] } } },
      });
    } finally {
      runtimeConfig.dispose();
    }
  });
});

describe("createAgentSkillsReset", () => {
  it("deletes the authored allowlist through an explicit config patch", async () => {
    const patch = vi.fn(async () => true);
    const runtimeConfig = {
      agentEntry: vi.fn(() => ({
        path: ["agents", "entries", "Research"],
        entry: { skills: ["coding-agent"] },
      })),
      patch,
    } as unknown as RuntimeConfigCapability;
    const client = {} as GatewayBrowserClient;
    const agents = {} as ApplicationContext["agents"];
    const state: AgentSkillsState = {
      client,
      connected: true,
      requestGeneration: 1,
      agentSkillsRead: null,
      agentSkillsReport: null,
      agentSkillsAgentId: null,
    };
    const onUpdated = vi.fn();
    const reset = createAgentSkillsReset({
      retired: createAgentsPageLifetime().retired,
      state,
      context: { agents, runtimeConfig },
      canReset: () => true,
      isCurrent: () => true,
      onUpdated,
    });

    await reset.clear("research");

    expect(patch).toHaveBeenCalledWith({
      raw: {
        agents: {
          entries: {
            Research: { skills: null },
          },
        },
      },
      note: "Reset agent skills to inherited defaults",
      replacePaths: ["agents.entries.Research.skills"],
      canDispatch: expect.any(Function),
    });
    expect(onUpdated).toHaveBeenCalledWith("research");
  });

  it("does not queue a patch after its caller becomes stale", async () => {
    const patch = vi.fn(async () => true);
    const runtimeConfig = {
      agentEntry: vi.fn(() => ({
        path: ["agents", "entries", "main"],
        entry: { skills: ["coding-agent"] },
      })),
      patch,
    } as unknown as RuntimeConfigCapability;
    const client = {} as GatewayBrowserClient;
    const agents = {} as ApplicationContext["agents"];
    const state: AgentSkillsState = {
      client,
      connected: true,
      requestGeneration: 1,
      agentSkillsRead: null,
      agentSkillsReport: null,
      agentSkillsAgentId: null,
    };
    const isCurrent = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    const reset = createAgentSkillsReset({
      retired: createAgentsPageLifetime().retired,
      state,
      context: { agents, runtimeConfig },
      canReset: () => true,
      isCurrent,
      onUpdated: vi.fn(),
    });

    await reset.clear("main");
    expect(patch).not.toHaveBeenCalled();
  });
});
