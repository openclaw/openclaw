import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const mocks = vi.hoisted(() => ({
  loadOwner: vi.fn(),
  allowed: vi.fn(),
  configured: vi.fn(),
  hook: vi.fn(),
  status: vi.fn(),
  subagent: vi.fn(),
}));
vi.mock("./isolated-agent/run-model-selection.runtime.js", () => ({
  DEFAULT_MODEL: "claude-opus-4-6",
  DEFAULT_PROVIDER: "anthropic",
  loadResolvedPublishedModelCatalogOwner: mocks.loadOwner,
  resolveAllowedModelRefCore: mocks.allowed,
  resolveConfiguredModelRef: mocks.configured,
  resolveHooksGmailModel: mocks.hook,
  getModelRefStatus: mocks.status,
  resolveSubagentModelConfigSelectionResult: mocks.subagent,
  normalizeModelSelection: (raw: unknown) =>
    typeof raw === "string" ? raw.trim() || undefined : undefined,
  publishedModelCatalogOwnerMatchesAgent: (owner: { agentId: string }, agentId: string) =>
    owner.agentId === agentId.trim().toLowerCase(),
  resolveAgentConfig: (cfg: OpenClawConfig, agentId: string) =>
    cfg.agents?.list?.find((agent) => agent.id === agentId),
}));

import { resolveCronModelSelection } from "./isolated-agent/model-selection.js";
import { resolveCronAgentConfig } from "./isolated-agent/run-config.js";

type SelectionParams = Parameters<typeof resolveCronModelSelection>[0];
const defaultRef = { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL };
const selectedRef = { provider: "openai", model: "gpt-4.1-mini" };
const payload = { kind: "agentTurn", message: "do it" } as const;
const select = (overrides: Partial<SelectionParams> = {}) =>
  resolveCronModelSelection({
    cfg: {},
    sessionEntry: {},
    payload,
    isGmailHook: false,
    agentDir: "/tmp/agent",
    workspaceDir: "/tmp/workspace",
    ...overrides,
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadOwner.mockImplementation(
    async (params: { config: OpenClawConfig; agentId?: string }) => ({
      agentId: params.agentId ?? "main",
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
      config: params.config,
      modelCatalog: { entries: [], routeVariants: [] },
    }),
  );
  mocks.configured.mockReturnValue(defaultRef);
  mocks.allowed.mockReturnValue({ ref: selectedRef });
  mocks.hook.mockReturnValue(null);
  mocks.status.mockReturnValue({ allowed: false });
  mocks.subagent.mockReturnValue(undefined);
});
afterEach(clearRuntimeConfigSnapshot);

describe("cron model selection", () => {
  it("uses the published read-only default when overrides are blank", async () => {
    await expect(
      select({
        payload: { ...payload, model: " " },
        sessionEntry: { providerOverride: "openai", modelOverride: " " },
      }),
    ).resolves.toMatchObject({ ok: true, ...defaultRef, modelSource: "default" });
    expect(mocks.loadOwner).toHaveBeenCalledWith({
      config: {},
      readOnly: true,
      allowGatewaySubagentBinding: true,
    });
    expect(mocks.allowed).not.toHaveBeenCalled();
  });

  it("lets the payload override a conflicting session model", async () => {
    await expect(
      select({
        payload: { ...payload, model: "openai/gpt-4.1-mini" },
        sessionEntry: { providerOverride: "anthropic", modelOverride: "claude-sonnet-4-6" },
      }),
    ).resolves.toMatchObject({ ok: true, ...selectedRef, modelSource: "payload" });
    expect(mocks.allowed).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ raw: "openai/gpt-4.1-mini" }),
    );
  });

  it("uses the session model when no payload model is present", async () => {
    await expect(
      select({ sessionEntry: { providerOverride: "openai", modelOverride: "gpt-4.1-mini" } }),
    ).resolves.toMatchObject({ ok: true, ...selectedRef, modelSource: "session" });
    expect(mocks.allowed).toHaveBeenCalledWith(
      expect.objectContaining({ raw: "openai/gpt-4.1-mini" }),
    );
  });

  it.each([
    { error: "invalid model", cfg: {}, agentId: undefined, expected: "rejected: invalid model" },
    {
      error: "model not allowed: openai/gpt-4.1-mini",
      cfg: {},
      agentId: undefined,
      expected:
        "rejected by agents.defaults.modelPolicy.allow: openai/gpt-4.1-mini is not in [(none configured)]",
    },
    {
      error: "model not allowed: openai/gpt-4.1-mini",
      cfg: { agents: { list: [{ id: "ops", modelPolicy: { allow: ["anthropic/*"] } }] } },
      agentId: "ops",
      expected:
        "rejected by agents.entries.*.modelPolicy.allow: openai/gpt-4.1-mini is not in [anthropic/*]",
    },
  ])("reports explicit payload rejection: $expected", async ({ error, cfg, agentId, expected }) => {
    mocks.allowed.mockReturnValueOnce({ error });
    await expect(
      select({ cfg, agentId, payload: { ...payload, model: "openai/gpt-4.1-mini" } }),
    ).resolves.toEqual({
      ok: false,
      error: `automation model override 'openai/gpt-4.1-mini' ${expected}`,
    });
  });

  it("authorizes aliases against the original agent policy scope", async () => {
    const cfg = {
      agents: {
        defaults: {
          models: { "openai/gpt-4.1-mini": { alias: "approved" } },
          modelPolicy: { allow: ["approved"] },
        },
        list: [{ id: "worker", models: { "anthropic/claude-sonnet-4-6": { alias: "approved" } } }],
      },
    };
    await select({ cfg, agentId: "worker", payload: { ...payload, model: "approved" } });
    expect(mocks.allowed).toHaveBeenCalledWith(
      expect.objectContaining({ cfg, agentId: "worker", raw: "approved" }),
    );
  });

  it("uses one replacement catalog owner for config, policy, and selected identity", async () => {
    const cfg = {
      agents: {
        defaults: { model: "anthropic/caller-model" },
        list: [{ id: "worker", default: true }],
      },
    };
    const ownerConfig = {
      agents: {
        defaults: { model: "openai/owner-default", modelPolicy: { allow: ["openai/*"] } },
        list: [{ id: "main", default: true }],
      },
    };
    const catalog = [{ id: "gpt-4.1-mini", name: "Owner Model", provider: "openai" }];
    const owner = {
      config: ownerConfig,
      agentId: "main",
      agentDir: "/tmp/owner-agent",
      workspaceDir: "/tmp/owner-workspace",
      modelCatalog: { entries: catalog, routeVariants: [] },
    };
    mocks.loadOwner.mockResolvedValueOnce(owner);
    await expect(
      select({ cfg, payload: { ...payload, model: "openai/gpt-4.1-mini" } }),
    ).resolves.toMatchObject({ ok: true, ...selectedRef, owner });
    expect(mocks.loadOwner).toHaveBeenCalledExactlyOnceWith({
      config: cfg,
      readOnly: true,
      allowGatewaySubagentBinding: true,
    });
    expect(mocks.configured).toHaveBeenCalledWith(
      expect.objectContaining({ cfg: expect.objectContaining(ownerConfig) }),
    );
    expect(mocks.allowed).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: ownerConfig,
        agentId: "main",
        catalog,
        raw: "openai/gpt-4.1-mini",
      }),
    );
  });

  it.each([true, false])("selects a Gmail hook model only when allowed=%s", async (allowed) => {
    mocks.hook.mockReturnValue(selectedRef);
    mocks.status.mockReturnValue({ allowed });
    await expect(
      select({
        isGmailHook: true,
        ...(allowed
          ? { sessionEntry: { providerOverride: "anthropic", modelOverride: "claude-opus-4-6" } }
          : {}),
      }),
    ).resolves.toMatchObject({
      ok: true,
      ...(allowed ? selectedRef : defaultRef),
      modelSource: allowed ? "hook" : "default",
    });
  });

  it("uses the selected subagent model with agent defaults derived from object config", async () => {
    const agentConfigOverride = {
      model: { primary: "anthropic/claude-opus-4-6" },
      subagents: { model: { fallbacks: [] } },
    };
    const cfg = {
      agents: {
        defaults: {
          model: "anthropic/claude-sonnet-4-6",
          subagents: { model: "openai/gpt-4.1-mini" },
        },
      },
    };
    mocks.subagent.mockReturnValue({ raw: "openai/gpt-4.1-mini", source: "default-subagent" });
    await expect(select({ cfg, agentConfigOverride })).resolves.toMatchObject({
      ok: true,
      ...selectedRef,
      modelSource: "subagent",
    });
    expect(mocks.subagent).toHaveBeenCalledWith({ cfg, agentId: "main", agentConfigOverride });
    expect(mocks.allowed).toHaveBeenCalledWith(
      expect.objectContaining({ raw: "openai/gpt-4.1-mini" }),
    );
  });
});

describe("resolveCronAgentConfig", () => {
  it("keeps the active runtime snapshot after agent-default derivation", () => {
    const sourceCfg = {
      channels: {
        discord: {
          accounts: {
            default: { token: { provider: "default", source: "env", id: "DISCORD_BOT_TOKEN" } },
          },
        },
      },
    } satisfies OpenClawConfig;
    const runtimeCfg = {
      channels: { discord: { accounts: { default: { token: "resolved-discord-token" } } } },
    } satisfies OpenClawConfig;
    setRuntimeConfigSnapshot(runtimeCfg, sourceCfg);
    const { agentDefaults, cfgWithAgentDefaults, runtimeConfig } = resolveCronAgentConfig({
      config: sourceCfg,
      agentConfigOverride: { model: "openai/gpt-5.5" },
    });
    expect(runtimeConfig).toBe(runtimeCfg);
    expect(agentDefaults.model).toEqual({ primary: "openai/gpt-5.5" });
    expect(cfgWithAgentDefaults.channels).toBe(runtimeCfg.channels);
  });
});
