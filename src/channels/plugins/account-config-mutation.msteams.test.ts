import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
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

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: (code: number): never => {
    throw new Error(String(code));
  },
};

async function configure(cfg: OpenClawConfig, accountId: string, input: unknown) {
  const prepared = await prepareChannelAccountConfiguration({
    cfg,
    plugin: msteamsSetupPlugin,
    requestedAccountId: accountId,
    resolveInput: () => input,
    runtime,
  });
  if (!prepared.ok) {
    throw new Error(JSON.stringify(prepared.error));
  }
  return (
    await applyPreparedChannelAccountConfiguration({
      cfg,
      channel: "msteams",
      prepared: prepared.value,
      runtime,
    })
  ).nextConfig;
}

describe("Teams host account setup", () => {
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
      const cfg: OpenClawConfig = {
        channels: {
          msteams: {
            enabled,
            appId: "default-app",
            appPassword: "default-secret",
            tenantId: "shared-tenant",
            dmPolicy: "allowlist",
            allowFrom: ["owner"],
            groupPolicy: "allowlist",
            webhook: { path: "/teams/messages" },
            legacyWebhook: { port: 3978 },
          },
        },
      };
      const next = await configure(cfg, "support", {
        appId: "support-app",
        appPassword: "support-secret",
      });
      expect(next.channels?.msteams).toMatchObject({
        tenantId: "shared-tenant",
        dmPolicy: "allowlist",
        allowFrom: ["owner"],
        groupPolicy: "allowlist",
        webhook: { path: "/teams/messages" },
        accounts: {
          default: { appId: "default-app", appPassword: "default-secret" },
          support: { appId: "support-app", appPassword: "support-secret" },
        },
      });
      expect(msteamsSetupPlugin.config.resolveAccount(next, "default")).toMatchObject({
        enabled,
        config: { webhook: { path: "/teams/messages" } },
      });
      const account = msteamsSetupPlugin.config.resolveAccount(next, "support");
      expect(account).toMatchObject({
        enabled: true,
        config: {
          tenantId: "shared-tenant",
          allowFrom: ["owner"],
          groupPolicy: "allowlist",
          webhook: { path: "/teams/messages/support" },
        },
      });
      expect(account).not.toHaveProperty("config.legacyWebhook");
    },
  );

  it("selects environment auth and retains the requested path without changing sibling authority", async () => {
    vi.stubEnv("MSTEAMS_APP_ID", "environment-app");
    vi.stubEnv("MSTEAMS_TENANT_ID", "environment-tenant");
    vi.stubEnv("MSTEAMS_AUTH_TYPE", "federated");
    vi.stubEnv("MSTEAMS_USE_MANAGED_IDENTITY", "true");
    const cfg: OpenClawConfig = {
      channels: {
        msteams: {
          appId: "stored-app",
          appPassword: "stored-password",
          tenantId: "shared-tenant",
          authType: "secret",
          webhook: { path: "/teams/messages" },
          accounts: { sibling: { appId: "sibling-app", appPassword: "sibling-password" } },
        },
      },
    };
    const next = await configure(cfg, "default", {
      useEnv: true,
      webhookPath: "/teams/environment",
    });
    expect(msteamsSetupPlugin.config.resolveAccount(next, "default")).toMatchObject({
      configured: true,
      tokenStatus: "available",
      config: { webhook: { path: "/teams/environment" } },
    });
    vi.stubEnv("MSTEAMS_APP_ID", "");
    expect(msteamsSetupPlugin.config.resolveAccount(next, "default")).toMatchObject({
      configured: false,
      tokenStatus: "missing",
    });
    expect(msteamsSetupPlugin.config.resolveAccount(next, "sibling")).toMatchObject({
      configured: true,
      tokenStatus: "available",
      config: {
        webhook: { path: "/teams/messages/sibling" },
        appId: "sibling-app",
        appPassword: "sibling-password",
        tenantId: "shared-tenant",
      },
    });
    expect(next.channels?.msteams?.webhook?.path).toBe("/teams/messages");
  });

  it("rejects incomplete environment auth even when persisted credentials are complete", async () => {
    vi.stubEnv("MSTEAMS_APP_ID", "partial-env-app");
    await expect(
      configure(
        {
          channels: {
            msteams: {
              appId: "stored-app",
              appPassword: "stored-password",
              tenantId: "stored-tenant",
            },
          },
        },
        "default",
        { useEnv: true },
      ),
    ).rejects.toThrow(
      "requires complete secret, certificate, or managed-identity environment credentials",
    );
  });

  it("accepts a complete explicit secret replacement over federated environment auth", async () => {
    vi.stubEnv("MSTEAMS_AUTH_TYPE", "federated");
    const next = await configure({}, "default", {
      useEnv: true,
      appId: "new-app",
      appPassword: "new-secret",
      tenantId: "new-tenant",
    });
    expect(msteamsSetupPlugin.config.resolveAccount(next)).toMatchObject({
      configured: true,
      tokenStatus: "available",
      config: {
        authType: "secret",
        appId: "new-app",
        appPassword: "new-secret",
        tenantId: "new-tenant",
      },
    });
  });
});
