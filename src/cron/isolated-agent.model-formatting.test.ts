import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
const model = "openai/gpt-4.1-mini";
const selected = (modelSource: string, ref = selectedRef) => ({ ok: true, ...ref, modelSource });
const payload = { kind: "agentTurn", message: "do it" } as const;
type Agents = NonNullable<OpenClawConfig["agents"]>;
const agentConfig = (defaults: Agents["defaults"], entries: Agents["entries"] = {}) => ({
  agents: { defaults, entries },
});
const discordConfig = (token: string | { provider: string; source: "env"; id: string }) =>
  ({ channels: { discord: { accounts: { default: { token } } } } }) satisfies OpenClawConfig;
const expectAllowed = (params: Record<string, unknown> = { raw: model }) =>
  expect(mocks.allowed).toHaveBeenCalledWith(expect.objectContaining(params));
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
  Object.values(mocks).forEach((mock) => mock.mockReset());
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
});
afterEach(clearRuntimeConfigSnapshot);

it.each<[string, OpenClawConfig, string | undefined, string]>([
  ["invalid model", {}, undefined, "rejected: invalid model"],
  [
    `model not allowed: ${model}`,
    {},
    undefined,
    `rejected by agents.defaults.modelPolicy.allow: ${model} is not in [(none configured)]`,
  ],
  [
    `model not allowed: ${model}`,
    agentConfig(undefined, { ops: { modelPolicy: { allow: ["anthropic/*"] } } }),
    "ops",
    `rejected by agents.entries.*.modelPolicy.allow: ${model} is not in [anthropic/*]`,
  ],
])("reports explicit payload rejection: %s", async (error, cfg, agentId, expected) => {
  mocks.allowed.mockReturnValueOnce({ error });
  await expect(select({ cfg, agentId, payload: { ...payload, model } })).resolves.toEqual({
    ok: false,
    error: `automation model override '${model}' ${expected}`,
  });
  expectAllowed({ cfg, agentId: agentId ?? "main" });
});

it("uses one replacement catalog owner for config, policy, and selected identity", async () => {
  const cfg = agentConfig({ model: "anthropic/caller-model" }, { worker: {} });
  const ownerConfig = agentConfig({ model: "openai/owner", modelPolicy: { allow: ["openai/*"] } });
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
      payload: { ...payload, model: `  ${model}  ` },
      sessionEntry: { providerOverride: "anthropic", modelOverride: "claude-sonnet-4-6" },
    }),
  ).resolves.toMatchObject({ ...selected("payload"), owner });
  expect(mocks.loadOwner).toHaveBeenCalledExactlyOnceWith({
    config: cfg,
    readOnly: true,
    allowGatewaySubagentBinding: true,
  });
  expect(mocks.configured.mock.lastCall?.[0]?.cfg).toMatchObject(ownerConfig);
  expectAllowed({ cfg: ownerConfig, agentId: "main", catalog, raw: model });
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
  ).resolves.toMatchObject(
    selected(allowed ? "hook" : "default", allowed ? selectedRef : defaultRef),
  );
});

it("uses the selected subagent model with agent defaults derived from object config", async () => {
  const agentConfigOverride = {
    model: { primary: "anthropic/claude-opus-4-6" },
    subagents: { model: { fallbacks: [] } },
  };
  const cfg = agentConfig({ model: "anthropic/claude-sonnet-4-6", subagents: { model } });
  mocks.subagent.mockReturnValue({ raw: model, source: "default-subagent" });
  await expect(select({ cfg, agentConfigOverride })).resolves.toMatchObject(selected("subagent"));
  expect(mocks.subagent).toHaveBeenCalledWith({ cfg, agentId: "main", agentConfigOverride });
  expectAllowed();
});

it("resolveCronAgentConfig keeps the active runtime snapshot after agent-default derivation", () => {
  const sourceCfg = discordConfig({ provider: "default", source: "env", id: "TOKEN" });
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
