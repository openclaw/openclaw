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
  resolveAgentConfig: (cfg: OpenClawConfig, agentId: string) => cfg.agents?.entries?.[agentId],
}));

import { resolveCronModelSelection } from "./isolated-agent/model-selection.js";
import { resolveCronAgentConfig } from "./isolated-agent/run-config.js";

type SelectionParams = Parameters<typeof resolveCronModelSelection>[0];
const defaultRef = { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL };
const selectedRef = { provider: "openai", model: "gpt-4.1-mini" };
const selectedModel = "openai/gpt-4.1-mini";
const select = (overrides: Partial<SelectionParams> = {}) =>
  resolveCronModelSelection({
    cfg: {},
    sessionEntry: {},
    isGmailHook: false,
    agentDir: "/tmp/agent",
    workspaceDir: "/tmp/workspace",
    ...overrides,
  });
const expectSelection = async (
  params: Partial<SelectionParams>,
  modelSource: string,
  ref = selectedRef,
) => expect(select(params)).resolves.toMatchObject({ ok: true, ...ref, modelSource });

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
  it("ignores a malformed persisted payload model", async () => {
    const overrides: Partial<SelectionParams> = {};
    // Persisted rows can contain values outside the TypeScript contract.
    Object.assign(overrides, { payloadModel: 42 });
    await expectSelection(overrides, "default", defaultRef);
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
      cfg: { agents: { entries: { ops: { modelPolicy: { allow: ["anthropic/*"] } } } } },
      agentId: "ops",
      expected:
        "rejected by agents.entries.*.modelPolicy.allow: openai/gpt-4.1-mini is not in [anthropic/*]",
    },
  ])("reports explicit payload rejection: $expected", async ({ error, cfg, agentId, expected }) => {
    mocks.allowed.mockReturnValueOnce({ error });
    await expect(select({ cfg, agentId, payloadModel: selectedModel })).resolves.toEqual({
      ok: false,
      error: `automation model override 'openai/gpt-4.1-mini' ${expected}`,
    });
  });

  it("uses one replacement catalog owner for config, policy, and selected identity", async () => {
    const cfg = { agents: { defaults: { model: "anthropic/caller-model" } } };
    const ownerConfig = {
      agents: {
        defaults: { model: "openai/owner-default", modelPolicy: { allow: ["openai/*"] } },
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
      select({
        cfg,
        payloadModel: "  openai/gpt-4.1-mini  ",
        sessionEntry: { providerOverride: "anthropic", modelOverride: "claude-sonnet-4-6" },
      }),
    ).resolves.toMatchObject({ ok: true, ...selectedRef, owner, modelSource: "payload" });
    expect(mocks.configured).toHaveBeenCalledWith(
      expect.objectContaining({ cfg: expect.objectContaining(ownerConfig) }),
    );
    expect(mocks.allowed).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: ownerConfig,
        agentId: "main",
        catalog,
        raw: selectedModel,
      }),
    );
  });

  it.each([true, false])("selects a Gmail hook model only when allowed=%s", async (allowed) => {
    mocks.hook.mockReturnValue(selectedRef);
    mocks.status.mockReturnValue({ allowed });
    await expectSelection(
      {
        isGmailHook: true,
        ...(allowed
          ? { sessionEntry: { providerOverride: "anthropic", modelOverride: "claude-opus-4-6" } }
          : {}),
      },
      allowed ? "hook" : "default",
      allowed ? selectedRef : defaultRef,
    );
  });
});

describe("resolveCronAgentConfig", () => {
  it("keeps the active runtime snapshot after agent-default derivation", () => {
    const discordConfig = (
      token: NonNullable<NonNullable<OpenClawConfig["channels"]>["discord"]>["token"],
    ): OpenClawConfig => ({ channels: { discord: { token } } });
    const sourceCfg = discordConfig({
      provider: "default",
      source: "env",
      id: "DISCORD_BOT_TOKEN",
    });
    const runtimeCfg = discordConfig("resolved-discord-token");
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
