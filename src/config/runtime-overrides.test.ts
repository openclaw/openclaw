import { beforeEach, expect, it } from "vitest";
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

beforeEach(resetConfigOverrides);

it("fingerprints the persisted owner of a global fixed store", () => {
  const routingConfig = (agentId: string) => ({
    session: { scope: "global" as const, store: "/tmp/shared.sqlite" },
    agents: {
      ownership: "explicit" as const,
      defaults: { sessionStore: { agentId } },
      entries: { research: {}, ops: {} },
    },
  });
  expect(resolveSessionRoutingContract(routingConfig("ops"))).toBe("global|main|ops");
  expect(resolveSessionRoutingContract(routingConfig("research"))).toBe("global|main|research");
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
        jarvis: { workspace: "/tmp/jarvis-workspace" },
        worker: { workspace: "/tmp/worker-workspace" },
      },
    },
  });
  if (!validated.ok) {
    throw new Error("expected valid keyed agent config");
  }

  expect(setConfigOverride("agents.defaults.model", "test/model").ok).toBe(true);
  for (const runtimeConfig of [
    applyConfigOverrides(validated.config),
    captureConfigOverrideApplier()(validated.config),
  ]) {
    expect(runtimeConfig.agents).not.toBe(validated.config.agents);
    expect(Object.getOwnPropertyDescriptor(runtimeConfig.agents, "list")).toMatchObject({
      enumerable: false,
      value: [
        { id: "jarvis", workspace: "/tmp/jarvis-workspace" },
        { id: "worker", workspace: "/tmp/worker-workspace" },
      ],
    });
    expect(listAgentWorkspaceDirs(runtimeConfig)).toEqual([
      "/tmp/jarvis-workspace",
      "/tmp/worker-workspace",
    ]);
    expect(resolveMainSessionKey(runtimeConfig)).toBe("agent:jarvis:main");
  }
});

it("unsets overrides and prunes empty branches", () => {
  setConfigOverride("channels.whatsapp.dmPolicy", "open");
  expect(unsetConfigOverride("channels.whatsapp.dmPolicy")).toEqual({ ok: true, value: true });
  expect(getConfigOverrides()).toEqual({});
});

it("rejects prototype pollution paths", () => {
  for (const path of ["__proto__.polluted", "constructor.polluted", "prototype.polluted"]) {
    expect(setConfigOverride(path, true).ok).toBe(false);
    expect(getConfigOverrides()).toEqual({});
  }
});

it("sanitizes blocked object keys when writing overrides", () => {
  setConfigOverride("commands", JSON.parse('{"__proto__":{"bash":true},"debug":true}'));
  expect(getConfigOverrides()).toEqual({ commands: { debug: true } });
});
