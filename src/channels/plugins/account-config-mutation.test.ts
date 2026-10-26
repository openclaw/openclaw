import { afterEach, assert, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MSTeamsConfig } from "../../config/types.msteams.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { createChannelTestPluginBase } from "../../test-utils/channel-plugins.js";
import {
  createNonExitingRuntimeEnv,
  createRuntimeEnv,
} from "../../test-utils/plugin-runtime-env.js";
import {
  applyPreparedChannelAccountConfiguration,
  prepareChannelAccountConfiguration,
} from "./account-config-mutation.js";
import { defineChannelSetupContract } from "./setup-contract.js";
import type { ChannelPlugin } from "./types.plugin.js";

const runtime = createNonExitingRuntimeEnv();

function prepare(
  plugin: ChannelPlugin,
  input: unknown,
  overrides: Partial<Parameters<typeof prepareChannelAccountConfiguration>[0]> = {},
) {
  return prepareChannelAccountConfiguration({
    cfg: {},
    plugin,
    resolveInput: () => input,
    runtime,
    ...overrides,
  });
}

it("prepares, validates, applies, and reports lifecycle changes in order", async () => {
  const callOrder: string[] = [];
  function record<T>(name: string, result: T) {
    callOrder.push(name);
    return result;
  }
  const beforePersistentEffect = async () => record("authority", undefined);
  const cfg = { channels: { "test-chat": { token: "old-token" } } } satisfies OpenClawConfig;
  const plugin = {
    ...createChannelTestPluginBase({ id: "test-chat" }),
    setup: {
      singleAccountKeysToMove: ["token"],
      prepareAccountConfigInput: ({ input }: { input: Record<string, unknown> }) =>
        record("prepare", { ...input, token: "prepared-token" }),
      validateInput: ({ input }: { input: Record<string, unknown> }) =>
        record("validate", input.token === "prepared-token" ? null : "input was not prepared"),
      applyAccountConfig: ({ cfg: inputCfg, accountId, input }) => {
        callOrder.push("apply");
        const accounts: Record<string, { token: string }> =
          inputCfg.channels?.["test-chat"]?.accounts ?? {};
        const updated = { ...accounts, [accountId]: { token: (input as { token: string }).token } };
        return { channels: { "test-chat": { accounts: updated } } };
      },
    },
    lifecycle: {
      onAccountConfigChanged: ({ prevCfg, nextCfg, accountId }) => {
        callOrder.push("lifecycle");
        expect(prevCfg).toBe(cfg);
        expect(accountId).toBe("work");
        expect(nextCfg.channels?.["test-chat"]).toMatchObject({
          accounts: {
            default: { token: "old-token" },
            work: { token: "prepared-token" },
          },
        });
      },
    },
  } as ChannelPlugin;

  const options = { cfg, runtime, requestedAccountId: "Work", beforePersistentEffect };
  const prepared = await prepare(plugin, { token: "raw-token" }, options);
  assert(prepared.ok, "expected prepared account configuration");

  const applied = await applyPreparedChannelAccountConfiguration({
    ...options,
    channel: "test-chat",
    prepared: prepared.value,
  });

  expect(callOrder).toEqual([
    "authority",
    "prepare",
    "validate",
    "apply",
    "authority",
    "lifecycle",
  ]);
  expect(applied.accountId).toBe("work");
  expect(applied.input).toEqual({ token: "prepared-token" });
});

it.each([
  ["rejects unknown options before mutation", "token", "string", { unknownOption: true }, false],
  ["accepts use-env without env metadata", "useEnv", "boolean", { useEnv: true }, true],
] as const)("setup contract %s", async (_name, key, kind, input, ok) => {
  const applyAccountConfig = vi.fn(({ cfg }) => cfg);
  const plugin = {
    ...createChannelTestPluginBase({ id: "typed-chat" }),
    setupContract: defineChannelSetupContract({
      fields: {
        [key]: {
          kind,
          cli: { flags: key === "token" ? "--token <token>" : "--use-env", description: key },
        },
      },
      adapter: { applyAccountConfig },
    }),
  } as ChannelPlugin;

  const prepared = await prepare(plugin, input);
  expect(prepared.ok).toBe(ok);
  if (!ok) {
    expect(prepared).toEqual({
      ok: false,
      error: { kind: "invalid-input", message: "Unsupported setup option: unknownOption" },
    });
    expect(applyAccountConfig).not.toHaveBeenCalled();
  }
});

it("does not resolve input when the channel has no account setup capability", async () => {
  const resolveInput = vi.fn(() => {
    throw new Error("input should stay lazy");
  });
  const plugin = createChannelTestPluginBase({ id: "read-only-chat" }) as ChannelPlugin;

  const prepared = await prepare(plugin, undefined, { resolveInput });

  expect(prepared).toEqual({ ok: false, error: { kind: "unsupported" } });
  expect(resolveInput).not.toHaveBeenCalled();
});

describe("MSTeams account configuration", () => {
  let msteamsSetupPlugin: ChannelPlugin<unknown>;
  beforeAll(async () => {
    ({ msteamsSetupPlugin } = await loadBundledPluginFacade<{
      msteamsSetupPlugin: ChannelPlugin<unknown>;
    }>({ pluginId: "msteams", artifactBasename: "setup-plugin-api.js" }));
  });

  const teamsRuntime = createRuntimeEnv();
  const credentials = (id: string) => ({ appId: `${id}-app`, appPassword: `${id}-secret` });
  const webhookPath = "/teams/messages";

  const policy = () => ({
    tenantId: "shared-tenant",
    dmPolicy: "allowlist" as const,
    allowFrom: ["owner"],
    groupPolicy: "allowlist" as const,
    webhook: { path: webhookPath },
  });
  const storedAuth = { ...credentials("stored"), tenantId: "stored-tenant" };
  function teamsConfig(section: MSTeamsConfig): OpenClawConfig {
    return { channels: { msteams: section } };
  }
  function account(cfg: OpenClawConfig, id = "default") {
    return msteamsSetupPlugin.config.resolveAccount(cfg, id);
  }
  function expectAvailable(cfg: OpenClawConfig, config: object, id = "default") {
    expect(account(cfg, id)).toMatchObject({ configured: true, tokenStatus: "available", config });
  }

  async function configure(cfg: OpenClawConfig, accountId: string, input: unknown) {
    const prepared = await prepare(msteamsSetupPlugin, input, {
      cfg,
      runtime: teamsRuntime,
      requestedAccountId: accountId,
    });
    if (!prepared.ok) {
      throw new Error(JSON.stringify(prepared.error));
    }
    const { nextConfig } = await applyPreparedChannelAccountConfiguration({
      cfg,
      runtime: teamsRuntime,
      channel: "msteams",
      prepared: prepared.value,
    });
    return nextConfig;
  }

  beforeEach(() => {
    for (const key of [
      "APP_ID",
      "APP_PASSWORD",
      "TENANT_ID",
      "AUTH_TYPE",
      "CERTIFICATE_PATH",
      "USE_MANAGED_IDENTITY",
    ]) {
      vi.stubEnv(`MSTEAMS_${key}`, "");
    }
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each([true, false])(
    "preserves root policy and enabled=%s through host promotion",
    async (enabled) => {
      const cfg = teamsConfig({
        ...policy(),
        enabled,
        ...credentials("default"),
        legacyWebhook: { port: 3978 },
      });
      const next = await configure(cfg, "support", credentials("support"));
      expect(next.channels?.msteams).toMatchObject({
        ...policy(),
        accounts: { default: credentials("default"), support: credentials("support") },
      });
      expect(account(next)).toMatchObject({ enabled, config: { webhook: { path: webhookPath } } });
      const support = account(next, "support");
      expect(support).toMatchObject({
        enabled: true,
        config: {
          tenantId: "shared-tenant",
          allowFrom: ["owner"],
          groupPolicy: "allowlist",
          webhook: { path: "/teams/messages/support" },
        },
      });
      expect(support).not.toHaveProperty("config.legacyWebhook");
    },
  );

  it("selects environment auth and retains the requested path without changing sibling authority", async () => {
    vi.stubEnv("MSTEAMS_APP_ID", "environment-app");
    vi.stubEnv("MSTEAMS_TENANT_ID", "environment-tenant");
    vi.stubEnv("MSTEAMS_AUTH_TYPE", "federated");
    vi.stubEnv("MSTEAMS_USE_MANAGED_IDENTITY", "true");
    const cfg = teamsConfig({
      ...storedAuth,
      tenantId: "shared-tenant",
      authType: "secret",
      webhook: { path: webhookPath },
      accounts: { sibling: credentials("sibling") },
    });
    const next = await configure(cfg, "default", {
      useEnv: true,
      webhookPath: "/teams/environment",
    });
    expectAvailable(next, { webhook: { path: "/teams/environment" } });
    vi.stubEnv("MSTEAMS_APP_ID", "");
    expect(account(next)).toMatchObject({ configured: false, tokenStatus: "missing" });
    expectAvailable(
      next,
      {
        webhook: { path: "/teams/messages/sibling" },
        ...credentials("sibling"),
        tenantId: "shared-tenant",
      },
      "sibling",
    );
    expect(next.channels?.msteams?.webhook?.path).toBe(webhookPath);
  });

  it("rejects incomplete environment auth even when persisted credentials are complete", async () => {
    vi.stubEnv("MSTEAMS_APP_ID", "partial-env-app");
    await expect(configure(teamsConfig(storedAuth), "default", { useEnv: true })).rejects.toThrow(
      "requires complete secret, certificate, or managed-identity environment credentials",
    );
  });

  it("accepts a complete explicit secret replacement over federated environment auth", async () => {
    vi.stubEnv("MSTEAMS_AUTH_TYPE", "federated");
    const replacement = { ...credentials("new"), tenantId: "new-tenant" };
    const next = await configure({}, "default", { useEnv: true, ...replacement });
    expectAvailable(next, { authType: "secret", ...replacement });
  });
});
