// Doctor node-hosting precondition tests cover browser-only auth and unreachable onboarding.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerAgentHarness } from "../agents/harness/registry.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { collectNodeHostingPreconditionFindings as findingsFor } from "./doctor-node-hosting-preconditions.js";

const originalPluginRegistry = getActivePluginRegistry();

function runtimeAgent(id: string, model = "openai/gpt-5.6-sol") {
  return { model, models: { [model]: { agentRuntime: { id } } } };
}
function nodePolicy(nodes: NonNullable<OpenClawConfig["gateway"]>["nodes"]): OpenClawConfig {
  return { gateway: { nodes } };
}

describe("node-hosting preconditions", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createEmptyPluginRegistry(),
      "node-hosting-preconditions-test",
      "default",
    );
    for (const [id, cloudPlacement] of [
      ["cloud-only", { mode: "remote-exec" }],
      ["acpx", undefined],
    ] as const) {
      registerAgentHarness({
        id,
        label: id,
        ...(cloudPlacement ? { cloudPlacement } : {}),
        supports: () => ({ supported: true }),
        async runAttempt() {
          throw new Error("not used");
        },
      });
    }
  });

  afterEach(() => {
    if (originalPluginRegistry) {
      setActivePluginRegistry(
        originalPluginRegistry,
        "node-hosting-preconditions-test-restore",
        "default",
      );
      return;
    }
    resetPluginRuntimeStateForTest();
  });

  const healthyBase = {
    tools: { exec: { host: "node" } },
    gateway: {
      bind: "lan",
      auth: { mode: "token", token: "configured-token" },
    },
    agents: { defaults: runtimeAgent("openclaw", "anthropic/claude-sonnet-4-6") },
  } satisfies OpenClawConfig;

  it.each<OpenClawConfig>([
    {},
    { gateway: { mode: "local", bind: "loopback", tailscale: { mode: "off" } } },
    { gateway: { bind: "auto" } },
    {
      plugins: { entries: { "device-pair": { enabled: false } } },
      ...nodePolicy({
        browser: { mode: "off", node: "unused-node" },
        pairing: { autoApproveLocal: false, autoApproveCidrs: [], sshVerify: false },
        commands: { allow: [], deny: ["system.run"] },
      }),
    },
    nodePolicy({
      browser: { mode: "auto" },
      pairing: { autoApproveLocal: true },
      pluginTools: { enabled: true },
      allowSkills: true,
    }),
    { tools: { exec: { host: "gateway", node: "unused-node" } } },
    { gateway: { mode: "remote" }, tools: { exec: { host: "node" } } },
  ])("ignores configurations without local node hosting: %j", async (cfg) => {
    expect(await findingsFor(cfg)).toEqual([]);
  });

  it.each<OpenClawConfig>([
    { tools: { exec: { host: "node" } } },
    { tools: { exec: { node: "worker" } } },
    { agents: { entries: { worker: { tools: { exec: { host: "node" } } } } } },
    nodePolicy({ browser: { mode: "manual", node: "browser-host" } }),
    nodePolicy({ pairing: { autoApproveCidrs: ["192.0.2.0/24"] } }),
    nodePolicy({ pairing: { sshVerify: { user: "node-user" } } }),
    nodePolicy({ commands: { allow: ["system.run"] } }),
    { plugins: { entries: { "device-pair": { enabled: true } } } },
  ])("warns about loopback onboarding for configured hosting: %j", async (cfg) => {
    expect(
      await findingsFor({
        ...healthyBase,
        tools: undefined,
        ...cfg,
        gateway: { ...healthyBase.gateway, bind: "loopback", ...cfg.gateway },
      }),
    ).toEqual([
      expect.objectContaining({ requirement: "node-onboarding-url", severity: "warning" }),
    ]);
  });

  it.each<[NonNullable<OpenClawConfig["gateway"]>, string[]]>([
    [{ auth: { mode: "trusted-proxy" } }, ["machine-client-auth", "node-onboarding-url"]],
    [
      { tailscale: { mode: "serve" }, auth: { mode: "token", allowTailscale: true } },
      ["machine-client-auth"],
    ],
  ])("warns about unavailable machine auth: %j", async (gateway, requirements) => {
    expect(
      (
        await findingsFor({
          ...healthyBase,
          gateway: { bind: "loopback", ...gateway },
        })
      ).map((finding) => finding.requirement),
    ).toEqual(requirements);
  });

  it.each<[OpenClawConfig, string]>([
    [{ plugins: { entries: { "device-pair": { enabled: false } } } }, "node-onboarding-plugin"],
    [
      {
        agents: {
          ownership: "explicit",
          entries: {
            writer: runtimeAgent("cloud-only"),
            reviewer: runtimeAgent("acpx", "anthropic/claude-sonnet-4-6"),
          },
        },
      },
      "device-session-runtime",
    ],
  ])("warns about missing node capability: %j", async (cfg, requirement) => {
    expect(
      (await findingsFor({ ...healthyBase, ...cfg })).map((finding) => finding.requirement),
    ).toContain(requirement);
  });

  it("does not activate plugins or reject a cold codex runtime", async () => {
    resetPluginRuntimeStateForTest();
    const cfg = { ...healthyBase, agents: { defaults: runtimeAgent("codex") } };
    expect(await findingsFor(cfg)).toEqual([]);
    expect(getActivePluginRegistry()).toBeNull();
  });

  it("accepts gateway.publicOrigin for loopback onboarding", async () => {
    expect(
      await findingsFor({
        ...healthyBase,
        gateway: {
          ...healthyBase.gateway,
          bind: "loopback",
          publicOrigin: "https://gateway.example.test",
        },
      }),
    ).toEqual([]);
  });
});
