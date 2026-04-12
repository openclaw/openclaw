import { describe, expect, it } from "vitest";
import { resolveSandboxConfigForAgent } from "../../agents/sandbox/config.js";
import { buildCronAgentDefaultsConfig } from "./run-config.js";

function makeCfg() {
  return {
    agents: {
      defaults: {
        sandbox: {
          mode: "all" as const,
          workspaceAccess: "rw" as const,
          docker: {
            network: "none",
            dangerouslyAllowContainerNamespaceJoin: true,
            dangerouslyAllowExternalBindSources: true,
          },
          browser: {
            enabled: true,
            autoStart: false,
          },
          prune: {
            maxAgeDays: 7,
          },
        },
      },
    },
  };
}

function buildRunCfg(agentId: string, agentConfigOverride?: Record<string, unknown>) {
  const cfg = makeCfg();
  const agentDefaults = buildCronAgentDefaultsConfig({
    defaults: cfg.agents.defaults,
    agentConfigOverride: agentConfigOverride as never,
  });
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: agentDefaults,
      list: [{ id: agentId, ...agentConfigOverride }],
    },
  };
}

function expectDefaultSandboxPreserved(
  runCfg:
    | {
        agents?: { defaults?: { sandbox?: unknown } };
      }
    | undefined,
) {
  expect(runCfg?.agents?.defaults?.sandbox).toEqual({
    mode: "all",
    workspaceAccess: "rw",
    docker: {
      network: "none",
      dangerouslyAllowContainerNamespaceJoin: true,
      dangerouslyAllowExternalBindSources: true,
    },
    browser: {
      enabled: true,
      autoStart: false,
    },
    prune: {
      maxAgeDays: 7,
    },
  });
}

describe("runCronIsolatedAgentTurn sandbox config preserved", () => {
  it("preserves heartbeat defaults while layering agent heartbeat overrides", async () => {
    const cfg = {
      agents: {
        defaults: {
          heartbeat: {
            model: "minimax",
            every: "5m",
            target: "feishu",
          },
          model: {
            primary: "minimax",
            fallbacks: ["openai/gpt-5.4-mini"],
          },
        },
      },
    };
    const agentDefaults = buildCronAgentDefaultsConfig({
      defaults: cfg.agents.defaults as never,
      agentConfigOverride: {
        heartbeat: {
          accountId: "default",
        },
        model: "cli-sonnet",
      } as never,
    });

    expect(agentDefaults.heartbeat).toEqual({
      model: "minimax",
      every: "5m",
      target: "feishu",
      accountId: "default",
    });
    expect(agentDefaults.model).toEqual({
      primary: "cli-sonnet",
      fallbacks: ["openai/gpt-5.4-mini"],
    });
  });

  it("preserves default sandbox config when agent entry omits sandbox", async () => {
    const runCfg = buildRunCfg("worker", {
      name: "worker",
      workspace: "/tmp/custom-workspace",
      sandbox: undefined,
      heartbeat: undefined,
      tools: undefined,
    });
    expectDefaultSandboxPreserved(runCfg);
    expect(resolveSandboxConfigForAgent(runCfg, "worker")).toMatchObject({
      mode: "all",
      workspaceAccess: "rw",
    });
  });

  it("keeps global sandbox defaults when agent override is partial", async () => {
    const runCfg = buildRunCfg("specialist", {
      sandbox: {
        docker: {
          image: "ghcr.io/openclaw/sandbox:custom",
        },
        browser: {
          image: "ghcr.io/openclaw/browser:custom",
        },
        prune: {
          idleHours: 1,
        },
      },
    });
    const resolvedSandbox = resolveSandboxConfigForAgent(runCfg, "specialist");

    expectDefaultSandboxPreserved(runCfg);
    expect(resolvedSandbox.mode).toBe("all");
    expect(resolvedSandbox.workspaceAccess).toBe("rw");
    expect(resolvedSandbox.docker).toMatchObject({
      image: "ghcr.io/openclaw/sandbox:custom",
      network: "none",
      dangerouslyAllowContainerNamespaceJoin: true,
      dangerouslyAllowExternalBindSources: true,
    });
    expect(resolvedSandbox.browser).toMatchObject({
      enabled: true,
      image: "ghcr.io/openclaw/browser:custom",
      autoStart: false,
    });
    expect(resolvedSandbox.prune).toMatchObject({
      idleHours: 1,
      maxAgeDays: 7,
    });
  });
});
