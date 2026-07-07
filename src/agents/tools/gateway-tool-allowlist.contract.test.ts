// Locks the gateway config mutation allowlist and replacePaths guard boundaries.
// Covers both Gate 1 (path allowlist) and Gate 2 (dangerous flags) via
// config.patch, config.apply, replacePaths, and createGatewayTool execution.
// Any intentional allowlist change must update both ALLOWED_GATEWAY_CONFIG_PATHS
// and LOCKED_ALLOWLIST.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { callGatewayToolMock } = vi.hoisted(() => ({
  callGatewayToolMock: vi.fn(),
}));

vi.mock("./gateway.js", () => ({
  callGatewayTool: (...args: unknown[]) => callGatewayToolMock(...args),
  readGatewayCallOptions: vi.fn(() => ({})),
}));

import {
  ALLOWED_GATEWAY_CONFIG_PATHS_FOR_TEST,
  assertGatewayConfigMutationAllowedForTest,
  createGatewayTool,
} from "./gateway-tool.js";

const LOCKED_ALLOWLIST = [
  "agents.defaults.fastModeDefault",
  "agents.defaults.reasoningDefault",
  "agents.defaults.subagents.thinking",
  "agents.defaults.thinkingDefault",
  "agents.list[].fastModeDefault",
  "agents.list[].id",
  "agents.list[].model",
  "agents.list[].reasoningDefault",
  "agents.list[].subagents.thinking",
  "agents.list[].thinkingDefault",
  "channels.*.*.*.*.*.requireMention",
  "channels.*.*.*.*.requireMention",
  "channels.*.*.*.requireMention",
  "channels.*.*.requireMention",
  "channels.*.requireMention",
  "messages.groupChat.unmentionedInbound",
  "messages.groupChat.visibleReplies",
  "messages.visibleReplies",
] as const;

const FORBIDDEN_PATH_PATCHES: Array<{
  name: string;
  current: Record<string, unknown>;
  patch: Record<string, unknown>;
}> = [
  {
    name: "gateway.auth.token",
    current: { gateway: { auth: { token: "operator-secret" } } },
    patch: { gateway: { auth: { token: "attacker-token" } } },
  },
  {
    name: "plugins.allow",
    current: { plugins: { allow: ["trusted-plugin"] } },
    patch: { plugins: { allow: ["trusted-plugin", "evil-plugin"] } },
  },
  {
    name: "tools.exec.host",
    current: { tools: { exec: { host: "gateway" } } },
    patch: { tools: { exec: { host: "node" } } },
  },
];

const FORBIDDEN_DANGEROUS_FLAG_PATCHES: Array<{
  name: string;
  current: Record<string, unknown>;
  patch: Record<string, unknown>;
}> = [
  {
    name: "browser.ssrfPolicy.dangerouslyAllowPrivateNetwork",
    current: { browser: { ssrfPolicy: { dangerouslyAllowPrivateNetwork: false } } },
    patch: { browser: { ssrfPolicy: { dangerouslyAllowPrivateNetwork: true } } },
  },
  {
    name: "hooks.allowRequestSessionKey",
    current: { hooks: { allowRequestSessionKey: false } },
    patch: { hooks: { allowRequestSessionKey: true } },
  },
  {
    name: "sandbox.docker.dangerouslyAllowContainerNamespaceJoin",
    current: {
      agents: {
        defaults: { sandbox: { docker: { dangerouslyAllowContainerNamespaceJoin: false } } },
      },
    },
    patch: {
      agents: {
        defaults: { sandbox: { docker: { dangerouslyAllowContainerNamespaceJoin: true } } },
      },
    },
  },
];

function mockConfigGetSnapshot(snapshot: Record<string, unknown>) {
  const raw = JSON.stringify(snapshot);
  callGatewayToolMock.mockImplementation(async (method) => {
    if (method === "config.get") {
      return {
        config: snapshot,
        hash: "proof-base-hash",
        raw,
      };
    }
    throw new Error(`unexpected gateway method: ${method}`);
  });
}

describe("gateway config mutation allowlist contract", () => {
  it("locks the exact allowed path patterns", () => {
    expect([...ALLOWED_GATEWAY_CONFIG_PATHS_FOR_TEST].toSorted()).toEqual([...LOCKED_ALLOWLIST]);
  });

  it("exports a frozen allowlist snapshot that cannot mutate runtime policy", () => {
    expect(Object.isFrozen(ALLOWED_GATEWAY_CONFIG_PATHS_FOR_TEST)).toBe(true);
    expect(() => {
      (ALLOWED_GATEWAY_CONFIG_PATHS_FOR_TEST as string[]).push("evil.path");
    }).toThrow();
  });

  it.each(FORBIDDEN_PATH_PATCHES)(
    "Gate 1 — blocks protected path mutations via config.patch: $name",
    ({ current, patch }) => {
      expect(() =>
        assertGatewayConfigMutationAllowedForTest({
          action: "config.patch",
          currentConfig: current,
          raw: JSON.stringify(patch),
        }),
      ).toThrow(/cannot change protected config paths/);
    },
  );

  it.each(FORBIDDEN_DANGEROUS_FLAG_PATCHES)(
    "Gate 1+2 — blocks dangerous flag mutations via config.patch: $name",
    ({ current, patch }) => {
      expect(() =>
        assertGatewayConfigMutationAllowedForTest({
          action: "config.patch",
          currentConfig: current,
          raw: JSON.stringify(patch),
        }),
      ).toThrow(/cannot (?:change protected|enable dangerous)/);
    },
  );

  it("Gate 1 — blocks protected sandbox.mode change via config.apply (mixed allowlisted paths)", () => {
    expect(() =>
      assertGatewayConfigMutationAllowedForTest({
        action: "config.apply",
        currentConfig: {
          agents: {
            defaults: {
              sandbox: { mode: "all" },
              reasoningDefault: "low",
            },
            list: [{ id: "worker", model: "sonnet-4" }],
          },
        },
        raw: JSON.stringify({
          agents: {
            defaults: {
              sandbox: { mode: "off" },
              reasoningDefault: "medium",
            },
            list: [{ id: "worker", model: "opus-4.6" }],
          },
        }),
      }),
    ).toThrow(/cannot change protected config paths/);
  });

  it("Gate 1 — allows benign config.apply with only allowlisted paths changed", () => {
    expect(
      assertGatewayConfigMutationAllowedForTest({
        action: "config.apply",
        currentConfig: {
          agents: {
            defaults: { reasoningDefault: "low" },
            list: [{ id: "worker", model: "sonnet-4" }],
          },
        },
        raw: JSON.stringify({
          agents: {
            defaults: { reasoningDefault: "medium" },
            list: [{ id: "worker", model: "opus-4.6" }],
          },
        }),
      }),
    ).toBeUndefined();
  });

  it("allows agents.list wholesale replace via replacePaths when edits stay allowlisted", () => {
    expect(
      assertGatewayConfigMutationAllowedForTest({
        action: "config.patch",
        currentConfig: {
          agents: {
            list: [
              { id: "worker", model: "sonnet-4" },
              { id: "helper", model: "haiku" },
            ],
          },
        },
        raw: JSON.stringify({
          agents: { list: [{ id: "worker", model: "opus-4.6" }] },
        }),
        replacePaths: ["agents.list"],
      }),
    ).toBeUndefined();
  });

  it("blocks agents.list wholesale replace via replacePaths when protected fields change", () => {
    expect(() =>
      assertGatewayConfigMutationAllowedForTest({
        action: "config.patch",
        currentConfig: {
          agents: { list: [{ id: "worker", sandbox: { mode: "all" } }] },
        },
        raw: JSON.stringify({
          agents: { list: [{ id: "worker", sandbox: { mode: "off" } }] },
        }),
        replacePaths: ["agents.list"],
      }),
    ).toThrow(/cannot change protected config paths/);
  });
});

describe("gateway tool config mutation execution path", () => {
  beforeEach(() => {
    callGatewayToolMock.mockReset();
  });

  it("createGatewayTool config.patch accepts allowlisted edits and forwards RPC", async () => {
    mockConfigGetSnapshot({ agents: { defaults: { thinkingDefault: "off" } } });
    callGatewayToolMock.mockImplementation(async (method, _opts, args) => {
      if (method === "config.get") {
        return {
          config: { agents: { defaults: { thinkingDefault: "off" } } },
          hash: "proof-base-hash",
          raw: JSON.stringify({ agents: { defaults: { thinkingDefault: "off" } } }),
        };
      }
      if (method === "config.patch") {
        return { ok: true, hash: "proof-next-hash", ...(args as object) };
      }
      throw new Error(`unexpected gateway method: ${method}`);
    });

    const tool = createGatewayTool();
    const patchRaw = JSON.stringify({ agents: { defaults: { thinkingDefault: "on" } } });
    const result = await tool.execute?.("proof-allowlisted-patch", {
      action: "config.patch",
      raw: patchRaw,
      note: "proof allowlisted thinkingDefault patch",
    });

    expect(result?.details).toMatchObject({ ok: true });
    expect(callGatewayToolMock).toHaveBeenCalledWith(
      "config.patch",
      expect.anything(),
      expect.objectContaining({
        raw: patchRaw,
        baseHash: "proof-base-hash",
        note: "proof allowlisted thinkingDefault patch",
      }),
    );
  });

  it("createGatewayTool config.patch rejects protected edits before RPC", async () => {
    mockConfigGetSnapshot({ gateway: { auth: { token: "operator-secret" } } });
    const tool = createGatewayTool();
    const patchRaw = JSON.stringify({ gateway: { auth: { token: "attacker-token" } } });

    await expect(
      tool.execute?.("proof-blocked-patch", {
        action: "config.patch",
        raw: patchRaw,
        note: "proof protected gateway.auth.token patch",
      }),
    ).rejects.toThrow(/cannot change protected config paths: gateway\.auth\.token/);

    expect(callGatewayToolMock).not.toHaveBeenCalledWith(
      "config.patch",
      expect.anything(),
      expect.anything(),
    );
  });

  it("createGatewayTool config.apply rejects protected replacements before RPC", async () => {
    mockConfigGetSnapshot({ gateway: { auth: { token: "operator-secret" } } });
    const tool = createGatewayTool();
    const nextConfig = JSON.stringify({ gateway: { auth: { token: "attacker-token" } } });

    await expect(
      tool.execute?.("proof-blocked-apply", {
        action: "config.apply",
        raw: nextConfig,
        note: "proof protected config.apply replacement",
      }),
    ).rejects.toThrow(/cannot change protected config paths: gateway\.auth\.token/);

    expect(callGatewayToolMock).not.toHaveBeenCalledWith(
      "config.apply",
      expect.anything(),
      expect.anything(),
    );
  });

  it("createGatewayTool config.patch rejects dangerous flag enablement before RPC", async () => {
    mockConfigGetSnapshot({
      browser: { ssrfPolicy: { dangerouslyAllowPrivateNetwork: false } },
    });
    const tool = createGatewayTool();
    const patchRaw = JSON.stringify({
      browser: { ssrfPolicy: { dangerouslyAllowPrivateNetwork: true } },
    });

    await expect(
      tool.execute?.("proof-blocked-dangerous-flags", {
        action: "config.patch",
        raw: patchRaw,
        note: "proof protected dangerous flag enablement",
      }),
    ).rejects.toThrow(/cannot (?:change protected|enable dangerous)/);

    expect(callGatewayToolMock).not.toHaveBeenCalledWith(
      "config.patch",
      expect.anything(),
      expect.anything(),
    );
  });
});
