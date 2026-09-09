import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveRouterSafeRoutedDispatchPaths,
  RouterSafeRoutedDispatchPathError,
} from "./router-safe-routed-dispatch-paths.js";

function configWithAgentPaths(paths: { workspace?: string; agentDir?: string }): OpenClawConfig {
  return {
    agents: {
      entries: {
        "r-harris": {
          model: "openai/gpt-5.5",
          ...paths,
        },
      },
    },
  } as OpenClawConfig;
}

describe("resolveRouterSafeRoutedDispatchPaths", () => {
  it("maps routed Teams employee dispatch host-only paths to router-local mutable state", () => {
    const paths = resolveRouterSafeRoutedDispatchPaths({
      cfg: configWithAgentPaths({
        workspace: "/srv/openclaw/data/employee-agents/r-harris/workspace",
        agentDir: "/srv/openclaw/data/employee-agents/r-harris/agent",
      }),
      agentId: "r-harris",
      surface: "msteams",
      env: {
        OPENCLAW_STATE_DIR: "/home/openclaw/.openclaw",
        HOME: "/home/openclaw",
      },
    });

    expect(paths).toEqual({
      workspaceDir: "/home/openclaw/.openclaw/agents/r-harris/workspace",
      agentDir: "/home/openclaw/.openclaw/agents/r-harris/agent",
      diagnostics: {
        marker: "routerSafeRoutedDispatchStateRoot",
        agentId: "r-harris",
        surface: "msteams",
        stateRoot: "/home/openclaw/.openclaw",
        hostOnlyWorkspace: true,
        hostOnlyAgentDir: true,
        source: "configured",
      },
    });
  });

  it("maps host-only prepared Teams employee dispatch paths to router-local mutable state", () => {
    const paths = resolveRouterSafeRoutedDispatchPaths({
      cfg: configWithAgentPaths({
        workspace: "/home/openclaw/.openclaw/agents/r-harris/workspace",
        agentDir: "/home/openclaw/.openclaw/agents/r-harris/agent",
      }),
      agentId: "r-harris",
      surface: "msteams",
      preparedWorkspaceDir: "/srv/openclaw/data/employee-agents/r-harris/workspace",
      preparedAgentDir: "/srv/openclaw/data/employee-agents/r-harris/agent",
      env: {
        OPENCLAW_STATE_DIR: "/home/openclaw/.openclaw",
        HOME: "/home/openclaw",
      },
    });

    expect(paths).toEqual({
      workspaceDir: "/home/openclaw/.openclaw/agents/r-harris/workspace",
      agentDir: "/home/openclaw/.openclaw/agents/r-harris/agent",
      diagnostics: {
        marker: "routerSafeRoutedDispatchStateRoot",
        agentId: "r-harris",
        surface: "msteams",
        stateRoot: "/home/openclaw/.openclaw",
        hostOnlyWorkspace: true,
        hostOnlyAgentDir: true,
        source: "prepared",
      },
    });
  });

  it("fails closed with redacted diagnostics when host-only paths lack approved state root", () => {
    expect(() =>
      resolveRouterSafeRoutedDispatchPaths({
        cfg: configWithAgentPaths({
          workspace: "/srv/openclaw/data/employee-agents/r-harris/workspace",
          agentDir: "/srv/openclaw/data/employee-agents/r-harris/agent",
        }),
        agentId: "r-harris",
        surface: "msteams",
        env: { HOME: "/home/openclaw" },
      }),
    ).toThrow(RouterSafeRoutedDispatchPathError);

    try {
      resolveRouterSafeRoutedDispatchPaths({
        cfg: configWithAgentPaths({
          workspace: "/srv/openclaw/data/employee-agents/r-harris/workspace",
          agentDir: "/srv/openclaw/data/employee-agents/r-harris/agent",
        }),
        agentId: "r-harris",
        surface: "msteams",
        env: { HOME: "/home/openclaw" },
      });
    } catch (err) {
      expect(err).toBeInstanceOf(RouterSafeRoutedDispatchPathError);
      expect(String(err)).toContain("missing-approved-state-root");
      expect(String(err)).not.toContain("/srv/openclaw");
      expect((err as RouterSafeRoutedDispatchPathError).diagnostics).toMatchObject({
        agentId: "r-harris",
        surface: "msteams",
        reason: "missing-approved-state-root",
        hostOnlyWorkspace: true,
        hostOnlyAgentDir: true,
        source: "configured",
      });
    }
  });

  it("fails closed with redacted diagnostics when prepared host-only paths lack approved state root", () => {
    try {
      resolveRouterSafeRoutedDispatchPaths({
        cfg: configWithAgentPaths({}),
        agentId: "r-harris",
        surface: "msteams",
        preparedWorkspaceDir: "/srv/openclaw/data/employee-agents/r-harris/workspace",
        preparedAgentDir: "/srv/openclaw/data/employee-agents/r-harris/agent",
        env: { HOME: "/home/openclaw" },
      });
    } catch (err) {
      expect(err).toBeInstanceOf(RouterSafeRoutedDispatchPathError);
      expect(String(err)).toContain("missing-approved-state-root");
      expect(String(err)).not.toContain("/srv/openclaw");
      expect((err as RouterSafeRoutedDispatchPathError).diagnostics).toMatchObject({
        agentId: "r-harris",
        surface: "msteams",
        reason: "missing-approved-state-root",
        hostOnlyWorkspace: true,
        hostOnlyAgentDir: true,
        source: "prepared",
      });
      return;
    }
    throw new Error("expected prepared host-only path guard to fail closed");
  });

  it("does not override direct-peer routed dispatch paths that are already router-visible", () => {
    const paths = resolveRouterSafeRoutedDispatchPaths({
      cfg: configWithAgentPaths({
        workspace: "/home/openclaw/.openclaw/agents/r-harris/workspace",
        agentDir: "/home/openclaw/.openclaw/agents/r-harris/agent",
      }),
      agentId: "r-harris",
      surface: "msteams",
      env: {
        OPENCLAW_STATE_DIR: "/home/openclaw/.openclaw",
        HOME: "/home/openclaw",
      },
    });

    expect(paths).toBeUndefined();
  });

  it("preserves non-Teams dispatch behavior", () => {
    const paths = resolveRouterSafeRoutedDispatchPaths({
      cfg: configWithAgentPaths({
        workspace: "/srv/openclaw/data/employee-agents/r-harris/workspace",
        agentDir: "/srv/openclaw/data/employee-agents/r-harris/agent",
      }),
      agentId: "r-harris",
      surface: "telegram",
      env: {
        OPENCLAW_STATE_DIR: "/home/openclaw/.openclaw",
        HOME: "/home/openclaw",
      },
    });

    expect(paths).toBeUndefined();
  });
});
