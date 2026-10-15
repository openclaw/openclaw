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
import { collectNodeHostingPreconditionFindings } from "./doctor-node-hosting-preconditions.js";

const originalPluginRegistry = getActivePluginRegistry();

function findingsFor(cfg: OpenClawConfig) {
  return collectNodeHostingPreconditionFindings(cfg);
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
    agents: {
      defaults: {
        model: "anthropic/claude-sonnet-4-6",
        models: {
          "anthropic/claude-sonnet-4-6": { agentRuntime: { id: "openclaw" } },
        },
      },
    },
  } satisfies OpenClawConfig;

  it.each([
    { name: "fresh defaults", cfg: {} },
    {
      name: "a local-only loopback Gateway",
      cfg: { gateway: { mode: "local", bind: "loopback", tailscale: { mode: "off" } } },
    },
    { name: "an automatic local bind", cfg: { gateway: { bind: "auto" } } },
    {
      name: "disabled pairing and restrictive node policies",
      cfg: {
        plugins: { entries: { "device-pair": { enabled: false } } },
        gateway: {
          nodes: {
            browser: { mode: "off", node: "unused-node" },
            pairing: { autoApproveLocal: false, autoApproveCidrs: [], sshVerify: false },
            commands: { allow: [], deny: ["system.run"] },
          },
        },
      },
    },
    {
      name: "default node capabilities without a target",
      cfg: {
        gateway: {
          nodes: {
            browser: { mode: "auto" },
            pairing: { autoApproveLocal: true },
            pluginTools: { enabled: true },
            allowSkills: true,
          },
        },
      },
    },
    {
      name: "a node pin with execution forced to the Gateway",
      cfg: { tools: { exec: { host: "gateway", node: "unused-node" } } },
    },
    {
      name: "a remote-client profile",
      cfg: { gateway: { mode: "remote" }, tools: { exec: { host: "node" } } },
    },
  ] satisfies Array<{ name: string; cfg: OpenClawConfig }>)(
    "does not warn for $name",
    async ({ cfg }) => {
      expect(await findingsFor(cfg)).toEqual([]);
    },
  );

  it.each([
    { name: "node execution", cfg: { tools: { exec: { host: "node" } } } },
    { name: "an explicit node binding", cfg: { tools: { exec: { node: "worker" } } } },
    {
      name: "per-agent node execution",
      cfg: { agents: { entries: { worker: { tools: { exec: { host: "node" } } } } } },
    },
    {
      name: "a browser node target",
      cfg: { gateway: { nodes: { browser: { mode: "manual", node: "browser-host" } } } },
    },
    {
      name: "remote pairing CIDRs",
      cfg: { gateway: { nodes: { pairing: { autoApproveCidrs: ["192.0.2.0/24"] } } } },
    },
    {
      name: "explicit SSH pairing",
      cfg: { gateway: { nodes: { pairing: { sshVerify: true } } } },
    },
    {
      name: "custom SSH pairing",
      cfg: { gateway: { nodes: { pairing: { sshVerify: { user: "node-user" } } } } },
    },
    {
      name: "allowed node commands",
      cfg: { gateway: { nodes: { commands: { allow: ["system.run"] } } } },
    },
    {
      name: "explicit device-pair enablement",
      cfg: { plugins: { entries: { "device-pair": { enabled: true } } } },
    },
  ] satisfies Array<{ name: string; cfg: OpenClawConfig }>)(
    "keeps the loopback warning for $name",
    async ({ cfg }) => {
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
            writer: {
              model: "openai/gpt-5.6-sol",
              models: { "openai/gpt-5.6-sol": { agentRuntime: { id: "cloud-only" } } },
            },
            reviewer: {
              model: "anthropic/claude-sonnet-4-6",
              models: { "anthropic/claude-sonnet-4-6": { agentRuntime: { id: "acpx" } } },
            },
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
        agents: {
          defaults: {
            model: "openai/gpt-5.6-sol",
            models: { "openai/gpt-5.6-sol": { agentRuntime: { id: runtime } } },
          },
        },
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
