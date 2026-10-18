// Doctor node-hosting precondition tests cover browser-only auth and unreachable onboarding.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerAgentHarness } from "../agents/harness/registry.js";
import type { AgentHarness } from "../agents/harness/types.js";
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
      [
        "codex",
        {
          mode: "remote-exec",
          devicePlacement: {
            requiredNodeCommands: ["codex.exec-server.stdio.v1"],
            consumesWorkerSlot: false,
          },
        },
      ],
      ["cloud-only", { mode: "remote-exec" }],
      ["acpx", undefined],
    ] as const) {
      const harness: AgentHarness = {
        id,
        label: id,
        ...(cloudPlacement ? { cloudPlacement } : {}),
        supports: () => ({ supported: true }),
        async runAttempt() {
          throw new Error("not used");
        },
      };
      registerAgentHarness(harness);
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

  it.each([
    ["fresh defaults", {}],
    [
      "a local-only loopback Gateway",
      { gateway: { mode: "local", bind: "loopback", tailscale: { mode: "off" } } },
    ],
    ["an automatic local bind", { gateway: { bind: "auto" } }],
    [
      "disabled pairing and restrictive node policies",
      {
        plugins: { entries: { "device-pair": { enabled: false } } },
        ...nodePolicy({
          browser: { mode: "off", node: "unused-node" },
          pairing: { autoApproveLocal: false, autoApproveCidrs: [], sshVerify: false },
          commands: { allow: [], deny: ["system.run"] },
        }),
      },
    ],
    [
      "default node capabilities without a target",
      nodePolicy({
        browser: { mode: "auto" },
        pairing: { autoApproveLocal: true },
        pluginTools: { enabled: true },
        allowSkills: true,
      }),
    ],
    [
      "a node pin with execution forced to the Gateway",
      { tools: { exec: { host: "gateway", node: "unused-node" } } },
    ],
    ["a remote-client profile", { gateway: { mode: "remote" }, tools: { exec: { host: "node" } } }],
  ] satisfies Array<[string, OpenClawConfig]>)("does not warn for %s", async (_name, cfg) => {
    expect(await findingsFor(cfg)).toEqual([]);
  });

  it.each([
    ["node execution", { tools: { exec: { host: "node" } } }],
    ["an explicit node binding", { tools: { exec: { node: "worker" } } }],
    [
      "per-agent node execution",
      { agents: { entries: { worker: { tools: { exec: { host: "node" } } } } } },
    ],
    ["a browser node target", nodePolicy({ browser: { mode: "manual", node: "browser-host" } })],
    ["remote pairing CIDRs", nodePolicy({ pairing: { autoApproveCidrs: ["192.0.2.0/24"] } })],
    ["explicit SSH pairing", nodePolicy({ pairing: { sshVerify: true } })],
    ["custom SSH pairing", nodePolicy({ pairing: { sshVerify: { user: "node-user" } } })],
    ["allowed node commands", nodePolicy({ commands: { allow: ["system.run"] } })],
    [
      "explicit device-pair enablement",
      { plugins: { entries: { "device-pair": { enabled: true } } } },
    ],
  ] satisfies Array<[string, OpenClawConfig]>)(
    "keeps the loopback warning for %s",
    async (_name, cfg) => {
      const findings = await findingsFor({
        ...healthyBase,
        tools: undefined,
        ...cfg,
        gateway: { ...healthyBase.gateway, bind: "loopback", ...cfg.gateway },
      });
      expect(findings).toEqual([
        expect.objectContaining({ requirement: "node-onboarding-url", severity: "warning" }),
      ]);
    },
  );

  it.each([
    {
      name: "both unavailable",
      cfg: {
        ...healthyBase,
        gateway: {
          bind: "loopback",
          auth: { mode: "trusted-proxy" },
        },
      },
      requirements: ["machine-client-auth", "node-onboarding-url"],
    },
    {
      name: "Tailscale identity without a shared secret",
      cfg: {
        ...healthyBase,
        gateway: {
          bind: "loopback",
          tailscale: { mode: "serve" },
          auth: { mode: "token", allowTailscale: true },
        },
      },
      requirements: ["machine-client-auth"],
    },
  ] satisfies Array<{
    name: string;
    cfg: OpenClawConfig;
    requirements: string[];
  }>)("warns when $name", async ({ cfg, requirements }) => {
    expect((await findingsFor(cfg)).map((finding) => finding.requirement)).toEqual(requirements);
  });

  it.each([
    {
      name: "device-pair is explicitly disabled",
      cfg: {
        ...healthyBase,
        plugins: { entries: { "device-pair": { enabled: false } } },
      },
      requirement: "node-onboarding-plugin",
    },
    {
      name: "every configured agent resolves to an incompatible runtime",
      cfg: {
        ...healthyBase,
        agents: {
          ownership: "explicit",
          entries: {
            writer: runtimeAgent("cloud-only"),
            reviewer: runtimeAgent("acpx", "anthropic/claude-sonnet-4-6"),
          },
        },
      },
      requirement: "device-session-runtime",
    },
  ] satisfies Array<{ name: string; cfg: OpenClawConfig; requirement: string }>)(
    "warns when $name",
    async ({ cfg, requirement }) => {
      expect((await findingsFor(cfg)).map((finding) => finding.requirement)).toContain(requirement);
    },
  );

  it.each(["codex"])("does not activate plugins or reject a cold %s runtime", async (runtime) => {
    resetPluginRuntimeStateForTest();

    expect(
      await findingsFor({
        ...healthyBase,
        agents: { defaults: runtimeAgent(runtime) },
      }),
    ).toEqual([]);
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
