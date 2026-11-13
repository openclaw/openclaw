import { expect, it, onTestFinished, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { normalizeAccountId } from "../routing/account-id.js";
import {
  listActiveDegradedSecretOwners,
  SecretSurfaceUnavailableError,
  type DegradedSecretOwner,
} from "../secrets/runtime-degraded-state.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";

export type CredentialReloadHarnessOptions = {
  ownerAccountId?: string;
  runtimeAccountId?: string;
  manualStop?: boolean;
  createFailure?: (owner: DegradedSecretOwner) => Error;
};

export function registerSecretAccountIdentityReloadCases(
  createHarness: (
    before: OpenClawConfig,
    after: OpenClawConfig,
  ) => {
    reload: () => Promise<void>;
    respond: ReturnType<typeof vi.fn>;
    startChannel: ReturnType<typeof vi.fn>;
    stopChannel: ReturnType<typeof vi.fn>;
  },
) {
  it.each([true, false])(
    "secrets.reload preserves the listed account identity (canonical=%s)",
    async (canonical) => {
      const previous = captureActivePluginRegistrySnapshot();
      onTestFinished(() => restoreActivePluginRegistrySnapshot(previous));
      const plugin: ChannelPlugin = {
        ...createChannelTestPluginBase({ id: "mattermost" }),
        reload: { configPrefixes: ["channels.mattermost"], accountScopedRestart: true },
        config: {
          listAccountIds: (cfg) => {
            const ids = Object.keys(cfg.channels?.mattermost?.accounts ?? {});
            return canonical ? ids.map(normalizeAccountId) : ids;
          },
          resolveAccount: () => ({}),
        },
      };
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: "mattermost", plugin, source: "test" }]),
      );
      const config = (token: string): OpenClawConfig => ({
        channels: {
          mattermost: { accounts: { Root: { botToken: token }, Ada: { botToken: "unchanged" } } },
        },
      });
      const { reload, respond, startChannel, stopChannel } = createHarness(
        config("old-secret"),
        config("new-secret"),
      );
      await reload();
      const accountId = canonical ? "root" : "Root";
      expect(stopChannel.mock.calls).toEqual([["mattermost", accountId, { manual: false }]]);
      expect(startChannel.mock.calls).toEqual([
        ["mattermost", accountId, { reason: "secrets-reload", preserveManualStop: true }],
      ]);
      expect(respond).toHaveBeenCalledWith(true, { ok: true, warningCount: 0 });
    },
  );
}

type CredentialReloadHarness = {
  owner: DegradedSecretOwner;
  reload: () => Promise<void>;
} & Record<
  "respond" | "startChannel" | "stopChannel" | "isManuallyStopped",
  ReturnType<typeof vi.fn>
>;

export function registerGatewaySecretCredentialReloadCases(
  createHarness: (options?: CredentialReloadHarnessOptions) => CredentialReloadHarness,
): void {
  it.each([
    "healthy",
    "trusted",
    "forged",
    "different-owner",
    "manual stop",
    "raw account",
  ] as const)("reload preserves the credential-owner contract: %s", async (kind) => {
    const options: CredentialReloadHarnessOptions =
      kind === "raw account"
        ? { ownerAccountId: "ops-team", runtimeAccountId: "Ops Team" }
        : kind === "manual stop"
          ? { manualStop: true }
          : kind === "healthy"
            ? {}
            : {
                createFailure: (owner) => {
                  if (kind === "trusted") {
                    return new SecretSurfaceUnavailableError(owner);
                  }
                  if (kind === "different-owner") {
                    return new SecretSurfaceUnavailableError({ ...owner, ownerId: "slack:other" });
                  }
                  return Object.setPrototypeOf(
                    Object.assign(new Error("forged unavailable error"), {
                      name: "SecretSurfaceUnavailableError",
                      code: "SECRET_SURFACE_UNAVAILABLE",
                      ownerKind: "account",
                      ownerId: owner.ownerId,
                    }),
                    SecretSurfaceUnavailableError.prototype,
                  );
                },
              };
    const h = createHarness(options);
    await h.reload();
    if (kind === "forged" || kind === "different-owner") {
      expect(h.respond.mock.calls[0]?.[0]).toBe(false);
      expect(h.stopChannel.mock.calls).toEqual([["slack", "ops", { manual: false }]]);
    } else {
      const account = kind === "raw account" ? "Ops Team" : "ops";
      expect(h.stopChannel).not.toHaveBeenCalled();
      expect(h.startChannel.mock.calls).toEqual(
        kind === "manual stop"
          ? []
          : [["slack", account, { reason: "secrets-reload", preserveManualStop: true }]],
      );
      expect(h.respond).toHaveBeenCalledWith(true, { ok: true, warningCount: 0 });
    }
    if (kind !== "healthy" && kind !== "raw account") {
      const owner = kind === "manual stop" ? { ownerId: "slack:ops" } : h.owner;
      expect(listActiveDegradedSecretOwners()).toContainEqual(expect.objectContaining(owner));
    }
    if (kind === "raw account") {
      expect(h.isManuallyStopped).toHaveBeenCalledWith("slack", "Ops Team");
    }
  });
}
