// Covers runtime config overrides and precedence.
import { beforeEach, describe, expect, it } from "vitest";
import { listAgentWorkspaceDirs } from "../agents/workspace-dirs.js";
import {
  applyConfigOverrides,
  captureConfigOverrideApplier,
  getConfigOverrides,
  resetConfigOverrides,
  setConfigOverride,
  unsetConfigOverride,
} from "./runtime-overrides.js";
import { resolveMainSessionKey, resolveSessionRoutingContract } from "./sessions/main-session.js";
import { validateConfigObject } from "./validation.js";

describe("runtime overrides", () => {
  beforeEach(() => {
    resetConfigOverrides();
  });

  it("fingerprints the persisted owner of a global fixed store", () => {
    const cfg = {
      session: { scope: "global" as const, store: "/tmp/shared.sqlite" },
      agents: {
        ownership: "explicit" as const,
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { research: {}, ops: {} },
      },
    };

    expect(resolveSessionRoutingContract(cfg)).toBe("global|main|ops");
    expect(
      resolveSessionRoutingContract({
        ...cfg,
        agents: {
          ...cfg.agents,
          defaults: { sessionStore: { agentId: "research" } },
        },
      }),
    ).toBe("global|main|research");
  });

  it("captures an immutable override applier", () => {
    setConfigOverride("gateway.auth.token", "startup-token");
    const applyStartupOverrides = captureConfigOverrideApplier();
    setConfigOverride("gateway.auth.token", "later-token");

    expect(applyStartupOverrides({}).gateway?.auth?.token).toBe("startup-token");
    expect(applyConfigOverrides({}).gateway?.auth?.token).toBe("later-token");
  });

  it("preserves the validated agent projection when an override copies agents", () => {
    const validated = validateConfigObject({
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "jarvis" } },
        entries: {
          jarvis: {
            workspace: "/tmp/jarvis-workspace",
          },
          worker: {
            workspace: "/tmp/worker-workspace",
          },
        },
      },
    });
    if (!validated.ok) {
      throw new Error("expected valid keyed agent config");
    }

    const override = setConfigOverride("agents.defaults.model", "test/model");
    expect(override.ok).toBe(true);
    const applyCapturedOverrides = captureConfigOverrideApplier();
    const runtimeConfigs = [
      applyConfigOverrides(validated.config),
      applyCapturedOverrides(validated.config),
    ];

    for (const runtimeConfig of runtimeConfigs) {
      expect(runtimeConfig.agents).not.toBe(validated.config.agents);
      expect(Object.getOwnPropertyDescriptor(runtimeConfig.agents, "list")).toMatchObject({
        enumerable: false,
        value: [
          { id: "jarvis", workspace: "/tmp/jarvis-workspace" },
          { id: "worker", workspace: "/tmp/worker-workspace" },
        ],
      });
      expect(Object.keys(runtimeConfig.agents ?? {})).not.toContain("list");
      expect(listAgentWorkspaceDirs(runtimeConfig)).toEqual([
        "/tmp/jarvis-workspace",
        "/tmp/worker-workspace",
      ]);
      expect(resolveMainSessionKey(runtimeConfig)).toBe("agent:jarvis:main");
    }
  });

  it("unsets overrides and prunes empty branches", () => {
    setConfigOverride("channels.whatsapp.dmPolicy", "open");
    const removed = unsetConfigOverride("channels.whatsapp.dmPolicy");
    expect(removed).toEqual({ ok: true, value: true });
    expect(Object.keys(getConfigOverrides()).length).toBe(0);
  });

  it("rejects prototype pollution paths", () => {
    const attempts = ["__proto__.polluted", "constructor.polluted", "prototype.polluted"];
    for (const path of attempts) {
      const result = setConfigOverride(path, true);
      expect(result.ok).toBe(false);
      expect(Object.keys(getConfigOverrides()).length).toBe(0);
    }
  });

  it("sanitizes blocked object keys when writing overrides", () => {
    setConfigOverride("commands", JSON.parse('{"__proto__":{"bash":true},"debug":true}'));

    expect(getConfigOverrides()).toEqual({
      commands: {
        debug: true,
      },
    });
  });
});
