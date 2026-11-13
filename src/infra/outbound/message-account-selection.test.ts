import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { setActiveDegradedSecretOwners } from "../../secrets/runtime-degraded-state.js";
import { createChannelTestPluginBase } from "../../test-utils/channel-plugins.js";
import {
  resolveMessageBroadcastAccountPlan,
  validateExplicitMessageAccountSelection,
} from "./message-account-selection.js";

afterEach(() => {
  setActiveDegradedSecretOwners([]);
  vi.restoreAllMocks();
});

describe("validateExplicitMessageAccountSelection", () => {
  const cfg = {} as OpenClawConfig;
  const plugin = {
    id: "feishu",
    config: {
      listAccountIds: () => ["default"],
      defaultAccountId: () => "ops",
      resolveAccount: (_cfg: OpenClawConfig, accountId?: string | null) => ({
        accountId,
        enabled: true,
      }),
    },
  } as unknown as ChannelPlugin;
  const select = (
    accountId = "OPS",
    overrides: Partial<Parameters<typeof validateExplicitMessageAccountSelection>[0]> = {},
  ) =>
    validateExplicitMessageAccountSelection({
      cfg,
      channel: "feishu",
      accountId,
      plugin,
      ...overrides,
    });

  it("still rejects a non-default unlisted account", async () => {
    await expect(select("missing")).rejects.toThrow('Unknown account "missing"');
  });

  it("uses awaited account state and rejects accounts disabled during resolution", async () => {
    const pending = createDeferred<{ enabled: boolean }>();
    const asyncPlugin: ChannelPlugin = {
      ...plugin,
      config: {
        ...plugin.config,
        resolveAccount: () => {
          throw new Error("Synchronous account access");
        },
        resolveAccountAsync: () => pending.promise,
      },
    };
    const selected = select("OPS", { plugin: asyncPlugin });
    pending.resolve({ enabled: false });
    await expect(selected).rejects.toThrow('Account "ops" for channel feishu is disabled');
  });

  it("rejects only an unavailable active account before resolving its credentials", async () => {
    setActiveDegradedSecretOwners([
      {
        ownerKind: "account",
        ownerId: "feishu:ops",
        state: "unavailable",
        paths: ["channels.feishu.accounts.ops.appSecret"],
        refKeys: ["env:default:MISSING_FEISHU_SECRET"],
        reason: "secret reference was not found",
      },
    ]);
    const resolveAccount = vi.spyOn(plugin.config, "resolveAccount");

    await expect(select()).rejects.toThrowError(
      expect.objectContaining({ code: "SECRET_SURFACE_UNAVAILABLE" }),
    );
    expect(resolveAccount).not.toHaveBeenCalled();

    expect(await select("OPS", { checkResolvedAccount: false })).toBe("ops");
    expect(await select("default")).toBe("default");
  });
});

describe("resolveMessageBroadcastAccountPlan (registry-scoped channel plugins)", () => {
  const scopedPlugin: ChannelPlugin = {
    ...createChannelTestPluginBase({
      id: "scopex",
      config: {
        listAccountIds: () => ["ops"],
        resolveAccount: (_cfg: OpenClawConfig, accountId?: string | null) => ({
          accountId,
          enabled: true,
        }),
      },
    }),
    outbound: {
      deliveryMode: "direct",
      sendText: async () => ({ channel: "scopex", messageId: "scopex-message" }),
    },
  };
  const unavailablePlugin: ChannelPlugin = {
    ...scopedPlugin,
    id: "scopex-unavailable",
    outbound: undefined,
  };
  const scopedCfg = {
    channels: {
      scopex: { enabled: true },
      "scopex-unavailable": { enabled: true },
    },
  } as unknown as OpenClawConfig;

  it("limits broadcast candidates and secret access to the registry scope", async () => {
    const plan = await withPluginRuntimeRegistryScope(
      { channels: [{ plugin: scopedPlugin }, { plugin: unavailablePlugin }] } as never,
      () => resolveMessageBroadcastAccountPlan({ cfg: scopedCfg, accountId: "ops" }),
    );
    expect(plan).toMatchObject({ candidateChannels: ["scopex"], secretChannels: ["scopex"] });
    const outside = await resolveMessageBroadcastAccountPlan({ cfg: scopedCfg, accountId: "ops" });
    expect(outside?.candidateChannels).not.toContain("scopex");
    expect(outside?.secretChannels).toEqual([]);
  });
});
