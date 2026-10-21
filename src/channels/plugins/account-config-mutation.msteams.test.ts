import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { MSTeamsConfig } from "../../config/types.msteams.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { createRuntimeEnv } from "../../test-utils/plugin-runtime-env.js";
import {
  applyPreparedChannelAccountConfiguration,
  prepareChannelAccountConfiguration,
} from "./account-config-mutation.js";
import type { ChannelPlugin } from "./types.plugin.js";

let msteamsSetupPlugin: ChannelPlugin<unknown>;
beforeAll(async () => {
  ({ msteamsSetupPlugin } = await loadBundledPluginFacade<{
    msteamsSetupPlugin: ChannelPlugin<unknown>;
  }>({ pluginId: "msteams", artifactBasename: "setup-plugin-api.js" }));
});

const { log, error, exit } = createRuntimeEnv();
const runtime = { log, error, exit };
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
  const context = { cfg, runtime };
  const prepared = await prepareChannelAccountConfiguration({
    ...context,
    plugin: msteamsSetupPlugin,
    requestedAccountId: accountId,
    resolveInput: () => input,
  });
  if (!prepared.ok) {
    throw new Error(JSON.stringify(prepared.error));
  }
  const result = await applyPreparedChannelAccountConfiguration({
    ...context,
    channel: "msteams",
    prepared: prepared.value,
  });
  return result.nextConfig;
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
