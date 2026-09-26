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
    {
      name: "identity-header auth alone",
      cfg: {
        ...healthyBase,
        gateway: {
          bind: "lan",
          auth: { mode: "trusted-proxy" },
        },
      },
      requirements: ["machine-client-auth"],
    },
    {
      name: "loopback onboarding alone",
      cfg: {
        ...healthyBase,
        gateway: {
          bind: "loopback",
          auth: { mode: "token", token: "configured-token" },
        },
      },
      requirements: ["node-onboarding-url"],
    },
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
  }>)("warns when $name", ({ cfg, requirements }) => {
    expect(findingsFor(cfg).map((finding) => finding.requirement)).toEqual(requirements);
  });

  it("does not warn for token auth with a reachable bind", () => {
    expect(findingsFor(healthyBase)).toEqual([]);
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
    ({ cfg, requirement }) => {
      expect(findingsFor(cfg).map((finding) => finding.requirement)).toContain(requirement);
    },
  );

  it("keeps a mixed explicit roster healthy when one agent uses the embedded runtime", () => {
    expect(
      findingsFor({
        ...healthyBase,
        agents: {
          ownership: "explicit",
          entries: {
            cloud: {
              model: "openai/gpt-5.6-sol",
              models: { "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } } },
            },
            device: {
              model: "anthropic/claude-sonnet-4-6",
              models: {
                "anthropic/claude-sonnet-4-6": { agentRuntime: { id: "openclaw" } },
              },
            },
          },
        },
      }),
    ).toEqual([]);
  });

  it("accepts a registered external runtime that declares paired-device support", () => {
    expect(
      findingsFor({
        ...healthyBase,
        agents: {
          defaults: {
            model: "openai/gpt-5.6-sol",
            models: { "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } } },
          },
        },
      }),
    ).toEqual([]);
  });

  it.each(["codex", "auto"])("does not activate plugins or reject a cold %s runtime", (runtime) => {
    resetPluginRuntimeStateForTest();

    expect(
      findingsFor({
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

  it("accepts a configured public URL for loopback onboarding", () => {
    expect(
      findingsFor({
        ...healthyBase,
        gateway: {
          bind: "loopback",
          auth: { mode: "token", token: "configured-token" },
        },
        plugins: {
          entries: {
            "device-pair": { config: { publicUrl: "wss://gateway.example" } },
          },
        },
      }),
    ).toEqual([]);
  });
});
