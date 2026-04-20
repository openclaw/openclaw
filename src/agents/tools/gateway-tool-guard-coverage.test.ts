import { describe, expect, it } from "vitest";
import { assertGatewayConfigMutationAllowedForTest } from "./gateway-tool.js";

function expectBlocked(
  currentConfig: Record<string, unknown>,
  patch: Record<string, unknown>,
): void {
  expect(() =>
    assertGatewayConfigMutationAllowedForTest({
      action: "config.patch",
      currentConfig,
      raw: JSON.stringify(patch),
    }),
  ).toThrow(/cannot (?:change protected|enable dangerous)/);
}

function expectAllowed(
  currentConfig: Record<string, unknown>,
  patch: Record<string, unknown>,
): void {
  expect(() =>
    assertGatewayConfigMutationAllowedForTest({
      action: "config.patch",
      currentConfig,
      raw: JSON.stringify(patch),
    }),
  ).not.toThrow();
}

function expectBlockedApply(
  currentConfig: Record<string, unknown>,
  nextConfig: Record<string, unknown>,
): void {
  expect(() =>
    assertGatewayConfigMutationAllowedForTest({
      action: "config.apply",
      currentConfig,
      raw: JSON.stringify(nextConfig),
    }),
  ).toThrow(/cannot (?:change protected|enable dangerous)/);
}

function expectAllowedApply(
  currentConfig: Record<string, unknown>,
  nextConfig: Record<string, unknown>,
): void {
  expect(() =>
    assertGatewayConfigMutationAllowedForTest({
      action: "config.apply",
      currentConfig,
      raw: JSON.stringify(nextConfig),
    }),
  ).not.toThrow();
}

describe("gateway config mutation guard coverage", () => {
  it("blocks disabling sandbox mode via config.patch", () => {
    expectBlocked(
      { agents: { defaults: { sandbox: { mode: "all" } } } },
      { agents: { defaults: { sandbox: { mode: "off" } } } },
    );
  });

  it("blocks enabling an installed-but-disabled plugin via config.patch", () => {
    expectBlocked(
      { plugins: { entries: { malicious: { enabled: false } } } },
      { plugins: { entries: { malicious: { enabled: true } } } },
    );
  });

  it("blocks clearing tools.fs.workspaceOnly hardening via config.patch", () => {
    expectBlocked(
      { tools: { fs: { workspaceOnly: true } } },
      { tools: { fs: { workspaceOnly: false } } },
    );
  });

  it("blocks enabling sandbox dangerouslyAllowContainerNamespaceJoin via config.patch", () => {
    expectBlocked(
      {
        agents: {
          defaults: {
            sandbox: {
              docker: { dangerouslyAllowContainerNamespaceJoin: false },
            },
          },
        },
      },
      {
        agents: {
          defaults: {
            sandbox: {
              docker: { dangerouslyAllowContainerNamespaceJoin: true },
            },
          },
        },
      },
    );
  });

  it("blocks unlocking exec/shell/spawn on /tools/invoke via gateway.tools.allow", () => {
    expectBlocked(
      { gateway: { tools: { allow: [] as string[] } } },
      { gateway: { tools: { allow: ["exec", "shell", "spawn"] } } },
    );
  });

  it("blocks in-place hooks.mappings sessionKey rewrite via mergeObjectArraysById", () => {
    expectBlocked(
      {
        hooks: {
          mappings: [{ id: "gmail", sessionKey: "hook:gmail:{{messages[0].id}}" }],
        },
      },
      {
        hooks: {
          mappings: [{ id: "gmail", sessionKey: "hook:{{payload.session}}" }],
        },
      },
    );
  });

  it("blocks per-agent sandbox override under agents.list[]", () => {
    expectBlocked(
      {
        agents: {
          list: [{ id: "worker", sandbox: { mode: "all" } }],
        },
      },
      {
        agents: {
          list: [{ id: "worker", sandbox: { mode: "off" } }],
        },
      },
    );
  });

  it("blocks id-less per-agent sandbox injection under agents.list[]", () => {
    expectBlocked(
      { agents: { list: [] as Array<Record<string, unknown>> } },
      {
        agents: {
          list: [{ sandbox: { mode: "off" } }],
        },
      },
    );
  });

  it("blocks per-agent tools.allow override under agents.list[]", () => {
    expectBlocked(
      {
        agents: {
          list: [{ id: "worker", tools: { allow: [] as string[] } }],
        },
      },
      {
        agents: {
          list: [{ id: "worker", tools: { allow: ["exec", "shell", "spawn"] } }],
        },
      },
    );
  });

  it("blocks subagent tool deny-list override via tools.subagents", () => {
    expectBlocked(
      { tools: { subagents: { tools: { allow: [] as string[] } } } },
      { tools: { subagents: { tools: { allow: ["gateway", "cron", "sessions_send"] } } } },
    );
  });

  it("blocks gateway.auth.token rewrite via config.patch", () => {
    expectBlocked(
      { gateway: { auth: { mode: "token", token: "operator-secret" } } },
      { gateway: { auth: { token: "attacker-known-token" } } },
    );
  });

  it("blocks gateway.tls.certPath redirect via config.patch", () => {
    expectBlocked(
      { gateway: { tls: { enabled: true, certPath: "/etc/openclaw/cert.pem" } } },
      { gateway: { tls: { certPath: "/tmp/attacker/cert.pem" } } },
    );
  });

  it("blocks plugins.load.paths injection via config.patch", () => {
    expectBlocked(
      { plugins: { load: { paths: [] as string[] } } },
      { plugins: { load: { paths: ["/tmp/malicious-plugin"] } } },
    );
  });

  it("blocks plugins.slots memory swap via config.patch", () => {
    expectBlocked(
      { plugins: { slots: { memory: "official-memory" } } },
      { plugins: { slots: { memory: "attacker-memory" } } },
    );
  });

  it("still allows benign agent-driven tweaks", () => {
    expectAllowed(
      {
        agents: {
          defaults: { prompt: "You are a helpful assistant." },
          list: [{ id: "worker", model: "sonnet-4" }],
        },
      },
      {
        agents: {
          defaults: { prompt: "You are a terse assistant." },
          list: [{ id: "worker", model: "opus-4.6" }],
        },
      },
    );
  });

  it("blocks config.apply replacing the config with protected changes", () => {
    expectBlockedApply(
      {
        agents: {
          defaults: { sandbox: { mode: "all" }, prompt: "You are a helpful assistant." },
        },
      },
      {
        agents: {
          defaults: { sandbox: { mode: "off" }, prompt: "You are a terse assistant." },
        },
      },
    );
  });

  it("blocks config.apply duplicate-id protected rewrites", () => {
    expectBlockedApply(
      {
        agents: {
          list: [{ id: "worker", sandbox: { mode: "all" } }],
        },
      },
      {
        agents: {
          list: [
            { id: "worker", sandbox: { mode: "off" } },
            { id: "worker", sandbox: { mode: "all" } },
          ],
        },
      },
    );
  });

  it("still allows benign config.apply replacements", () => {
    expectAllowedApply(
      {
        agents: {
          defaults: { prompt: "You are a helpful assistant." },
          list: [{ id: "worker", model: "sonnet-4" }],
        },
      },
      {
        agents: {
          defaults: { prompt: "You are a terse assistant." },
          list: [{ id: "worker", model: "opus-4.6" }],
        },
      },
    );
  });
});
